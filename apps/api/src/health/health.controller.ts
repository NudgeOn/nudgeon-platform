import { Controller, Get, HttpException, HttpStatus, Inject } from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type Redis from "ioredis";
import type { Pool } from "pg";
import type { AppConfig } from "../config";
import { decryptEnvelope, encryptEnvelope, loadMasterKey } from "../crypto/envelope";
import { CLICKHOUSE, CONFIG, PG, REDIS } from "../infra/infra.module";

const REQUIRED_POSTGRES_RELATIONS = [
  "public.tenants",
  "public.members",
  "public.member_backup_codes",
  "public.sessions",
  "public.apps",
  "public.api_keys",
  "public.credentials",
  "public.users",
  "public.devices",
  "public.attribute_registry",
  "public.email_templates",
  "public.segments",
  "public.journeys",
  "public.journey_versions",
  "public.journey_states",
  "public.journey_node_executions",
  "public.journey_outbox",
  "public.event_customer_cursors",
  "public.event_receipts",
  "public.user_merges",
  "public.audit_logs",
  "public.tenant_purges",
  "public.send_dlq",
] as const;

const REQUIRED_POSTGRES_COLUMNS = [
  ["tenants", "require_2fa"],
  ["journey_states", "claim_token"],
  ["journey_states", "entry_id"],
  ["journey_states", "entry_seq"],
] as const;

const REQUIRED_CHANNEL_KINDS = ["push_fcm", "push_apns", "email_smtp", "email_nhn", "email_resend"] as const;

const REQUIRED_CLICKHOUSE_TABLES = [
  "raw_ingestions",
  "events",
  "attr_changes",
  "ingestion_errors",
  "message_log",
  "profiles_mirror",
  "campaign_audiences",
  "usage_sends_daily",
  "usage_active_users_daily",
  "user_merges",
  "app_uninstalls",
  "message_lifecycle",
] as const;

type ComponentCode =
  | "dependency_unavailable"
  | "schema_missing"
  | "self_test_failed"
  | "timeout"
  | "unavailable";

type ComponentStatus =
  | { status: "ready" }
  | { status: "blocked"; code: "dependency_unavailable" }
  | { status: "not_ready"; code: Exclude<ComponentCode, "dependency_unavailable"> };

interface ProbeResult {
  ok: boolean;
  code?: Exclude<ComponentCode, "dependency_unavailable">;
}

interface ReadinessResponse {
  ok: boolean;
  /** Backwards-compatible booleans retained for existing health consumers. */
  postgres: boolean;
  redis: boolean;
  clickhouse: boolean;
  schema: boolean;
  master_key: boolean;
  components: {
    postgres: ComponentStatus;
    redis: ComponentStatus;
    clickhouse: ComponentStatus;
    postgres_schema: ComponentStatus;
    clickhouse_schema: ComponentStatus;
    master_key: ComponentStatus;
  };
}

class ReadinessTimeoutError extends Error {}

const ready = (): ComponentStatus => ({ status: "ready" });
const blocked = (): ComponentStatus => ({ status: "blocked", code: "dependency_unavailable" });
const notReady = (code: Exclude<ComponentCode, "dependency_unavailable">): ComponentStatus => ({
  status: "not_ready",
  code,
});

@Controller()
export class HealthController {
  private readonly timeoutMs: number;

  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLICKHOUSE) private readonly clickhouse: ClickHouseClient,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.timeoutMs = config.readinessTimeoutMs;
  }

  /** Liveness only: no downstream dependency checks. */
  @Get("livez")
  livez() {
    return { ok: true };
  }

  /** Compatibility alias for deployments that still probe /healthz. */
  @Get("healthz")
  healthz() {
    return this.livez();
  }

  /**
   * Full API readiness. Error details are deliberately reduced to fixed codes:
   * dependency URLs, credentials, SQL errors and key material never enter the response.
   */
  @Get("readyz")
  async readyz(): Promise<ReadinessResponse> {
    // Every phase shares one deadline so the endpoint never consumes N times the
    // configured timeout as checks become more comprehensive.
    const deadline = Date.now() + this.timeoutMs;
    const clickhousePingAbort = new AbortController();
    const [postgres, redis, clickhouse] = await Promise.all([
      this.probe(() => this.pg.query("SELECT 1"), () => true, "unavailable", deadline),
      this.probe(() => this.redis.ping(), (result) => result === "PONG", "unavailable", deadline),
      this.probe(
        () => this.clickhouse.ping({ select: false, abort_signal: clickhousePingAbort.signal }),
        (result) => result.success === true,
        "unavailable",
        deadline,
        () => clickhousePingAbort.abort(),
      ),
    ]);

    const [postgresSchema, clickhouseSchema] = await Promise.all([
      postgres.ok ? this.checkPostgresSchema(deadline) : Promise.resolve<ProbeResult>({ ok: false }),
      clickhouse.ok ? this.checkClickHouseSchema(deadline) : Promise.resolve<ProbeResult>({ ok: false }),
    ]);

    // When PostgreSQL and its credential table are available, also prove that the
    // configured key can decrypt persisted data. Empty installs use an in-memory
    // authenticated-encryption round trip until their first credential is stored.
    const masterKey = await this.checkMasterKey(postgres.ok && postgresSchema.ok, deadline);
    const schemaOk = postgresSchema.ok && clickhouseSchema.ok;
    const response: ReadinessResponse = {
      ok: postgres.ok && redis.ok && clickhouse.ok && schemaOk && masterKey.ok,
      postgres: postgres.ok,
      redis: redis.ok,
      clickhouse: clickhouse.ok,
      schema: schemaOk,
      master_key: masterKey.ok,
      components: {
        postgres: postgres.ok ? ready() : notReady(postgres.code ?? "unavailable"),
        redis: redis.ok ? ready() : notReady(redis.code ?? "unavailable"),
        clickhouse: clickhouse.ok ? ready() : notReady(clickhouse.code ?? "unavailable"),
        postgres_schema: !postgres.ok
          ? blocked()
          : postgresSchema.ok
            ? ready()
            : notReady(postgresSchema.code ?? "schema_missing"),
        clickhouse_schema: !clickhouse.ok
          ? blocked()
          : clickhouseSchema.ok
            ? ready()
            : notReady(clickhouseSchema.code ?? "schema_missing"),
        master_key: masterKey.ok ? ready() : notReady(masterKey.code ?? "self_test_failed"),
      },
    };

    if (!response.ok) throw new HttpException(response, HttpStatus.SERVICE_UNAVAILABLE);
    return response;
  }

  private checkPostgresSchema(deadline: number): Promise<ProbeResult> {
    return this.probe(
      () =>
        Promise.all([
          this.pg.query<{ present: number }>(
            `SELECT count(*)::int AS present
               FROM unnest($1::text[]) AS required(name)
              WHERE to_regclass(required.name) IS NOT NULL`,
            [[...REQUIRED_POSTGRES_RELATIONS]],
          ),
          this.pg.query<{ present: number }>(
            `SELECT count(*)::int AS present
               FROM (VALUES ('tenants', 'require_2fa'),
                            ('journey_states', 'claim_token'),
                            ('journey_states', 'entry_id'),
                            ('journey_states', 'entry_seq')) AS required(table_name, column_name)
               JOIN information_schema.columns actual
                 ON actual.table_schema = 'public'
                AND actual.table_name = required.table_name
                AND actual.column_name = required.column_name`,
          ),
          this.pg.query<{ present: number }>(
            `SELECT count(*)::int AS present
               FROM pg_type type
               JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
               JOIN pg_enum value ON value.enumtypid = type.oid
              WHERE namespace.nspname = 'public'
                AND type.typname = 'channel_kind'
                AND value.enumlabel = ANY($1::text[])`,
            [[...REQUIRED_CHANNEL_KINDS]],
          ),
        ]),
      ([relations, columns, channelKinds]) =>
        Number(relations.rows[0]?.present ?? 0) === REQUIRED_POSTGRES_RELATIONS.length &&
        Number(columns.rows[0]?.present ?? 0) === REQUIRED_POSTGRES_COLUMNS.length &&
        Number(channelKinds.rows[0]?.present ?? 0) === REQUIRED_CHANNEL_KINDS.length,
      "schema_missing",
      deadline,
    );
  }

  private checkClickHouseSchema(deadline: number): Promise<ProbeResult> {
    const abort = new AbortController();
    return this.probe(
      async () => {
        const [tableResult, columnResult] = await Promise.all([
          this.clickhouse.query({
            query: `SELECT count() AS present
                      FROM system.tables
                     WHERE database = currentDatabase()
                       AND name IN {required_tables:Array(String)}`,
            query_params: { required_tables: [...REQUIRED_CLICKHOUSE_TABLES] },
            format: "JSONEachRow",
            abort_signal: abort.signal,
          }),
          this.clickhouse.query({
            query: `SELECT count() AS present
                      FROM system.columns
                     WHERE database = currentDatabase()
                       AND table = 'message_log'
                       AND name = 'provider_message_id'`,
            format: "JSONEachRow",
            abort_signal: abort.signal,
          }),
        ]);
        return {
          tables: (await tableResult.json()) as Array<{ present: string }>,
          providerMessageId: (await columnResult.json()) as Array<{ present: string }>,
        };
      },
      (result) =>
        Number(result.tables[0]?.present ?? 0) === REQUIRED_CLICKHOUSE_TABLES.length &&
        Number(result.providerMessageId[0]?.present ?? 0) === 1,
      "schema_missing",
      deadline,
      () => abort.abort(),
    );
  }

  private checkMasterKey(checkPersistedCredential: boolean, deadline: number): Promise<ProbeResult> {
    return this.probe(
      async () => {
        const key = loadMasterKey();
        const marker = "nudgeon-readiness-self-test-v1";
        const envelope = encryptEnvelope(key, marker);
        if (decryptEnvelope(key, envelope) !== marker) return false;

        if (!checkPersistedCredential) return true;
        const result = await this.pg.query<{ ciphertext: Buffer; dek_wrapped: Buffer }>(
          `SELECT ciphertext, dek_wrapped
             FROM credentials
            ORDER BY created_at ASC
            LIMIT 1`,
        );
        const stored = result.rows[0];
        if (!stored) return true;
        if (!Buffer.isBuffer(stored.ciphertext) || !Buffer.isBuffer(stored.dek_wrapped)) return false;
        decryptEnvelope(key, { ciphertext: stored.ciphertext, dekWrapped: stored.dek_wrapped });
        return true;
      },
      (result) => result,
      "self_test_failed",
      deadline,
    );
  }

  private async probe<T>(
    work: () => Promise<T>,
    isReady: (result: T) => boolean,
    failureCode: Exclude<ComponentCode, "dependency_unavailable" | "timeout">,
    deadline: number,
    onTimeout?: () => void,
  ): Promise<ProbeResult> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { ok: false, code: "timeout" };

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      const result = await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            onTimeout?.();
            reject(new ReadinessTimeoutError());
          }, remainingMs);
        }),
      ]);
      return isReady(result) ? { ok: true } : { ok: false, code: failureCode };
    } catch (error) {
      return {
        ok: false,
        code: timedOut || error instanceof ReadinessTimeoutError ? "timeout" : failureCode,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
