import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { QueueProducer } from "@nudgeon/libqueue";
import { STREAMS, type IngestBatchPayload } from "@nudgeon/queue-schemas";
import { CLICKHOUSE, PG, QUEUE } from "../infra/infra.module";
import type { ResolvedApiKey } from "../auth/api-key.service";
import type {
  AttributesBody,
  IdentifyBody,
  LogoutBody,
  SubscriptionBody,
  TokenBody,
  TrackBody,
} from "./schemas";
import { persistTrackReceipts } from "./event-receipts";

/**
 * Ingestion 처리 (DEV-sub-01 §2):
 * Track: PG receipt + outbox commit → 202. CH projection is asynchronous.
 * Other endpoints retain their existing ingest-stream contract.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient,
    @Inject(QUEUE) private readonly queue: QueueProducer,
    @Inject(PG) private readonly pg: Pool,
  ) {}

  async track(key: ResolvedApiKey, body: TrackBody, rawBody: unknown) {
    const requestId = randomUUID();
    try {
      await persistTrackReceipts(this.pg, key, body, requestId);
    } catch {
      this.logger.error("track receipt/outbox transaction failed; batch was not acknowledged");
      throw new ServiceUnavailableException("이벤트를 저장하지 못했습니다. 동일 insert_id로 다시 시도해 주세요.");
    }
    this.insertRaw(key, "track", rawBody, requestId);

    return { accepted: body.batch.length, request_id: requestId };
  }

  async identify(key: ResolvedApiKey, body: IdentifyBody, rawBody: unknown) {
    const requestId = randomUUID();
    this.insertRaw(key, "identify", rawBody, requestId);
    const payload: IngestBatchPayload = {
      endpoint: "identify",
      request_id: requestId,
      api_key_id: key.id,
      device: body.device,
      identify: {
        external_id: body.external_id,
        anon_id: body.anon_id ?? null,
        attributes: body.attributes,
      },
    };
    await this.publish(key, payload);
    return { request_id: requestId };
  }

  async attributes(key: ResolvedApiKey, body: AttributesBody, rawBody: unknown) {
    const requestId = randomUUID();
    this.insertRaw(key, "attributes", rawBody, requestId);
    const payload: IngestBatchPayload = {
      endpoint: "attributes",
      request_id: requestId,
      api_key_id: key.id,
      attributes: body.updates,
    };
    await this.publish(key, payload);
    return { accepted: body.updates.length, request_id: requestId };
  }

  async deviceToken(key: ResolvedApiKey, body: TokenBody, rawBody: unknown) {
    const requestId = randomUUID();
    this.insertRaw(key, "devices_token", rawBody, requestId);
    const payload: IngestBatchPayload = {
      endpoint: "devices_token",
      request_id: requestId,
      api_key_id: key.id,
      device: body.device,
      token: {
        push_token: body.push_token,
        os_permission: body.os_permission,
        anon_id: body.anon_id ?? null,
        external_id: body.external_id ?? null,
      },
    };
    await this.publish(key, payload);
    return { request_id: requestId };
  }

  async subscriptions(key: ResolvedApiKey, body: SubscriptionBody, rawBody: unknown) {
    const requestId = randomUUID();
    this.insertRaw(key, "subscriptions", rawBody, requestId);
    const payload: IngestBatchPayload = {
      endpoint: "subscriptions",
      request_id: requestId,
      api_key_id: key.id,
      subscription: {
        channel: body.channel,
        state: body.state,
        anon_id: body.anon_id ?? null,
        external_id: body.external_id ?? null,
      },
    };
    await this.publish(key, payload);
    return { request_id: requestId };
  }

  async deviceLogout(key: ResolvedApiKey, body: LogoutBody, rawBody: unknown) {
    const requestId = randomUUID();
    this.insertRaw(key, "devices_logout", rawBody, requestId);
    const payload: IngestBatchPayload = {
      endpoint: "devices_logout",
      request_id: requestId,
      api_key_id: key.id,
      logout: { device_id: body.device_id },
    };
    await this.publish(key, payload);
    return { request_id: requestId };
  }

  async userDelete(key: ResolvedApiKey, externalId: string) {
    const requestId = randomUUID();
    this.insertRaw(key, "user_delete", { external_id: externalId }, requestId);
    const payload: IngestBatchPayload = {
      endpoint: "user_delete",
      request_id: requestId,
      api_key_id: key.id,
      user_delete: { external_id: externalId },
    };
    await this.publish(key, payload);
    return { request_id: requestId };
  }

  private async publish(key: ResolvedApiKey, payload: IngestBatchPayload) {
    await this.queue.publish(STREAMS.ingest, {
      type: "ingest.batch",
      tenantId: key.tenantId,
      appId: key.appId,
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  private insertRaw(
    key: ResolvedApiKey,
    endpoint: string,
    rawBody: unknown,
    requestId: string,
  ) {
    void this.ch
      .insert({
        table: "raw_ingestions",
        values: [
          {
            tenant_id: key.tenantId,
            app_id: key.appId,
            endpoint,
            api_key_id: key.id,
            payload: JSON.stringify(rawBody),
            received_at: new Date().toISOString().replace("T", " ").replace("Z", ""),
            request_id: requestId,
          },
        ],
        format: "JSONEachRow",
      })
      .catch((err) => {
        // raw 적재 실패는 수집을 막지 않는다 — 관찰성 지표로만 노출
        this.logger.error(`raw_ingestions 적재 실패: ${err}`);
      });
  }
}
