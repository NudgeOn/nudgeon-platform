"use client";

import { useState } from "react";
import { outputPorts, type ABSplitNode, type EventWaitNode, type JourneyNode } from "@onda/journey-model";
import type { AttributeCondition, Condition, LogicalOp, SegmentDSL } from "@onda/segment-dsl";
import { DURATION_UNITS, durationUnit, formatDuration, newJourneyId } from "./journey-editor-model";
import { connectionIssue, nodeTitle, reachableNodes, type GraphDefinition } from "./journey-graph";
import { JourneyIcon } from "./journey-ui";

type Update = (mutator: (definition: GraphDefinition) => void) => void;
type AttributeOp = AttributeCondition["op"];
const ATTRIBUTE_OPS: Array<{ value: AttributeOp; label: string }> = [
  { value: "eq", label: "같음" }, { value: "neq", label: "다름" },
  { value: "gt", label: "초과" }, { value: "gte", label: "이상" },
  { value: "lt", label: "미만" }, { value: "lte", label: "이하" },
  { value: "in", label: "목록 중 하나와 같음" }, { value: "contains", label: "배열에 값 포함" },
  { value: "exists", label: "값이 있음" }, { value: "not_exists", label: "값이 없음" },
  { value: "before", label: "날짜 이전" }, { value: "after", label: "날짜 이후" },
  { value: "in_last_days", label: "최근 N일 이내" }, { value: "not_in_last_days", label: "최근 N일 이전" },
];

const blankCondition = (): Condition => ({ type: "attribute", key: "", op: "eq", value: "" });
const needsValue = (op: string) => op !== "exists" && op !== "not_exists";

function LogicSelect({ value, disabled, onChange, label }: {
  value: LogicalOp; disabled: boolean; onChange: (op: LogicalOp) => void; label: string;
}) {
  return <select className="j-condition-logic" aria-label={label} value={value} disabled={disabled}
    onChange={(event) => onChange(event.currentTarget.value as LogicalOp)}>
    <option value="AND">모두 충족 · AND</option><option value="OR">하나 이상 충족 · OR</option>
  </select>;
}

/** Controlled Segment DSL fields: the draft itself remains the source of truth. */
export function JourneyConditionEditor({ value, editable, onChange }: {
  value: SegmentDSL; editable: boolean; onChange: (value: SegmentDSL) => void;
}) {
  const update = (mutator: (draft: SegmentDSL) => void) => {
    if (!editable) return;
    const draft = structuredClone(value);
    mutator(draft);
    onChange(draft);
  };
  return <section className="j-condition-editor" aria-label="고객 분기 조건">
    <label className="j-condition-top-label">아래 그룹을</label>
    <LogicSelect value={value.operator} disabled={!editable} label="그룹 결합 방식" onChange={(op) => update((draft) => { draft.operator = op; })} />
    {value.groups.map((group, groupIndex) => <fieldset key={groupIndex} className="j-condition-group">
      <legend>조건 그룹 {groupIndex + 1}</legend>
      <div className="j-condition-group-heading">
        <LogicSelect value={group.operator} disabled={!editable} label={`${groupIndex + 1}번 그룹 조건 결합 방식`}
          onChange={(op) => update((draft) => { draft.groups[groupIndex]!.operator = op; })} />
        <button type="button" className="j-small-icon-button" title="그룹 삭제" aria-label={`${groupIndex + 1}번 조건 그룹 삭제`}
          disabled={!editable || value.groups.length <= 1} onClick={() => update((draft) => { draft.groups.splice(groupIndex, 1); })}>
          <JourneyIcon name="trash" size={15} />
        </button>
      </div>
      {group.conditions.map((condition, conditionIndex) => <div key={conditionIndex} className="j-condition-row">
        <div className="j-condition-row-heading"><span>조건 {conditionIndex + 1}</span>
          <button type="button" className="j-small-icon-button" aria-label={`${groupIndex + 1}번 그룹 ${conditionIndex + 1}번 조건 삭제`}
            disabled={!editable || group.conditions.length <= 1} onClick={() => update((draft) => { draft.groups[groupIndex]!.conditions.splice(conditionIndex, 1); })}>
            <JourneyIcon name="close" size={14} />
          </button>
        </div>
        <ConditionFields condition={condition} editable={editable} label={`${groupIndex + 1}그룹 ${conditionIndex + 1}조건`}
          onChange={(next) => update((draft) => { draft.groups[groupIndex]!.conditions[conditionIndex] = next; })} />
      </div>)}
      <button type="button" className="j-condition-add" disabled={!editable || group.conditions.length >= 50}
        onClick={() => update((draft) => { draft.groups[groupIndex]!.conditions.push(blankCondition()); })}>
        <JourneyIcon name="plus" size={14} />조건 추가
      </button>
    </fieldset>)}
    <button type="button" className="j-button j-condition-add-group" disabled={!editable || value.groups.length >= 20}
      onClick={() => update((draft) => { draft.groups.push({ operator: "AND", conditions: [blankCondition()] }); })}>
      <JourneyIcon name="plus" size={15} />조건 그룹 추가
    </button>
    <p className="j-inspector-help">분기에 도착했을 때 고객 속성·수집된 행동으로 한 번 판단합니다. 행동 집계 반영에는 지연이 있을 수 있습니다.</p>
  </section>;
}

function ConditionFields({ condition, editable, label, onChange }: {
  condition: Condition; editable: boolean; label: string; onChange: (condition: Condition) => void;
}) {
  const supported = condition.type === "attribute" || condition.type === "event";
  return <>
    <select aria-label={`${label} 종류`} value={condition.type} disabled={!editable}
      onChange={(event) => onChange(event.currentTarget.value === "event"
        ? { type: "event", event: "", op: "performed", window_days: 30 } : blankCondition())}>
      {!supported && <option value={condition.type} disabled>기존 조건 · {condition.type}</option>}
      <option value="attribute">고객 속성</option><option value="event">이벤트 행동</option>
    </select>
    {condition.type === "attribute" && <>
      <input aria-label={`${label} 속성 이름`} value={condition.key} disabled={!editable} placeholder="예: country, plan"
        autoComplete="off" spellCheck={false} onChange={(event) => onChange({ ...condition, key: event.currentTarget.value })} />
      <select aria-label={`${label} 비교 방식`} value={condition.op} disabled={!editable} onChange={(event) => {
        const op = event.currentTarget.value as AttributeOp;
        const value = op === "in" ? (Array.isArray(condition.value) ? condition.value : [])
          : op.endsWith("last_days") ? (typeof condition.value === "number" ? condition.value : 30)
            : Array.isArray(condition.value) ? "" : condition.value;
        onChange({ ...condition, op, value });
      }}>
        {ATTRIBUTE_OPS.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
      </select>
      {needsValue(condition.op) && <AttributeValue condition={condition} editable={editable} label={label} onChange={onChange} />}
      {condition.op === "contains" && <p className="j-inspector-help">문자열 배열 속성에 이 값이 포함되는지 확인합니다.</p>}
    </>}
    {condition.type === "event" && <>
      <input aria-label={`${label} 이벤트 이름`} value={condition.event} disabled={!editable} placeholder="예: purchase_completed"
        autoComplete="off" spellCheck={false} onChange={(event) => onChange({ ...condition, event: event.currentTarget.value })} />
      <select aria-label={`${label} 수행 여부`} value={condition.op} disabled={!editable}
        onChange={(event) => onChange({ ...condition, op: event.currentTarget.value as "performed" | "not_performed" })}>
        {!["performed", "not_performed"].includes(condition.op) && <option value={condition.op} disabled>기존 연산자 · {condition.op}</option>}
        <option value="performed">수행함</option><option value="not_performed">수행하지 않음</option>
      </select>
      <label className="j-condition-period">최근
        <input aria-label={`${label} 행동 조회 일수`} type="number" min={1} max={180} step={1}
          value={Number.isFinite(condition.window_days ?? 30) ? condition.window_days ?? 30 : ""} disabled={!editable}
          onChange={(event) => onChange({ ...condition, window_days: event.currentTarget.valueAsNumber })} />일
      </label>
      {!["performed", "not_performed"].includes(condition.op) && <p className="j-inspector-help j-inspector-error">분기는 수행·미수행 조건만 지원합니다. 기존 조건은 선택을 바꾸기 전까지 유지됩니다.</p>}
    </>}
    {!supported && <p className="j-inspector-help j-inspector-error">이 조건은 분기에서 지원하지 않습니다. 기존 값은 보존되며 종류를 바꾸어 수정할 수 있습니다.</p>}
  </>;
}

function AttributeValue({ condition, editable, label, onChange }: {
  condition: AttributeCondition; editable: boolean; label: string; onChange: (condition: AttributeCondition) => void;
}) {
  const value = condition.value;
  const kind = Array.isArray(value) ? "list" : value === null ? "null" : typeof value;
  const numeric = condition.op.endsWith("last_days");
  const canChooseType = !numeric && condition.op !== "in" && condition.op !== "before" && condition.op !== "after" && condition.op !== "contains";
  if (condition.op === "in") return <ListValue value={value} editable={editable} label={label}
    onChange={(values) => onChange({ ...condition, value: values })} />;
  return <>
    {canChooseType && <select aria-label={`${label} 값 종류`} value={["string", "number", "boolean"].includes(kind) ? kind : "existing"}
      disabled={!editable} onChange={(event) => onChange({ ...condition,
        value: event.currentTarget.value === "number" ? 0 : event.currentTarget.value === "boolean" ? true : "" })}>
      {!["string", "number", "boolean"].includes(kind) && <option value="existing" disabled>기존 값 유지</option>}
      <option value="string">문자열</option><option value="number">숫자</option><option value="boolean">참·거짓</option>
    </select>}
    {kind === "boolean" && !numeric ? <select aria-label={`${label} 비교값`} disabled={!editable} value={String(value)}
      onChange={(event) => onChange({ ...condition, value: event.currentTarget.value === "true" })}>
      <option value="true">참 · true</option><option value="false">거짓 · false</option>
    </select> : <input aria-label={`${label} 비교값`} disabled={!editable || (!numeric && !["string", "number", "undefined"].includes(kind))}
      type={numeric || kind === "number" ? "number" : "text"} step={numeric ? 1 : "any"} min={numeric ? 1 : undefined}
      value={value === undefined || (typeof value === "number" && !Number.isFinite(value)) ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)}
      placeholder={condition.op === "before" || condition.op === "after" ? "2026-08-31T00:00:00Z" : "비교할 값"}
      onChange={(event) => onChange({ ...condition, value: numeric || kind === "number" ? event.currentTarget.valueAsNumber : event.currentTarget.value })} />}
  </>;
}

function ListValue({ value, editable, label, onChange }: {
  value: unknown; editable: boolean; label: string; onChange: (values: string[]) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  return <>
    <input aria-label={`${label} 비교 목록`} disabled={!editable} value={editing ?? (Array.isArray(value) ? value.join(", ") : "")}
      placeholder="예: KR, JP, US" onFocus={(event) => setEditing(event.currentTarget.value)} onBlur={() => setEditing(null)}
      onChange={(event) => {
        const text = event.currentTarget.value; setEditing(text);
        onChange(text.split(",").map((item) => item.trim()).filter(Boolean));
      }} />
    <p className="j-inspector-help">쉼표로 구분한 문자열 목록입니다.</p>
  </>;
}

export function EventWaitSettings({ node, editable, onUpdate, id }: {
  node: EventWaitNode & { id: string }; editable: boolean; onUpdate: Update; id: string;
}) {
  const [unit, setUnit] = useState(() => durationUnit(node.timeout_seconds));
  const amount = node.timeout_seconds / unit;
  const valid = Number.isSafeInteger(node.timeout_seconds) && node.timeout_seconds > 0;
  function update(fields: Partial<EventWaitNode>) {
    onUpdate((draft) => { const current = draft.nodes.find((item) => item.id === node.id); if (current?.type === "event_wait") Object.assign(current, fields); });
  }
  return <>
    <div className="j-inspector-field"><label htmlFor={`${id}-wait-event`}>기다릴 이벤트</label>
      <input id={`${id}-wait-event`} value={node.event_name} maxLength={200} disabled={!editable} placeholder="예: purchase_completed"
        autoComplete="off" spellCheck={false} onChange={(event) => update({ event_name: event.currentTarget.value })} />
    </div>
    <div className="j-inspector-duration-fields">
      <div className="j-inspector-field"><label htmlFor={`${id}-timeout`}>시간 제한 <span className="j-inspector-required">필수</span></label>
        <input id={`${id}-timeout`} type="number" min={0} step="any" disabled={!editable} aria-invalid={!valid || undefined}
          value={Number.isFinite(amount) ? amount : ""} onChange={(event) => update({ timeout_seconds: event.currentTarget.valueAsNumber * unit })} />
      </div>
      <div className="j-inspector-field"><label htmlFor={`${id}-timeout-unit`}>단위</label>
        <select id={`${id}-timeout-unit`} value={unit} disabled={!editable} onChange={(event) => {
          const nextUnit = Number(event.currentTarget.value); setUnit(nextUnit); update({ timeout_seconds: amount * nextUnit });
        }}>{DURATION_UNITS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
      </div>
    </div>
    <p className={`j-inspector-help${valid ? "" : " j-inspector-error"}`}>{valid ? `최대 ${formatDuration(node.timeout_seconds)} 동안 기다립니다.` : "1초 이상의 정수로 제한 시간을 입력해 주세요."}</p>
    <div className="j-inspector-note"><JourneyIcon name="info" size={16} /><p>
      이 단계에 도착한 뒤 서버에 처음 접수된 이벤트만 인정합니다. 도착 전에 접수된 이벤트의 재전송은 제외합니다.
      <span className="j-wait-receipt-help" title="고객 기기에서 과거에 수행한 행동도 오프라인 상태였다가 대기 시작 후 서버에 처음 접수되면 해당됩니다."> 오프라인 이벤트 기준 ⓘ</span>
    </p></div>
  </>;
}

export function ABSplitSettings({ node, definition, editable, locked, onUpdate, onRenew, id }: {
  node: ABSplitNode & { id: string }; definition: GraphDefinition; editable: boolean; locked: boolean;
  onUpdate: Update; onRenew: () => void; id: string;
}) {
  const sum = node.variants.reduce((total, variant) => total + variant.weight, 0);
  function updateVariants(mutator: (current: ABSplitNode) => void) {
    onUpdate((draft) => { const current = draft.nodes.find((item) => item.id === node.id); if (current?.type === "ab_split") mutator(current); });
  }
  function removalBlocked(variantId: string): boolean {
    const next = { ...definition, edges: definition.edges.filter((edge) => edge.source !== node.id || edge.source_port !== variantId) };
    const reached = reachableNodes(next);
    return [...reachableNodes(definition)].some((nodeId) => !reached.has(nodeId));
  }
  function addVariant() {
    if (locked || node.variants.length >= 4) return;
    onUpdate((draft) => {
      const current = draft.nodes.find((item) => item.id === node.id);
      if (current?.type !== "ab_split") return;
      const variantId = newJourneyId("variant");
      const count = current.variants.length + 1;
      const label = ["A", "B", "C", "D"].find((item) => !current.variants.some((variant) => variant.label === item)) ?? `경로 ${count}`;
      current.variants = [...current.variants, { id: variantId, label, weight: 0 }]
        .map((variant, index) => ({ ...variant, weight: Math.floor(100 / count) + (index < 100 % count ? 1 : 0) }));
      draft.edges.push({ id: newJourneyId("edge"), source: node.id, source_port: variantId,
        target: draft.edges.find((edge) => edge.source === node.id)?.target ?? null });
    });
  }
  function removeVariant(variantId: string) {
    if (locked || node.variants.length <= 2 || removalBlocked(variantId)) return;
    onUpdate((draft) => {
      const current = draft.nodes.find((item) => item.id === node.id);
      if (current?.type !== "ab_split") return;
      const count = current.variants.length - 1;
      current.variants = current.variants.filter((variant) => variant.id !== variantId)
        .map((variant, index) => ({ ...variant, weight: Math.floor(100 / count) + (index < 100 % count ? 1 : 0) }));
      draft.edges = draft.edges.filter((edge) => edge.source !== node.id || edge.source_port !== variantId);
    });
  }
  return <>
    <div className="j-ab-policy"><JourneyIcon name="split" size={18} /><p>같은 고객은 재진입해도 같은 경로에 배정됩니다.</p></div>
    {node.variants.map((variant, index) => <div key={variant.id} className="j-ab-variant">
      <label htmlFor={`${id}-variant-${index}`}>경로 {index + 1}</label>
      <div className="j-ab-variant-fields">
        <input id={`${id}-variant-${index}`} aria-label={`${index + 1}번 경로 이름`} value={variant.label} maxLength={60} disabled={!editable}
          onChange={(event) => { const label = event.currentTarget.value; updateVariants((current) => { current.variants[index]!.label = label; }); }} />
        <div className="j-ab-weight"><input aria-label={`${index + 1}번 경로 비율`} type="number" min={1} max={99} step={1}
          disabled={!editable || locked} value={Number.isFinite(variant.weight) ? variant.weight : ""}
          onChange={(event) => { const weight = event.currentTarget.valueAsNumber; updateVariants((current) => { current.variants[index]!.weight = weight; }); }} /><span>%</span></div>
        <button type="button" className="j-small-icon-button" aria-label={`${index + 1}번 A/B 경로 삭제`}
          title={removalBlocked(variant.id) ? "이 경로에만 연결된 단계를 먼저 삭제해 주세요" : "경로 삭제 · 남은 비율 균등 배분"}
          disabled={!editable || locked || node.variants.length <= 2 || removalBlocked(variant.id)} onClick={() => removeVariant(variant.id)}>
          <JourneyIcon name="close" size={15} />
        </button>
      </div>
    </div>)}
    <div className={`j-ab-total${sum !== 100 ? " is-invalid" : ""}`} role="status"><span>비율 합계</span><strong>{Number.isFinite(sum) ? sum : "—"}% / 100%</strong></div>
    {!locked && <button type="button" className="j-button" disabled={!editable || node.variants.length >= 4} onClick={addVariant}>
      <JourneyIcon name="plus" size={15} />경로 추가 <small>최대 4개</small>
    </button>}
    <p className="j-inspector-help">{locked ? "활성화한 실험의 경로와 비율은 고정됩니다. 경로 이름과 연결 대상은 수정할 수 있습니다."
      : "각 비율은 1% 이상인 정수, 합계는 100%입니다. 경로를 추가·삭제하면 비율을 균등하게 나눕니다."}</p>
    {locked && <button type="button" className="j-button j-new-experiment" disabled={!editable} onClick={onRenew}>
      <JourneyIcon name="plus" size={16} />새 실험으로 시작
    </button>}
    <p className="j-inspector-help j-node-id" title={node.id}>실험 ID · {node.id}</p>
  </>;
}

export function RouteSettings({ definition, node, editable, onConnect }: {
  definition: GraphDefinition; node: JourneyNode & { id: string }; editable: boolean;
  onConnect: (source: string, port: string, target: string | null) => void;
}) {
  return <section className="j-route-settings" aria-label="다음 단계 연결">
    <h3>다음 단계 연결</h3>
    {outputPorts(node).map((port) => {
      const edge = definition.edges.find((item) => item.source === node.id && item.source_port === port.id);
      return <label key={port.id} className="j-route-field"><span>{port.label}</span>
        <select aria-label={`${port.label} 경로의 다음 단계`} value={edge ? edge.target ?? "__exit__" : "__missing__"} disabled={!editable}
          onChange={(event) => onConnect(node.id, port.id, event.currentTarget.value === "__exit__" ? null : event.currentTarget.value)}>
          {!edge && <option value="__missing__" disabled>연결이 필요합니다</option>}
          <option value="__exit__" disabled={Boolean(connectionIssue(definition, node.id, port.id, null))}>저니 종료</option>
          {definition.nodes.filter((item) => item.id !== node.id).map((item) => <option key={item.id} value={item.id}
            disabled={Boolean(connectionIssue(definition, node.id, port.id, item.id))}>
            {nodeTitle(item)} · {item.id.slice(-6)}
          </option>)}
        </select>
      </label>;
    })}
    <p className="j-inspector-help">공통 다음 단계로 합류할 수 있습니다. 순환하거나 다른 단계를 끊는 연결은 선택할 수 없습니다.</p>
  </section>;
}
