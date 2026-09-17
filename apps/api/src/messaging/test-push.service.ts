import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { STREAMS, type SendPushPayload } from "@nudgeon/queue-schemas";
import { PG } from "../infra/infra.module";

export interface TestPushInput { external_id: string; title: string; body: string; device_id?: string }
export interface TestPushMessage { message_id: string; device_id: string; platform: string }
export interface TestPushRun { id: string; messages: TestPushMessage[]; accepted_at: Date; request_hash: string }

@Injectable()
export class TestPushService {
  constructor(@Inject(PG) private readonly pg: Pool) {}

  async accept(tenantId: string, appId: string, requestKey: string, input: TestPushInput) {
    // Fixed property order; locale-specific copy is snapshotted by the caller for retries.
    const hash = createHash("sha256").update(JSON.stringify({
      external_id: input.external_id, device_id: input.device_id ?? null, title: input.title, body: input.body,
    })).digest("hex");
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      // Serializes identical request keys without preventing independent tests.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`test-push:${tenantId}:${appId}:${requestKey}`]);
      const previous = await client.query<TestPushRun>(
        `SELECT id, messages, accepted_at, request_hash FROM test_push_runs
          WHERE tenant_id = $1 AND app_id = $2 AND request_key = $3`, [tenantId, appId, requestKey],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== hash) throw new ConflictException("Idempotency key already used for a different test");
        await client.query("COMMIT");
        return this.result(previous.rows[0]);
      }
      const { rows } = await client.query<{ device_id: string; user_id: string; push_token: string; platform: "ios" | "android" }>(
        `SELECT d.id AS device_id, d.user_id, d.push_token, d.platform
           FROM devices d JOIN users u ON u.id = d.user_id
          WHERE d.tenant_id = $1 AND d.app_id = $2 AND u.tenant_id = $1 AND u.app_id = $2
            AND u.external_id = $3 AND u.status = 'active'
            AND d.push_token IS NOT NULL AND d.push_token <> '' AND d.token_status = 'active'
            AND d.os_permission = 'granted' AND ($4::uuid IS NULL OR d.id = $4)
            AND ($4::uuid IS NULL OR EXISTS (
              SELECT 1 FROM credentials c WHERE c.tenant_id = $1 AND c.app_id = $2 AND c.status = 'verified'
                AND c.kind::text = CASE WHEN d.platform = 'ios' THEN 'push_apns' ELSE 'push_fcm' END
            ))`, [tenantId, appId, input.external_id, input.device_id ?? null],
      );
      if (!rows.length) throw new BadRequestException("No eligible device: check token, notification permission and verified channel");
      const runId = randomUUID();
      const messages: TestPushMessage[] = [];
      const outboxIds: string[] = [];
      for (const device of rows) {
        const messageId = randomUUID();
        const payload: SendPushPayload = {
          idempotency_key: `test:${runId}:${device.device_id}`, message_id: messageId,
          user_id: device.user_id, device_id: device.device_id, push_token: device.push_token, platform: device.platform,
          content: { push: { title: input.title, body: input.body } }, category: "transactional", campaign_ref: `test:${runId}`,
        };
        const outbox = await client.query<{ id: string }>(
          `INSERT INTO journey_outbox (tenant_id, app_id, stream, idempotency_key, payload)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`, [tenantId, appId, STREAMS.sendPush, payload.idempotency_key, payload],
        );
        outboxIds.push(outbox.rows[0]!.id);
        messages.push({ message_id: messageId, device_id: device.device_id, platform: device.platform });
      }
      const saved = await client.query<TestPushRun>(
        `INSERT INTO test_push_runs (id, tenant_id, app_id, request_key, request_hash, messages, outbox_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, messages, accepted_at, request_hash`,
        [runId, tenantId, appId, requestKey, hash, JSON.stringify(messages), outboxIds],
      );
      await client.query("COMMIT");
      return this.result(saved.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private result(run: TestPushRun) {
    return { test_run_id: run.id, state: "accepted" as const, accepted_at: run.accepted_at,
      // Compatibility count: jobs durably accepted; Redis publication and delivery are separate evidence.
      queued: run.messages.length, messages: run.messages };
  }
}
