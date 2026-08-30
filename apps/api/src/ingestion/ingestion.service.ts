import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import { QueueProducer } from "@onda/libqueue";
import { STREAMS, type IngestBatchPayload } from "@onda/queue-schemas";
import { CLICKHOUSE, QUEUE } from "../infra/infra.module";
import type { ResolvedApiKey } from "../auth/api-key.service";
import type { TrackBody } from "./schemas";

/**
 * Ingestion 처리 (DEV-sub-01 §2):
 * raw_ingestions async insert(응답 비대기) → ingest 스트림 XADD → 202.
 * PG upsert·CH events insert는 ingest-consumer(Go)의 몫.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient,
    @Inject(QUEUE) private readonly queue: QueueProducer,
  ) {}

  async track(key: ResolvedApiKey, body: TrackBody, rawBody: unknown) {
    const requestId = randomUUID();
    const serverTs = new Date().toISOString();

    // 1) 원본 보존 (감사·replay의 안전망) — 실패해도 수집은 계속한다
    this.insertRaw(key, "track", rawBody, requestId);

    // 2) 정규화 payload를 ingest 스트림으로
    const payload: IngestBatchPayload = {
      endpoint: "track",
      request_id: requestId,
      api_key_id: key.id,
      device: body.device,
      events: body.batch.map((e) => ({
        insert_id: e.insert_id,
        anon_id: e.anon_id ?? null,
        external_id: e.external_id ?? null,
        event: e.event,
        properties: e.properties ?? {},
        client_ts: e.client_ts,
        server_ts: serverTs,
      })),
    };
    await this.queue.publish(STREAMS.ingest, {
      type: "ingest.batch",
      tenantId: key.tenantId,
      appId: key.appId,
      payload: payload as unknown as Record<string, unknown>,
    });

    return { accepted: body.batch.length, request_id: requestId };
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
