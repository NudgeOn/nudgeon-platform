"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ABSplitNode, EventWaitNode, JourneyNode } from "@nudgeon/journey-model";
import type { AttributeCondition, Condition, LogicalOp, SegmentDSL } from "@nudgeon/segment-dsl";
import { DURATION_UNITS, durationUnit, formatDuration, newJourneyId, nodeToolLabel } from "./journey-editor-model";
import { connectionIssue, reachableNodes, type GraphDefinition } from "./journey-graph";
import { JourneyIcon, useJourneyText } from "./journey-ui";

type Update = (mutator: (definition: GraphDefinition) => void) => void;
type AttributeOp = AttributeCondition["op"];
// 표시 이름은 카탈로그 `journeyEditor.decision.ops.<value>`.
const ATTRIBUTE_OPS: AttributeOp[] = [
  "eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "exists", "not_exists", "before", "after", "in_last_days", "not_in_last_days",
];

const blankCondition = (): Condition => ({ type: "attribute", key: "", op: "eq", value: "" });
const needsValue = (op: string) => op !== "exists" && op !== "not_exists";

function LogicSelect({ value, disabled, onChange, label }: {
  value: LogicalOp; disabled: boolean; onChange: (op: LogicalOp) => void; label: string;
}) {
  const t = useTranslations("journeyEditor.decision");
  return <select className="j-condition-logic" aria-label={label} value={value} disabled={disabled}
    onChange={(event) => onChange(event.currentTarget.value as LogicalOp)}>
    <option value="AND">{t("logicAnd")}</option><option value="OR">{t("logicOr")}</option>
  </select>;
}

/** Controlled Segment DSL fields: the draft itself remains the source of truth. */
export function JourneyConditionEditor({ value, editable, onChange }: {
  value: SegmentDSL; editable: boolean; onChange: (value: SegmentDSL) => void;
}) {
  const t = useTranslations("journeyEditor.decision");
  const update = (mutator: (draft: SegmentDSL) => void) => {
    if (!editable) return;
    const draft = structuredClone(value);
    mutator(draft);
    onChange(draft);
  };
  return <section className="j-condition-editor" aria-label={t("editorLabel")}>
    <label className="j-condition-top-label">{t("groupsIntro")}</label>
    <LogicSelect value={value.operator} disabled={!editable} label={t("groupLogicLabel")} onChange={(op) => update((draft) => { draft.operator = op; })} />
    {value.groups.map((group, groupIndex) => <fieldset key={groupIndex} className="j-condition-group">
      <legend>{t("group", { n: groupIndex + 1 })}</legend>
      <div className="j-condition-group-heading">
        <LogicSelect value={group.operator} disabled={!editable} label={t("groupConditionLogicLabel", { n: groupIndex + 1 })}
          onChange={(op) => update((draft) => { draft.groups[groupIndex]!.operator = op; })} />
        <button type="button" className="j-small-icon-button" title={t("removeGroup")} aria-label={t("removeGroupLabel", { n: groupIndex + 1 })}
          disabled={!editable || value.groups.length <= 1} onClick={() => update((draft) => { draft.groups.splice(groupIndex, 1); })}>
          <JourneyIcon name="trash" size={15} />
        </button>
      </div>
      {group.conditions.map((condition, conditionIndex) => <div key={conditionIndex} className="j-condition-row">
        <div className="j-condition-row-heading"><span>{t("condition", { n: conditionIndex + 1 })}</span>
          <button type="button" className="j-small-icon-button" aria-label={t("removeConditionLabel", { group: groupIndex + 1, n: conditionIndex + 1 })}
            disabled={!editable || group.conditions.length <= 1} onClick={() => update((draft) => { draft.groups[groupIndex]!.conditions.splice(conditionIndex, 1); })}>
            <JourneyIcon name="close" size={14} />
          </button>
        </div>
        <ConditionFields condition={condition} editable={editable} label={t("conditionRef", { group: groupIndex + 1, n: conditionIndex + 1 })}
          onChange={(next) => update((draft) => { draft.groups[groupIndex]!.conditions[conditionIndex] = next; })} />
      </div>)}
      <button type="button" className="j-condition-add" disabled={!editable || group.conditions.length >= 50}
        onClick={() => update((draft) => { draft.groups[groupIndex]!.conditions.push(blankCondition()); })}>
        <JourneyIcon name="plus" size={14} />{t("addCondition")}
      </button>
    </fieldset>)}
    <button type="button" className="j-button j-condition-add-group" disabled={!editable || value.groups.length >= 20}
      onClick={() => update((draft) => { draft.groups.push({ operator: "AND", conditions: [blankCondition()] }); })}>
      <JourneyIcon name="plus" size={15} />{t("addGroup")}
    </button>
    <p className="j-inspector-help">{t("editorHelp")}</p>
  </section>;
}

function ConditionFields({ condition, editable, label, onChange }: {
  condition: Condition; editable: boolean; label: string; onChange: (condition: Condition) => void;
}) {
  const t = useTranslations("journeyEditor.decision");
  const supported = condition.type === "attribute" || condition.type === "event";
  return <>
    <select aria-label={t("fieldLabel.type", { label })} value={condition.type} disabled={!editable}
      onChange={(event) => onChange(event.currentTarget.value === "event"
        ? { type: "event", event: "", op: "performed", window_days: 30 } : blankCondition())}>
      {!supported && <option value={condition.type} disabled>{t("existingCondition", { type: condition.type })}</option>}
      <option value="attribute">{t("typeAttribute")}</option><option value="event">{t("typeEvent")}</option>
    </select>
    {condition.type === "attribute" && <>
      <input aria-label={t("fieldLabel.attributeKey", { label })} value={condition.key} disabled={!editable} placeholder={t("attributeKeyPlaceholder")}
        autoComplete="off" spellCheck={false} onChange={(event) => onChange({ ...condition, key: event.currentTarget.value })} />
      <select aria-label={t("fieldLabel.op", { label })} value={condition.op} disabled={!editable} onChange={(event) => {
        const op = event.currentTarget.value as AttributeOp;
        const value = op === "in" ? (Array.isArray(condition.value) ? condition.value : [])
          : op.endsWith("last_days") ? (typeof condition.value === "number" ? condition.value : 30)
            : Array.isArray(condition.value) ? "" : condition.value;
        onChange({ ...condition, op, value });
      }}>
        {ATTRIBUTE_OPS.map((op) => <option key={op} value={op}>{t(`ops.${op}`)}</option>)}
      </select>
      {needsValue(condition.op) && <AttributeValue condition={condition} editable={editable} label={label} onChange={onChange} />}
      {condition.op === "contains" && <p className="j-inspector-help">{t("containsHelp")}</p>}
    </>}
    {condition.type === "event" && <>
      <input aria-label={t("fieldLabel.eventName", { label })} value={condition.event} disabled={!editable} placeholder={t("eventPlaceholder")}
        autoComplete="off" spellCheck={false} onChange={(event) => onChange({ ...condition, event: event.currentTarget.value })} />
      <select aria-label={t("fieldLabel.performed", { label })} value={condition.op} disabled={!editable}
        onChange={(event) => onChange({ ...condition, op: event.currentTarget.value as "performed" | "not_performed" })}>
        {!["performed", "not_performed"].includes(condition.op) && <option value={condition.op} disabled>{t("existingOp", { op: condition.op })}</option>}
        <option value="performed">{t("performed")}</option><option value="not_performed">{t("notPerformed")}</option>
      </select>
      <label className="j-condition-period">{t("windowPrefix")}
        <input aria-label={t("fieldLabel.windowDays", { label })} type="number" min={1} max={180} step={1}
          value={Number.isFinite(condition.window_days ?? 30) ? condition.window_days ?? 30 : ""} disabled={!editable}
          onChange={(event) => onChange({ ...condition, window_days: event.currentTarget.valueAsNumber })} />{t("windowSuffix")}
      </label>
      {!["performed", "not_performed"].includes(condition.op) && <p className="j-inspector-help j-inspector-error">{t("unsupportedEventOp")}</p>}
    </>}
    {!supported && <p className="j-inspector-help j-inspector-error">{t("unsupportedCondition")}</p>}
  </>;
}

function AttributeValue({ condition, editable, label, onChange }: {
  condition: AttributeCondition; editable: boolean; label: string; onChange: (condition: AttributeCondition) => void;
}) {
  const t = useTranslations("journeyEditor.decision");
  const value = condition.value;
  const kind = Array.isArray(value) ? "list" : value === null ? "null" : typeof value;
  const numeric = condition.op.endsWith("last_days");
  const canChooseType = !numeric && condition.op !== "in" && condition.op !== "before" && condition.op !== "after" && condition.op !== "contains";
  if (condition.op === "in") return <ListValue value={value} editable={editable} label={label}
    onChange={(values) => onChange({ ...condition, value: values })} />;
  return <>
    {canChooseType && <select aria-label={t("fieldLabel.valueType", { label })} value={["string", "number", "boolean"].includes(kind) ? kind : "existing"}
      disabled={!editable} onChange={(event) => onChange({ ...condition,
        value: event.currentTarget.value === "number" ? 0 : event.currentTarget.value === "boolean" ? true : "" })}>
      {!["string", "number", "boolean"].includes(kind) && <option value="existing" disabled>{t("keepExistingValue")}</option>}
      <option value="string">{t("valueString")}</option><option value="number">{t("valueNumber")}</option><option value="boolean">{t("valueBoolean")}</option>
    </select>}
    {kind === "boolean" && !numeric ? <select aria-label={t("fieldLabel.value", { label })} disabled={!editable} value={String(value)}
      onChange={(event) => onChange({ ...condition, value: event.currentTarget.value === "true" })}>
      <option value="true">{t("booleanTrue")}</option><option value="false">{t("booleanFalse")}</option>
    </select> : <input aria-label={t("fieldLabel.value", { label })} disabled={!editable || (!numeric && !["string", "number", "undefined"].includes(kind))}
      type={numeric || kind === "number" ? "number" : "text"} step={numeric ? 1 : "any"} min={numeric ? 1 : undefined}
      value={value === undefined || (typeof value === "number" && !Number.isFinite(value)) ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)}
      placeholder={condition.op === "before" || condition.op === "after" ? "2026-08-31T00:00:00Z" : t("valuePlaceholder")}
      onChange={(event) => onChange({ ...condition, value: numeric || kind === "number" ? event.currentTarget.valueAsNumber : event.currentTarget.value })} />}
  </>;
}

function ListValue({ value, editable, label, onChange }: {
  value: unknown; editable: boolean; label: string; onChange: (values: string[]) => void;
}) {
  const t = useTranslations("journeyEditor.decision");
  const [editing, setEditing] = useState<string | null>(null);
  return <>
    <input aria-label={t("fieldLabel.list", { label })} disabled={!editable} value={editing ?? (Array.isArray(value) ? value.join(", ") : "")}
      placeholder={t("listPlaceholder")} onFocus={(event) => setEditing(event.currentTarget.value)} onBlur={() => setEditing(null)}
      onChange={(event) => {
        const text = event.currentTarget.value; setEditing(text);
        onChange(text.split(",").map((item) => item.trim()).filter(Boolean));
      }} />
    <p className="j-inspector-help">{t("listHelp")}</p>
  </>;
}

export function EventWaitSettings({ node, editable, onUpdate, id }: {
  node: EventWaitNode & { id: string }; editable: boolean; onUpdate: Update; id: string;
}) {
  const t = useTranslations("journeyEditor");
  const [unit, setUnit] = useState(() => durationUnit(node.timeout_seconds));
  const amount = node.timeout_seconds / unit;
  const valid = Number.isSafeInteger(node.timeout_seconds) && node.timeout_seconds > 0;
  function update(fields: Partial<EventWaitNode>) {
    onUpdate((draft) => { const current = draft.nodes.find((item) => item.id === node.id); if (current?.type === "event_wait") Object.assign(current, fields); });
  }
  return <>
    <div className="j-inspector-field"><label htmlFor={`${id}-wait-event`}>{t("eventWait.event")}</label>
      <input id={`${id}-wait-event`} value={node.event_name} maxLength={200} disabled={!editable} placeholder={t("decision.eventPlaceholder")}
        autoComplete="off" spellCheck={false} onChange={(event) => update({ event_name: event.currentTarget.value })} />
    </div>
    <div className="j-inspector-duration-fields">
      <div className="j-inspector-field"><label htmlFor={`${id}-timeout`}>{t("eventWait.timeout")} <span className="j-inspector-required">{t("eventWait.required")}</span></label>
        <input id={`${id}-timeout`} type="number" min={0} step="any" disabled={!editable} aria-invalid={!valid || undefined}
          value={Number.isFinite(amount) ? amount : ""} onChange={(event) => update({ timeout_seconds: event.currentTarget.valueAsNumber * unit })} />
      </div>
      <div className="j-inspector-field"><label htmlFor={`${id}-timeout-unit`}>{t("eventWait.unit")}</label>
        <select id={`${id}-timeout-unit`} value={unit} disabled={!editable} onChange={(event) => {
          const nextUnit = Number(event.currentTarget.value); setUnit(nextUnit); update({ timeout_seconds: amount * nextUnit });
        }}>{DURATION_UNITS.map((item) => <option key={item} value={item}>{t(`model.unit.${item}`)}</option>)}</select>
      </div>
    </div>
    <p className={`j-inspector-help${valid ? "" : " j-inspector-error"}`}>{valid ? t("eventWait.timeoutHelp", { duration: formatDuration(node.timeout_seconds, t) }) : t("eventWait.timeoutInvalid")}</p>
    <div className="j-inspector-note"><JourneyIcon name="info" size={16} /><p>
      {t("eventWait.receiptNote")}
      <span className="j-wait-receipt-help" title={t("eventWait.offlineTitle")}> {t("eventWait.offlineLabel")}</span>
    </p></div>
  </>;
}

export function ABSplitSettings({ node, definition, editable, locked, onUpdate, onRenew, id }: {
  node: ABSplitNode & { id: string }; definition: GraphDefinition; editable: boolean; locked: boolean;
  onUpdate: Update; onRenew: () => void; id: string;
}) {
  const t = useTranslations("journeyEditor.abSplit");
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
      const label = ["A", "B", "C", "D"].find((item) => !current.variants.some((variant) => variant.label === item)) ?? t("pathName", { n: count });
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
    <div className="j-ab-policy"><JourneyIcon name="split" size={18} /><p>{t("policy")}</p></div>
    {node.variants.map((variant, index) => <div key={variant.id} className="j-ab-variant">
      <label htmlFor={`${id}-variant-${index}`}>{t("pathName", { n: index + 1 })}</label>
      <div className="j-ab-variant-fields">
        <input id={`${id}-variant-${index}`} aria-label={t("pathLabelField", { n: index + 1 })} value={variant.label} maxLength={60} disabled={!editable}
          onChange={(event) => { const label = event.currentTarget.value; updateVariants((current) => { current.variants[index]!.label = label; }); }} />
        <div className="j-ab-weight"><input aria-label={t("pathWeightField", { n: index + 1 })} type="number" min={1} max={99} step={1}
          disabled={!editable || locked} value={Number.isFinite(variant.weight) ? variant.weight : ""}
          onChange={(event) => { const weight = event.currentTarget.valueAsNumber; updateVariants((current) => { current.variants[index]!.weight = weight; }); }} /><span>%</span></div>
        <button type="button" className="j-small-icon-button" aria-label={t("removePathLabel", { n: index + 1 })}
          title={removalBlocked(variant.id) ? t("removeBlocked") : t("removePathTitle")}
          disabled={!editable || locked || node.variants.length <= 2 || removalBlocked(variant.id)} onClick={() => removeVariant(variant.id)}>
          <JourneyIcon name="close" size={15} />
        </button>
      </div>
    </div>)}
    <div className={`j-ab-total${sum !== 100 ? " is-invalid" : ""}`} role="status"><span>{t("total")}</span><strong>{Number.isFinite(sum) ? sum : "—"}% / 100%</strong></div>
    {!locked && <button type="button" className="j-button" disabled={!editable || node.variants.length >= 4} onClick={addVariant}>
      <JourneyIcon name="plus" size={15} />{t("addPath")} <small>{t("maxPaths")}</small>
    </button>}
    <p className="j-inspector-help">{locked ? t("lockedHelp") : t("weightHelp")}</p>
    {locked && <button type="button" className="j-button j-new-experiment" disabled={!editable} onClick={onRenew}>
      <JourneyIcon name="plus" size={16} />{t("renew")}
    </button>}
    <p className="j-inspector-help j-node-id" title={node.id}>{t("experimentId", { id: node.id })}</p>
  </>;
}

export function RouteSettings({ definition, node, editable, onConnect }: {
  definition: GraphDefinition; node: JourneyNode & { id: string }; editable: boolean;
  onConnect: (source: string, port: string, target: string | null) => void;
}) {
  const t = useTranslations("journeyEditor");
  const { ports } = useJourneyText();
  return <section className="j-route-settings" aria-label={t("route.title")}>
    <h3>{t("route.title")}</h3>
    {ports(node).map((port) => {
      const edge = definition.edges.find((item) => item.source === node.id && item.source_port === port.id);
      return <label key={port.id} className="j-route-field"><span>{port.label}</span>
        <select aria-label={t("route.portNext", { port: port.label })} value={edge ? edge.target ?? "__exit__" : "__missing__"} disabled={!editable}
          onChange={(event) => onConnect(node.id, port.id, event.currentTarget.value === "__exit__" ? null : event.currentTarget.value)}>
          {!edge && <option value="__missing__" disabled>{t("route.missing")}</option>}
          <option value="__exit__" disabled={Boolean(connectionIssue(definition, node.id, port.id, null))}>{t("route.exit")}</option>
          {definition.nodes.filter((item) => item.id !== node.id).map((item) => <option key={item.id} value={item.id}
            disabled={Boolean(connectionIssue(definition, node.id, port.id, item.id))}>
            {nodeToolLabel(t, item.type)} · {item.id.slice(-6)}
          </option>)}
        </select>
      </label>;
    })}
    <p className="j-inspector-help">{t("route.help")}</p>
  </section>;
}
