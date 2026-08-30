import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import {
  envelopeSchema,
  payloadSchemas,
  type Envelope,
  type MessageType,
  type StreamKey,
} from "@onda/queue-schemas";

/**
 * Redis Streams 접근의 유일한 경로 (ADR-1, CLAUDE.md 규칙 2).
 * ioredis 인스턴스가 이 인터페이스를 그대로 만족한다 — libqueue는 클라이언트 구현에
 * 의존하지 않고, 호출자가 연결을 소유한다 (Kafka 이관 시 이 파일만 교체).
 */
export interface RedisStreamsClient {
  xadd(key: string, ...args: Array<string | number>): Promise<string | null>;
}

export class EnvelopeValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: unknown[],
  ) {
    super(message);
    this.name = "EnvelopeValidationError";
  }
}

export interface PublishInput<P> {
  type: MessageType;
  tenantId: string;
  appId: string;
  payload: P;
  /** 미지정 시 신규 발급 — 요청 경계에서 넘겨 전 구간 전파한다 (관찰성, DEV-sub-08) */
  traceId?: string;
  schemaVer?: number;
  occurredAt?: Date;
}

/** envelope 필드명. XADD field-value 쌍의 field로 사용. */
const FIELD = "envelope";

export class QueueProducer {
  private readonly validateEnvelope: ValidateFunction;
  private readonly validatePayload: Map<MessageType, ValidateFunction>;

  constructor(
    private readonly redis: RedisStreamsClient,
    private readonly opts: {
      /** 스트림 길이 상한 (XADD MAXLEN ~). 기본 1,000,000 — 배압은 소비 측 계측으로 관리 */
      maxLen?: number;
      now?: () => Date;
    } = {},
  ) {
    // 스키마는 draft 2020-12 (queue-schemas $schema 선언과 일치)
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    this.validateEnvelope = ajv.compile(envelopeSchema);
    this.validatePayload = new Map();
    for (const [type, schema] of Object.entries(payloadSchemas)) {
      if (schema) this.validatePayload.set(type as MessageType, ajv.compile(schema));
    }
  }

  /**
   * envelope을 구성·검증하고 스트림에 XADD한다.
   * @returns 발행된 메시지의 envelope (id 포함)
   */
  async publish<P extends Record<string, unknown>>(
    stream: StreamKey,
    input: PublishInput<P>,
  ): Promise<Envelope<P>> {
    const now = this.opts.now?.() ?? new Date();
    const envelope: Envelope<P> = {
      id: randomUUID(),
      type: input.type,
      schema_ver: input.schemaVer ?? 1,
      tenant_id: input.tenantId,
      app_id: input.appId,
      occurred_at: (input.occurredAt ?? now).toISOString(),
      trace_id: input.traceId ?? randomUUID(),
      payload: input.payload,
    };

    if (!this.validateEnvelope(envelope)) {
      throw new EnvelopeValidationError(
        `envelope 검증 실패 (${input.type})`,
        this.validateEnvelope.errors ?? [],
      );
    }
    const validate = this.validatePayload.get(input.type);
    if (validate && !validate(envelope.payload)) {
      throw new EnvelopeValidationError(
        `payload 검증 실패 (${input.type})`,
        validate.errors ?? [],
      );
    }

    const maxLen = this.opts.maxLen ?? 1_000_000;
    await this.redis.xadd(
      stream,
      "MAXLEN",
      "~",
      maxLen,
      "*",
      FIELD,
      JSON.stringify(envelope),
    );
    return envelope;
  }
}
