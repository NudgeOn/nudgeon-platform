import type { Pool, PoolClient } from "pg";
import { STREAMS, type IngestBatchPayload } from "@nudgeon/queue-schemas";
import type { ResolvedApiKey } from "../auth/api-key.service";
import type { TrackBody } from "./schemas";

type TrackEvent = TrackBody["batch"][number];
type UserRow = { id: string; status: string; merged_into: string | null };
class IdentityChanged extends Error {}

/**
 * A successful track response means the complete batch and its projection jobs
 * have committed in PG. Redis/ClickHouse availability cannot lose an accepted
 * event. Retries keep the FIRST receipt, including its customer, time and order.
 */
export async function persistTrackReceipts(
  pg: Pool,
  key: Pick<ResolvedApiKey, "tenantId" | "appId" | "id">,
  body: TrackBody,
  requestId: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await persistOnce(pg, key, body, requestId);
      return;
    } catch (error) {
      const code = error != null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (attempt >= 2 || !(error instanceof IdentityChanged || code === "40P01" || code === "40001")) {
        throw error;
      }
    }
  }
}

async function persistOnce(
  pg: Pool,
  key: Pick<ResolvedApiKey, "tenantId" | "appId" | "id">,
  body: TrackBody,
  requestId: string,
) {
  const client = await pg.connect();
  try {
    await client.query("BEGIN");
    // Preserve the first item in a batch, even if a duplicate changes identity
    // or properties. Sorted event locks also serialize conflicting identities
    // submitted concurrently with the same insert_id.
    const unique = new Map<string, TrackEvent>();
    for (const event of body.batch) {
      const insertId = event.insert_id.toLowerCase();
      if (!unique.has(insertId)) unique.set(insertId, { ...event, insert_id: insertId });
    }
    for (const insertId of [...unique.keys()].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `event.receipt:${key.tenantId}:${key.appId}:${insertId}`,
      ]);
    }
    const existing = await client.query<{ insert_id: string }>(
      `SELECT insert_id FROM event_receipts
        WHERE tenant_id = $1 AND app_id = $2 AND insert_id = ANY($3::uuid[])`,
      [key.tenantId, key.appId, [...unique.keys()]],
    );
    for (const row of existing.rows) unique.delete(row.insert_id);
    if (unique.size === 0) {
      await client.query("COMMIT");
      return;
    }

    const identities = new Map<string, string>();
    for (const event of [...unique.values()].sort((a, b) => identityKey(a).localeCompare(identityKey(b)))) {
      const identity = identityKey(event);
      if (!identities.has(identity)) {
        identities.set(identity, await resolveUser(client, key.tenantId, key.appId, event));
      }
    }

    // Shared lock order with wait registration, matching, timeout and deletion:
    // customer cursor -> current profile/state. Existing-user lookup above does
    // not take a row lock; a concurrent merge is checked again below.
    const users = [...new Set(identities.values())].sort();
    for (const userId of users) {
      await client.query(
        `INSERT INTO event_customer_cursors (tenant_id, app_id, user_id, last_seq)
         VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`, [key.tenantId, key.appId, userId],
      );
      await client.query(
        `SELECT last_seq FROM event_customer_cursors
          WHERE tenant_id = $1 AND app_id = $2 AND user_id = $3 FOR UPDATE`,
        [key.tenantId, key.appId, userId],
      );
    }
    const profiles = await client.query<UserRow>(
      `SELECT id, status, merged_into FROM users
        WHERE tenant_id = $1 AND app_id = $2 AND id = ANY($3::uuid[]) ORDER BY id FOR UPDATE`,
      [key.tenantId, key.appId, users],
    );
    if (profiles.rows.length !== users.length || profiles.rows.some((user) => user.status !== "active")) {
      throw new IdentityChanged("Customer changed during receipt registration");
    }

    for (const event of unique.values()) {
      const userId = identities.get(identityKey(event))!;
      // clock_timestamp(), after acquiring the cursor lock, is the authoritative
      // receipt time. Return text to retain PG microseconds across JS/JSON.
      const ordered = await client.query<{ receipt_seq: string; received_at: string }>(
        `UPDATE event_customer_cursors
            SET last_seq = last_seq + 1, updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND app_id = $2 AND user_id = $3
          RETURNING last_seq::text AS receipt_seq,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_at`,
        [key.tenantId, key.appId, userId],
      );
      const receipt = ordered.rows[0];
      if (!receipt) throw new Error("Missing event customer cursor");
      const properties = event.properties ?? {};
      await client.query(
        `INSERT INTO event_receipts
          (tenant_id, app_id, insert_id, user_id, event_name, properties, client_ts, received_at, receipt_seq, device)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::bigint, $10::jsonb)`,
        [key.tenantId, key.appId, event.insert_id, userId, event.event, JSON.stringify(properties),
          event.client_ts, receipt.received_at, receipt.receipt_seq, body.device ? JSON.stringify(body.device) : null],
      );
      const payload: IngestBatchPayload = {
        endpoint: "track", request_id: requestId, api_key_id: key.id,
        ...(body.device ? { device: body.device } : {}),
        events: [{ insert_id: event.insert_id, user_id: userId, event: event.event, properties,
          client_ts: event.client_ts, server_ts: receipt.received_at, received_at: receipt.received_at,
          receipt_seq: receipt.receipt_seq }],
      };
      await client.query(
        `INSERT INTO journey_outbox (tenant_id, app_id, stream, idempotency_key, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING`,
        [key.tenantId, key.appId, STREAMS.ingest, `event.ingest:${event.insert_id}`, JSON.stringify(payload)],
      );
      await client.query(
        `UPDATE users SET last_seen_at = GREATEST(last_seen_at, $4::timestamptz), updated_at = $4
          WHERE tenant_id = $1 AND app_id = $2 AND id = $3`,
        [key.tenantId, key.appId, userId, receipt.received_at],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function identityKey(event: TrackEvent) {
  return event.external_id ? `external:${event.external_id}` : `anon:${event.anon_id}`;
}

/** Same identity precedence as ingest.resolveOrCreateUser: external, then anon;
 * merged tombstones redirect to their canonical customer. No implicit identify.
 */
async function resolveUser(client: PoolClient, tenantId: string, appId: string, event: TrackEvent) {
  const column = event.external_id ? "external_id" : "anon_id";
  const value = event.external_id || event.anon_id;
  if (!value) throw new Error("Missing track identity");
  const lookup = () => client.query<UserRow>(
    `SELECT id, status, merged_into FROM users
      WHERE tenant_id = $1 AND app_id = $2 AND ${column} = $3`, [tenantId, appId, value],
  );
  let user = (await lookup()).rows[0];
  if (!user) {
    await client.query(
      `INSERT INTO users (tenant_id, app_id, ${column}) VALUES ($1, $2, $3)
       ON CONFLICT (app_id, ${column}) DO NOTHING`, [tenantId, appId, value],
    );
    user = (await lookup()).rows[0];
  }
  const visited = new Set<string>();
  while (user?.status === "merged" && user.merged_into && !visited.has(user.id)) {
    visited.add(user.id);
    user = (await client.query<UserRow>(
      `SELECT id, status, merged_into FROM users WHERE tenant_id = $1 AND app_id = $2 AND id = $3`,
      [tenantId, appId, user.merged_into],
    )).rows[0];
  }
  if (!user || user.status !== "active") throw new IdentityChanged("Track identity is no longer active");
  return user.id;
}
