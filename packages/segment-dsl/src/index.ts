/**
 * 세그먼트 DSL — 타입 + 컴파일러(TS). Go 컴파일러(apps/worker/internal/segment)와
 * golden/cases.json으로 동작 정합을 검증한다. 컴파일러의 버그 = 잘못된 대상 발송이므로
 * 화이트리스트를 절대 우회하지 않는다.
 */

export type LogicalOp = "AND" | "OR";
export type Category = "marketing" | "transactional";

export interface SegmentDSL {
  version: 1;
  operator: LogicalOp;
  groups: SegmentGroup[];
}
export interface SegmentGroup {
  operator: LogicalOp;
  conditions: Condition[];
}
export type Condition =
  | AttributeCondition
  | EventCondition
  | ChannelCondition
  | DeviceCondition;

export interface AttributeCondition {
  type: "attribute";
  key: string;
  op:
    | "eq"
    | "neq"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "in"
    | "exists"
    | "not_exists"
    | "contains"
    | "before"
    | "after"
    | "in_last_days"
    | "not_in_last_days";
  value?: unknown;
}
export interface EventCondition {
  type: "event";
  event: string;
  op:
    | "count_gte"
    | "count_lte"
    | "performed"
    | "not_performed"
    | "first_performed"
    | "last_performed";
  value?: unknown;
  window_days?: number;
}
export interface ChannelCondition {
  type: "channel";
  op: "push_reachable" | "token_platform_in";
  value?: unknown;
}
export interface DeviceCondition {
  type: "device";
  key: "app_version" | "os_version";
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  value?: unknown;
}

export interface Compiled {
  sql: string;
  args: unknown[];
}

export interface ClickHouseQuery {
  query: string;
  query_params: Record<string, unknown>;
}

/**
 * `?` 위치 인자 SQL → ClickHouse named-param SQL(`{pN:Type}`).
 * clickhouse-js는 named param만 지원하므로 실행 직전 변환한다. 값은 여전히
 * 파라미터로만 전달되어 인젝션 안전. 타입은 JS 값에서 추론(String/Int64/Float64).
 */
export function toClickHouse(compiled: Compiled): ClickHouseQuery {
  const query_params: Record<string, unknown> = {};
  let i = 0;
  const query = compiled.sql.replace(/\?/g, () => {
    const value = compiled.args[i];
    const type =
      typeof value === "number"
        ? Number.isInteger(value)
          ? "Int64"
          : "Float64"
        : "String";
    const name = `p${i}`;
    query_params[name] = value;
    i += 1;
    return `{${name}:${type}}`;
  });
  if (i !== compiled.args.length) {
    throw new CompileError(`플레이스홀더 수(${i})와 인자 수(${compiled.args.length}) 불일치`);
  }
  return { query, query_params };
}

export class CompileError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CompileError";
  }
}

const STD_ATTR_KEYS = new Set([
  "external_id",
  "first_name",
  "last_name",
  "email",
  "phone",
  "language",
  "country",
  "timezone",
  "created_at",
  "last_seen_at",
]);
const CMP_OPS: Record<string, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};
const DEVICE_COLS = new Set(["app_version", "os_version"]);

class Params {
  readonly args: unknown[] = [];
  add(v: unknown): string {
    this.args.push(v);
    return "?";
  }
}

/**
 * DSL → CH SELECT(user_id 집합). tenant/app/status는 루트 강제 주입(우회 불가).
 * 값은 절대 SQL 문자열에 삽입하지 않고 ? 위치 인자로만 바인딩한다.
 */
export function compile(
  dsl: SegmentDSL,
  tenantId: string,
  appId: string,
  category: Category,
): Compiled {
  if (dsl.version !== 1) throw new CompileError(`지원하지 않는 DSL 버전: ${dsl.version}`);
  if (dsl.operator !== "AND" && dsl.operator !== "OR")
    throw new CompileError(`최상위 operator는 AND|OR: ${dsl.operator}`);

  const p = new Params();
  // UUID 컬럼은 toUUID(?)로 감싸 String 인자를 안전 캐스팅
  const where = [
    `tenant_id = toUUID(${p.add(tenantId)})`,
    `app_id = toUUID(${p.add(appId)})`,
    `status = 'active'`,
  ];

  if (dsl.groups.length > 0) {
    const groups = dsl.groups.map((g) => compileGroup(g, tenantId, appId, category, p));
    where.push(`(${groups.join(` ${dsl.operator} `)})`);
  }
  return {
    sql: `SELECT user_id FROM profiles_mirror FINAL WHERE ${where.join(" AND ")}`,
    args: p.args,
  };
}

function compileGroup(
  g: SegmentGroup,
  tenantId: string,
  appId: string,
  category: Category,
  p: Params,
): string {
  if (g.operator !== "AND" && g.operator !== "OR")
    throw new CompileError(`group operator는 AND|OR: ${g.operator}`);
  if (!g.conditions || g.conditions.length === 0) throw new CompileError("빈 group");
  const parts = g.conditions.map((c) => compileCondition(c, tenantId, appId, category, p));
  return `(${parts.join(` ${g.operator} `)})`;
}

function compileCondition(
  c: Condition,
  tenantId: string,
  appId: string,
  category: Category,
  p: Params,
): string {
  switch (c.type) {
    case "attribute":
      return compileAttribute(c, p);
    case "channel":
      return compileChannel(c, category);
    case "device":
      return compileDevice(c);
    case "event":
      return compileEvent(c, tenantId, appId, p);
    default:
      throw new CompileError(`알 수 없는 condition type`);
  }
}

function compileAttribute(c: AttributeCondition, p: Params): string {
  if (!c.key) throw new CompileError("attribute 조건에 key 없음");
  const col = STD_ATTR_KEYS.has(c.key) ? "std_attrs" : "custom_attrs";
  const extract = () => `JSONExtractString(${col}, ${p.add(c.key)})`;
  const extractRaw = () => `JSONExtractRaw(${col}, ${p.add(c.key)})`;

  switch (c.op) {
    case "exists":
      return `${extractRaw()} != ''`;
    case "not_exists":
      return `${extractRaw()} = ''`;
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const [v, isNum] = scalar(c.value);
      const op = CMP_OPS[c.op];
      return isNum
        ? `toFloat64OrNull(${extract()}) ${op} ${p.add(v)}`
        : `${extract()} ${op} ${p.add(v)}`;
    }
    case "in": {
      const vals = arrayValues(c.value);
      if (vals.length === 0) return "0";
      return `${extract()} IN (${vals.map((v) => p.add(v)).join(", ")})`;
    }
    case "contains": {
      const [v] = scalar(c.value);
      return `has(JSONExtract(${extractRaw()}, 'Array(String)'), ${p.add(v)})`;
    }
    case "in_last_days":
    case "not_in_last_days": {
      const days = intValue(c.value);
      const cmp = c.op === "not_in_last_days" ? "<" : ">=";
      return `parseDateTimeBestEffortOrNull(${extract()}) ${cmp} now() - INTERVAL ${p.add(days)} DAY`;
    }
    case "before":
    case "after": {
      const [v] = scalar(c.value);
      const cmp = c.op === "after" ? ">" : "<";
      return `parseDateTimeBestEffortOrNull(${extract()}) ${cmp} parseDateTimeBestEffortOrNull(${p.add(v)})`;
    }
    default:
      throw new CompileError(`attribute 연산자 화이트리스트 위반`);
  }
}

function compileChannel(c: ChannelCondition, category: Category): string {
  if (c.op === "push_reachable") {
    return category === "transactional"
      ? "(os_permission_granted = 1 AND token_active = 1)"
      : "(push_opt_in = 1 AND os_permission_granted = 1 AND token_active = 1)";
  }
  throw new CompileError(`channel 연산자 화이트리스트 위반: ${c.op}`);
}

function compileDevice(c: DeviceCondition): string {
  if (!DEVICE_COLS.has(c.key)) throw new CompileError(`device 컬럼 화이트리스트 위반: ${c.key}`);
  if (!(c.op in CMP_OPS)) throw new CompileError(`device 연산자 화이트리스트 위반: ${c.op}`);
  // fail-closed (재검증 B): device_meta는 아직 mirror에 없어 정밀 비교 불가.
  // 이전 구현은 "1"(전건 매치)을 반환해 조건 불일치 대상까지 포함시켰다. Go 컴파일러와 동일하게
  // 지원 전까지 거부해 잘못된 타기팅을 막는다.
  throw new CompileError(
    `device 조건 "${c.key}"는 아직 지원되지 않습니다 — 대상 오포함 방지를 위해 거부(재검증 B)`,
  );
}

function compileEvent(c: EventCondition, tenantId: string, appId: string, p: Params): string {
  if (!c.event) throw new CompileError("event 조건에 event 없음");
  const base = () => {
    const query = `SELECT user_id FROM events WHERE tenant_id = toUUID(${p.add(tenantId)}) AND app_id = toUUID(${p.add(appId)}) AND event_name = ${p.add(c.event)}`;
    // Bind in SQL order: tenant, app, event, then the optional window.
    return c.window_days != null
      ? `${query} AND server_ts >= now() - INTERVAL ${p.add(c.window_days)} DAY`
      : query;
  };

  switch (c.op) {
    case "performed":
      return `user_id IN (${base()} GROUP BY user_id)`;
    case "not_performed":
      return `user_id NOT IN (${base()} GROUP BY user_id)`;
    case "count_gte":
    case "count_lte": {
      const n = intValue(c.value);
      const cmp = c.op === "count_lte" ? "<=" : ">=";
      // insert_id 유일 집계 — ReplacingMergeTree 병합 전 중복 행이 카운트를 부풀리지 않게 (R-05).
      return `user_id IN (${base()} GROUP BY user_id HAVING uniqExact(insert_id) ${cmp} ${p.add(n)})`;
    }
    case "first_performed":
    case "last_performed":
      throw new CompileError("first/last_performed는 S4 지원 예정");
    default:
      throw new CompileError(`event 연산자 화이트리스트 위반`);
  }
}

function scalar(value: unknown): [unknown, boolean] {
  if (typeof value === "string") return [value, false];
  if (typeof value === "number") return [value, true];
  if (typeof value === "boolean") return [value ? "true" : "false", false];
  throw new CompileError(`지원하지 않는 value 형태: ${JSON.stringify(value)}`);
}

function arrayValues(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new CompileError(`value가 배열이 아님`);
  return value.map((v) => {
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return String(v);
    throw new CompileError(`배열 원소 타입 미지원`);
  });
}

function intValue(value: unknown): number {
  if (typeof value !== "number") throw new CompileError(`정수 value 아님`);
  return Math.trunc(value);
}
