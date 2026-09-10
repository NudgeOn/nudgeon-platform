"use client";

import { useId, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { EMAIL_PROVIDER_LABELS, type EmailProvider, type SegmentSummary } from "@nudgeon/api-client";
import type { MessageNode, DelayNode, JourneyNode } from "@nudgeon/journey-model";
import { api } from "@/lib/api";
import { useAppId } from "../use-app-id";
import { isEmailProvider } from "../email-templates/email-provider-card";
import { ABSplitSettings, EventWaitSettings, JourneyConditionEditor, RouteSettings } from "./JourneyDecisionSettings";
import { canMoveNode, outgoingEdges, type GraphDefinition, type PublishedABNodes } from "./journey-graph";
import { DURATION_UNITS, durationUnit, formatDuration } from "./journey-editor-model";
import { JourneyIcon, type JourneyIconName } from "./journey-ui";
import { JourneyEmailTemplateSheet } from "./JourneyEmailTemplateSheet";
import { AlimtalkMessageFields } from "./JourneyAlimtalkFields";
import { withMessageChannel, type MessageChannel } from "./alimtalk-variables";
import { EmailTemplateZipError, importEmailTemplateZip, type ImportedEmailTemplate } from "./email-template-zip";
import "./journey-inspector.css";

export interface JourneyInspectorProps {
  definition: GraphDefinition;
  selectedId: string;
  segments: SegmentSummary[];
  segmentsPending: boolean;
  segmentsError: boolean;
  onRetrySegments: () => void;
  editable: boolean;
  publishedABNodes: PublishedABNodes;
  onUpdate: (mutator: (definition: GraphDefinition) => void) => void;
  onMove: (id: string, offset: -1 | 1) => void;
  onRemove: (id: string) => void;
  onConnect: (source: string, port: string, target: string | null) => void;
  onRenewExperiment: (id: string) => void;
}

type UpdateDefinition = JourneyInspectorProps["onUpdate"];
type InspectorKind = "entry" | "exit" | JourneyNode["type"];

// 제목·설명·도움말은 카탈로그 `journeyEditor.inspector.kinds.<kind>.*`.
const inspectorIcon: Record<InspectorKind, JourneyIconName> = {
  entry: "users", exit: "flag", message: "message", delay: "clock", branch: "branch", event_wait: "event-wait", ab_split: "split",
};

export function JourneyInspector({
  definition, selectedId, segments, segmentsPending, segmentsError, publishedABNodes,
  onRetrySegments, editable, onUpdate, onMove, onRemove, onConnect, onRenewExperiment,
}: JourneyInspectorProps) {
  const t = useTranslations("journeyEditor");
  const fieldId = useId();
  const index = definition.nodes.findIndex((node) => `node:${node.id}` === selectedId);
  const node = definition.nodes[index];
  const kind: InspectorKind | undefined = selectedId === "entry" ? "entry"
    : selectedId === "exit" ? "exit" : node?.type;

  if (!kind) {
    return (
      <aside className="j-inspector j-inspector-empty" aria-label={t("inspector.empty.label")}>
        <span className="j-inspector-icon"><JourneyIcon name="info" size={22} /></span>
        <h2>{t("inspector.empty.title")}</h2>
        <p>{t("inspector.empty.body")}</p>
      </aside>
    );
  }

  const icon = kind === "entry" && definition.entry.type === "trigger" ? "trigger" : inspectorIcon[kind];
  const update: UpdateDefinition = (mutator) => { if (editable) onUpdate(mutator); };

  return (
    <aside className={`j-inspector j-inspector-${kind}`} aria-labelledby={`${fieldId}-heading`}>
      <header className="j-inspector-header">
        <div className="j-inspector-heading">
          <span className="j-inspector-icon"><JourneyIcon name={icon} size={23} /></span>
          <div>
            <p className="j-inspector-eyebrow">
              {index >= 0 ? t("inspector.header.stepOrdinal", { n: index + 1 }) : kind === "entry" ? t("inspector.header.entryEyebrow") : t("inspector.header.exitEyebrow")}
            </p>
            <h2 id={`${fieldId}-heading`}>{t(`inspector.kinds.${kind}.title`)}</h2>
          </div>
          {!editable && <span className="j-inspector-readonly">{t("inspector.header.readOnly")}</span>}
        </div>
        <p className="j-inspector-description">{t(`inspector.kinds.${kind}.description`)}</p>
        {index >= 0 && (
          <div className="j-inspector-actions">
            <span>{t("inspector.header.manage")}</span>
            <div className="j-inspector-action-group" role="group" aria-label={t("inspector.header.manageLabel")}>
              <button type="button" aria-label={t("inspector.header.moveUp")} title={t("inspector.header.moveUpTitle")}
                disabled={!editable || !node || !canMoveNode(definition, node.id, -1)} onClick={() => node && onMove(node.id, -1)}>
                <JourneyIcon name="up" size={16} />
              </button>
              <button type="button" aria-label={t("inspector.header.moveDown")} title={t("inspector.header.moveDownTitle")}
                disabled={!editable || !node || !canMoveNode(definition, node.id, 1)} onClick={() => node && onMove(node.id, 1)}>
                <JourneyIcon name="down" size={16} />
              </button>
              <span className="j-inspector-action-divider" />
              <button type="button" className="j-inspector-remove" aria-label={t("inspector.header.remove")}
                title={definition.nodes.length <= 1 ? t("inspector.header.minOneStep") : t("inspector.header.remove")}
                disabled={!editable || definition.nodes.length <= 1} onClick={() => node && onRemove(node.id)}>
                <JourneyIcon name="trash" size={16} />
              </button>
            </div>
          </div>
        )}
      </header>

      <div className="j-inspector-content">
        {kind === "entry" && (
          <EntrySettings definition={definition} segments={segments} pending={segmentsPending}
            error={segmentsError} onRetry={onRetrySegments} editable={editable} onUpdate={update} id={fieldId} />
        )}
        {kind === "exit" && (
          <ExitSettings definition={definition} editable={editable} onUpdate={update} id={fieldId} />
        )}
        {node?.type === "message" && (
          <MessageSettings node={node} index={index} editable={editable} onUpdate={update} id={fieldId} />
        )}
        {node?.type === "delay" && (
          <DelaySettings node={node} index={index} last={outgoingEdges(definition, node.id).every((edge) => edge.target === null)}
            editable={editable} onUpdate={update} id={fieldId} />
        )}
        {node?.type === "branch" && <JourneyConditionEditor value={node.condition} editable={editable}
          onChange={(condition) => update((draft) => {
            const current = draft.nodes.find((item) => `node:${item.id}` === selectedId);
            if (current?.type === "branch") current.condition = condition;
          })} />}
        {node?.type === "event_wait" && <EventWaitSettings node={node} editable={editable} onUpdate={update} id={fieldId} />}
        {node?.type === "ab_split" && <ABSplitSettings node={node} definition={definition} editable={editable}
          locked={Object.hasOwn(publishedABNodes, node.id)} onUpdate={update} id={fieldId} onRenew={() => onRenewExperiment(node.id)} />}
        {node && <RouteSettings node={node} definition={definition} editable={editable} onConnect={onConnect} />}
      </div>

      <footer className="j-inspector-footer">
        <JourneyIcon name="info" size={16} /><p>{t(`inspector.kinds.${kind}.helper`)}</p>
      </footer>
    </aside>
  );
}

function Field({ id, label, detail, children }: {
  id: string; label: string; detail?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="j-inspector-field">
      <div className="j-inspector-label-row"><label htmlFor={id}>{label}</label>{detail}</div>
      {children}
    </div>
  );
}

function Note({ children, warning = false }: { children: ReactNode; warning?: boolean }) {
  return (
    <div className={`j-inspector-note${warning ? " j-inspector-note-warning" : ""}`}>
      <JourneyIcon name="info" size={16} /><p>{children}</p>
    </div>
  );
}

function EntrySettings({ definition, segments, pending, error, onRetry, editable, onUpdate, id }: {
  definition: GraphDefinition; segments: SegmentSummary[]; pending: boolean; error: boolean;
  onRetry: () => void; editable: boolean; onUpdate: UpdateDefinition; id: string;
}) {
  const t = useTranslations("journeyEditor.inspector.entry");
  const entry = definition.entry;
  const activeSegments = segments.filter((segment) => segment.status === "active");
  const selectedSegment = segments.find((segment) => segment.id === entry.segment_id);
  const unavailable = Boolean(entry.segment_id && !activeSegments.some((segment) => segment.id === entry.segment_id));

  return (
    <>
      <Field id={`${id}-entry-type`} label={t("type")}>
        <select id={`${id}-entry-type`} value={entry.type} disabled={!editable}
          onChange={(event) => {
            const type = event.currentTarget.value as "blast" | "trigger";
            onUpdate((draft) => { draft.entry = { ...draft.entry, type }; });
          }}>
          <option value="blast">{t("blast")}</option>
          <option value="trigger">{t("trigger")}</option>
        </select>
      </Field>

      {entry.type === "blast" ? (
        <Field id={`${id}-segment`} label={t("segment")}>
          <select id={`${id}-segment`} value={entry.segment_id ?? ""}
            disabled={!editable || pending || error} aria-describedby={`${id}-segment-help`}
            onChange={(event) => {
              const segmentId = event.currentTarget.value;
              onUpdate((draft) => { draft.entry = { ...draft.entry, segment_id: segmentId || undefined }; });
            }}>
            <option value="">{pending ? t("loadingSegments") : t("chooseSegment")}</option>
            {unavailable && <option value={entry.segment_id} disabled>
              {selectedSegment?.name ?? t("savedSegment")}{!pending && !error ? ` · ${t("unavailableSuffix")}` : ""}
            </option>}
            {activeSegments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}
          </select>
          <div id={`${id}-segment-help`} className="j-inspector-help">
            {error ? (
              <p className="j-inspector-error">{t("loadFailed")} <button type="button"
                className="j-inspector-retry" onClick={onRetry}>{t("retry")}</button></p>
            ) : pending ? <p>{t("keepSelection")}</p>
              : unavailable ? <p className="j-inspector-error">{t("unavailableHelp")}</p>
                : activeSegments.length === 0 ? <p>{t("noSegments")}</p>
                  : <p>{t("blastHelp")}</p>}
          </div>
          {selectedSegment?.status === "active" && selectedSegment.last_count != null && (
            <div className="j-inspector-audience">
              <JourneyIcon name="users" size={17} /><span>{t("lastCount")}</span>
              <strong>{t.rich("lastCountValue", { count: selectedSegment.last_count, small: (c) => <small>{c}</small> })}</strong>
            </div>
          )}
        </Field>
      ) : (
        <>
          <Field id={`${id}-trigger-event`} label={t("triggerEvent")}>
            <input id={`${id}-trigger-event`} value={entry.trigger_event ?? ""} disabled={!editable}
              autoComplete="off" spellCheck={false} placeholder={t("triggerPlaceholder")}
              aria-describedby={`${id}-trigger-help`} onChange={(event) => {
                const triggerEvent = event.currentTarget.value;
                onUpdate((draft) => { draft.entry = { ...draft.entry, trigger_event: triggerEvent || undefined }; });
              }} />
            <p id={`${id}-trigger-help`} className="j-inspector-help">{t("triggerHelp")}</p>
          </Field>
          {entry.segment_id && (
            <Note warning>{t("segmentPreserved")}</Note>
          )}
        </>
      )}

      <div className="j-inspector-divider" />
      <Field id={`${id}-category`} label={t("category")}>
        <select id={`${id}-category`} value={definition.settings.category} disabled={!editable}
          aria-describedby={`${id}-category-help`} onChange={(event) => {
            const category = event.currentTarget.value as "marketing" | "transactional";
            onUpdate((draft) => { draft.settings = { ...draft.settings, category }; });
          }}>
          <option value="marketing">{t("marketing")}</option>
          <option value="transactional">{t("transactional")}</option>
        </select>
        <p id={`${id}-category-help`} className="j-inspector-help">
          {definition.settings.category === "marketing" ? t("marketingHelp") : t("transactionalHelp")}
        </p>
      </Field>
    </>
  );
}

function reentryMode(value: unknown): "never" | "always" | "after_days" | "existing" {
  if (value === "never" || value === "always") return value;
  return value !== null && typeof value === "object" && "after_days" in value ? "after_days" : "existing";
}

function ExitSettings({ definition, editable, onUpdate, id }: {
  definition: GraphDefinition; editable: boolean; onUpdate: UpdateDefinition; id: string;
}) {
  const t = useTranslations("journeyEditor.inspector.exit");
  const reentry = definition.settings.reentry;
  const mode = reentryMode(reentry);
  const days = typeof reentry === "object" && reentry !== null ? reentry.after_days : Number.NaN;
  const validDays = Number.isSafeInteger(days) && days > 0 && days <= 106_751;
  const supportsReentry = definition.entry.type === "trigger";
  const reentryEditable = editable && supportsReentry;

  return (
    <>
      <Field id={`${id}-conversion-event`} label={t("conversionEvent")}
        detail={<span className="j-inspector-optional">{t("optional")}</span>}>
        <input id={`${id}-conversion-event`} value={definition.exit?.conversion_event ?? ""}
          disabled={!editable} autoComplete="off" spellCheck={false} placeholder={t("conversionPlaceholder")}
          aria-describedby={`${id}-conversion-help`} onChange={(event) => {
            const conversionEvent = event.currentTarget.value;
            onUpdate((draft) => { draft.exit = { ...draft.exit, conversion_event: conversionEvent || undefined }; });
          }} />
        <p id={`${id}-conversion-help`} className="j-inspector-help">{t("conversionHelp")}</p>
      </Field>
      <div className="j-inspector-divider" />
      <Field id={`${id}-reentry`} label={t("reentry")}>
        <select id={`${id}-reentry`} value={mode} disabled={!reentryEditable}
          aria-describedby={`${id}-reentry-help`} onChange={(event) => {
            if (!reentryEditable) return;
            const value = event.currentTarget.value;
            if (value !== "never" && value !== "always" && value !== "after_days") return;
            onUpdate((draft) => {
              const current = draft.settings.reentry;
              draft.settings = { ...draft.settings, reentry: value === "after_days"
                ? { ...(typeof current === "object" && current !== null ? current : {}),
                  after_days: typeof current === "object" && current !== null && "after_days" in current
                    ? current.after_days : 1 }
                : value };
            });
          }}>
          {mode === "existing" && <option value="existing" disabled>{t("keepExisting")}</option>}
          <option value="never">{t("never")}</option>
          <option value="always">{t("always")}</option>
          <option value="after_days">{t("afterDays")}</option>
        </select>
        <p id={`${id}-reentry-help`} className="j-inspector-help">
          {supportsReentry ? t("reentryHelp") : t("reentryTriggerOnly")}
        </p>
      </Field>
      {mode === "after_days" && (
        <Field id={`${id}-reentry-days`} label={t("reentryDays")}>
          <div className="j-inspector-input-suffix">
            <input id={`${id}-reentry-days`} type="number" min={1} max={106_751} step={1}
              value={Number.isFinite(days) ? days : ""} disabled={!reentryEditable}
              aria-invalid={(supportsReentry && !validDays) || undefined} aria-describedby={`${id}-reentry-days-help`}
              onChange={(event) => {
                if (!reentryEditable) return;
                const afterDays = event.currentTarget.valueAsNumber;
                onUpdate((draft) => {
                  const current = draft.settings.reentry;
                  draft.settings = { ...draft.settings, reentry: {
                    ...(typeof current === "object" && current !== null ? current : {}), after_days: afterDays,
                  } };
                });
              }} />
            <span>{t("daysAfter")}</span>
          </div>
          <p id={`${id}-reentry-days-help`} className={`j-inspector-help${supportsReentry && !validDays ? " j-inspector-error" : ""}`}>
            {!supportsReentry ? t("reentryDaysKept") : validDays ? t("reentryDaysHelp") : t("reentryDaysInvalid")}
          </p>
        </Field>
      )}
      <div className="j-inspector-completion"><span><JourneyIcon name="check" size={20} /></span>
        <div><strong>{t("completionTitle")}</strong><p>{t("completionBody")}</p></div>
      </div>
    </>
  );
}

function MessageSettings({ node, index, editable, onUpdate, id }: {
  node: MessageNode; index: number; editable: boolean; onUpdate: UpdateDefinition; id: string;
}) {
  const t = useTranslations("journeyEditor.inspector.message");
  // 채널은 정확히 하나. 셋 다 비어 있는 새 노드는 푸시로 읽는다.
  const channel: MessageChannel = node.alimtalk ? "alimtalk" : node.email ? "email" : "push";

  function setChannel(next: MessageChannel) {
    if (next === channel) return;
    onUpdate((draft) => {
      const current = draft.nodes[index];
      if (current?.type !== "message") return;
      // 다른 채널의 키를 남기면 messageChannel이 null이 되고 발행 검증이 막힌다.
      draft.nodes[index] = { ...withMessageChannel({ id: current.id, type: "message" }, next), id: current.id };
    });
  }

  return (
    <>
      <Field id={`${id}-channel`} label={t("channel")}>
        <div className="j-inspector-segmented j-inspector-segmented-3" role="group" aria-label={t("channelLabel")}>
          {(["push", "email", "alimtalk"] as const).map((option) => (
            <button key={option} type="button" disabled={!editable} aria-pressed={channel === option}
              className={channel === option ? "is-active" : undefined} onClick={() => setChannel(option)}>
              {t(`channels.${option}`)}
            </button>
          ))}
        </div>
      </Field>
      {channel === "alimtalk"
        ? <AlimtalkMessageFields node={node} index={index} editable={editable} onUpdate={onUpdate} id={id} />
        : channel === "email"
          ? <EmailMessageFields node={node} index={index} editable={editable} onUpdate={onUpdate} id={id} />
          : <PushMessageFields node={node} index={index} editable={editable} onUpdate={onUpdate} id={id} />}
    </>
  );
}

function PushMessageFields({ node, index, editable, onUpdate, id }: {
  node: MessageNode; index: number; editable: boolean; onUpdate: UpdateDefinition; id: string;
}) {
  const t = useTranslations("journeyEditor.inspector.push");
  const title = node.push?.title ?? "";
  const body = node.push?.body ?? "";
  function change(field: "title" | "body", value: string) {
    onUpdate((draft) => {
      const current = draft.nodes[index];
      if (current?.type === "message") {
        // 다른 채널의 키를 남기지 않는다 — 메시지 노드는 정확히 하나의 채널만 채워야 한다.
        draft.nodes[index] = {
          ...current, push: { ...(current.push ?? { title: "", body: "" }), [field]: value },
          email: undefined, alimtalk: undefined,
        };
      }
    });
  }

  return (
    <>
      <Field id={`${id}-push-title`} label={t("title")}
        detail={<span id={`${id}-title-count`} className="j-inspector-counter">{title.length}/256</span>}>
        <input id={`${id}-push-title`} value={title} maxLength={256} disabled={!editable}
          placeholder={t("titlePlaceholder")} aria-describedby={`${id}-title-count`}
          aria-invalid={title.length > 256 || undefined} onChange={(event) => change("title", event.currentTarget.value)} />
      </Field>
      <Field id={`${id}-push-body`} label={t("body")}
        detail={<span id={`${id}-body-count`} className="j-inspector-counter">{body.length}/2,048</span>}>
        <textarea id={`${id}-push-body`} value={body} maxLength={2048} rows={4} disabled={!editable}
          placeholder={t("bodyPlaceholder")} aria-describedby={`${id}-body-count ${id}-variable-help`}
          aria-invalid={body.length > 2048 || undefined} onChange={(event) => change("body", event.currentTarget.value)} />
        <p id={`${id}-variable-help`} className="j-inspector-help j-inspector-variable-help">
          <code>{"{{first_name}}"}</code><span>{t("variableHelp")}</span>
        </p>
      </Field>
      <section className="j-inspector-preview" aria-label={t("previewLabel")}>
        <div className="j-inspector-preview-label"><h3>{t("previewTitle")}</h3><span>PUSH</span></div>
        <div className="j-inspector-phone">
          <div className="j-inspector-phone-status" aria-hidden="true"><span>9:41</span><span className="j-inspector-phone-signal"><i /><i /><i /><b /></span></div>
          <div className="j-inspector-phone-clock" aria-hidden="true">9:41</div>
          <div className="j-inspector-notification">
            <div className="j-inspector-notification-heading">
              <span className="j-inspector-notification-app"><JourneyIcon name="wave" size={15} /></span>
              <span>NudgeOn</span><small>{t("now")}</small>
            </div>
            <strong className={!title ? "j-inspector-preview-placeholder" : undefined}>{title || t("titleFallback")}</strong>
            <p className={!body ? "j-inspector-preview-placeholder" : undefined}>{body || t("bodyFallback")}</p>
          </div>
          <span className="j-inspector-phone-home" aria-hidden="true" />
        </div>
        <p className="j-inspector-preview-caption">{t("caption")}</p>
      </section>
      {(node.push?.image_url || node.push?.deep_link) && (
        <Note>{t("preserved")}</Note>
      )}
    </>
  );
}

/** 이메일 노드 편집 — 제목·HTML {{ }} 개인화 + 발송기(provider) 선택(검증된 것만). */
function EmailMessageFields({ node, index, editable, onUpdate, id }: {
  node: MessageNode; index: number; editable: boolean; onUpdate: UpdateDefinition; id: string;
}) {
  const t = useTranslations("journeyEditor.inspector.email");
  const tz = useTranslations("journeyEditor"); // ZIP 오류 키(zip.*)
  const appId = useAppId();
  const subject = node.email?.subject ?? "";
  const html = node.email?.html ?? "";
  const provider = node.email?.provider ?? "";
  const fileInput = useRef<HTMLInputElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const importGeneration = useRef(0);
  const [sourceMode, setSourceMode] = useState<"html" | "zip">("html");
  const [importedTemplate, setImportedTemplate] = useState<ImportedEmailTemplate | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const creds = useQuery({
    queryKey: ["credentials", appId],
    queryFn: () => api.credentials.list(appId!),
    enabled: !!appId,
  });
  const verified = (creds.data?.credentials ?? []).flatMap((c) =>
    isEmailProvider(c.kind) && c.status === "verified" ? [c.kind] : [],
  );

  function change(patch: Partial<{ subject: string; html: string; provider: EmailProvider | undefined }>) {
    onUpdate((draft) => {
      const current = draft.nodes[index];
      if (current?.type === "message") {
        const base = current.email ?? { subject: "", html: "" };
        draft.nodes[index] = { ...current, email: { ...base, ...patch }, push: undefined, alimtalk: undefined };
      }
    });
  }

  async function readZip(file: File | undefined) {
    if (!file || !editable) return;
    const generation = ++importGeneration.current;
    setSourceMode("zip");
    setSheetOpen(false);
    setImporting(true);
    setImportError(null);
    try {
      const imported = await importEmailTemplateZip(file);
      if (generation !== importGeneration.current) return;
      setImportedTemplate(imported);
      setSheetOpen(true);
    } catch (error) {
      if (generation !== importGeneration.current) return;
      setImportedTemplate(null);
      setSheetOpen(false);
      setImportError(error instanceof EmailTemplateZipError ? tz(error.key, error.params) : error instanceof Error ? error.message : t("zipFailed"));
    } finally {
      if (generation === importGeneration.current) {
        setImporting(false);
        if (fileInput.current) fileInput.current.value = "";
      }
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    void readZip(event.currentTarget.files?.[0]);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    void readZip(event.dataTransfer.files?.[0]);
  }

  function chooseZip() {
    if (editable && !importing) fileInput.current?.click();
  }

  function closeSheet() {
    setSheetOpen(false);
    window.requestAnimationFrame(() => previewButton.current?.focus());
  }

  function chooseAnotherZip() {
    setSheetOpen(false);
    window.requestAnimationFrame(() => fileInput.current?.click());
  }

  const templateApplied = Boolean(importedTemplate && importedTemplate.html === html);

  return (
    <>
      <Field id={`${id}-email-subject`} label={t("subject")}>
        <input id={`${id}-email-subject`} value={subject} maxLength={998} disabled={!editable}
          placeholder={t("subjectPlaceholder")} onChange={(e) => change({ subject: e.currentTarget.value })} />
      </Field>
      <div className="j-inspector-field">
        <div className="j-inspector-label-row">
          <span className="j-inspector-group-label" id={`${id}-email-source-label`}>{t("sourceMode")}</span>
        </div>
        <div className="j-inspector-segmented j-email-source-switch" role="group" aria-labelledby={`${id}-email-source-label`}>
          <button type="button" disabled={!editable} aria-pressed={sourceMode === "html"}
            className={sourceMode === "html" ? "is-active" : undefined} onClick={() => setSourceMode("html")}>{t("htmlMode")}</button>
          <button type="button" disabled={!editable} aria-pressed={sourceMode === "zip"}
            className={sourceMode === "zip" ? "is-active" : undefined} onClick={() => {
              setSourceMode("zip");
              if (importedTemplate) setSheetOpen(true);
            }}>{t("zipMode")}</button>
        </div>
      </div>
      {sourceMode === "html" ? (
        <Field id={`${id}-email-html`} label={t("html")}>
          <textarea id={`${id}-email-html`} value={html} rows={8} disabled={!editable}
            className="j-inspector-code" placeholder={t("htmlPlaceholder")}
            onChange={(e) => change({ html: e.currentTarget.value })} />
          {importedTemplate && <p className="j-inspector-help">{t("importedEditable")}</p>}
        </Field>
      ) : (
        <div className="j-template-import-field">
          <input ref={fileInput} id={`${id}-email-zip`} className="j-template-file-input" type="file" tabIndex={-1} hidden
            accept=".zip,application/zip" disabled={!editable || importing} onChange={onFileChange} />
          {importedTemplate ? (
            <div className="j-template-imported-summary">
              <span className="j-template-imported-icon"><JourneyIcon name="check" size={17} /></span>
              <div><strong>{importedTemplate.archiveName}</strong><p>
                {templateApplied ? t("applied") : t("notApplied")} · {t("fileCount", { count: importedTemplate.fileCount })}
              </p></div>
              <button ref={previewButton} type="button" disabled={!editable} onClick={() => setSheetOpen(true)}>{t("preview")}</button>
            </div>
          ) : (
            <div className={`j-template-dropzone${importError ? " has-error" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
              <span><JourneyIcon name="message" size={20} /></span>
              <strong>{importing ? t("checking") : t("importTitle")}</strong>
              <p>{importing ? t("checkingBody") : t("importBody")}</p>
              <button type="button" className="j-button" disabled={!editable || importing} onClick={chooseZip}>
                {importing ? t("loading") : t("chooseZip")}
              </button>
            </div>
          )}
          {importError && <p className="j-template-import-error" role="alert">{importError}</p>}
          {importedTemplate && <button type="button" className="j-template-change-file" disabled={!editable || importing} onClick={chooseZip}>
            {t("chooseAnother")}
          </button>}
          <p className="j-inspector-help">{t("previewHelp")}</p>
        </div>
      )}
      <Field id={`${id}-email-provider`} label={t("provider")}>
        <select id={`${id}-email-provider`} value={provider} disabled={!editable}
          onChange={(e) => change({ provider: (e.currentTarget.value || undefined) as EmailProvider | undefined })}>
          <option value="">{t("autoProvider")}</option>
          {verified.map((kind) => <option key={kind} value={kind}>{EMAIL_PROVIDER_LABELS[kind]}</option>)}
        </select>
      </Field>
      {verified.length === 0 && (
        <Note>{t("noProvider")}</Note>
      )}
      {sheetOpen && importedTemplate && (
        <JourneyEmailTemplateSheet template={importedTemplate} onCancel={closeSheet}
          onChooseAnother={chooseAnotherZip} onApply={() => {
            change({ html: importedTemplate.html });
            closeSheet();
          }} />
      )}
    </>
  );
}

function DelaySettings({ node, index, last, editable, onUpdate, id }: {
  node: DelayNode; index: number; last: boolean; editable: boolean; onUpdate: UpdateDefinition; id: string;
}) {
  const t = useTranslations("journeyEditor");
  // The parent keys the inspector by selectedId, so each selected delay chooses an exact unit once.
  const [unit, setUnit] = useState(() => durationUnit(node.duration_seconds));
  const amount = node.duration_seconds / unit;
  const valid = Number.isSafeInteger(node.duration_seconds) && node.duration_seconds > 0;
  function setSeconds(seconds: number) {
    onUpdate((draft) => {
      const current = draft.nodes[index];
      if (current?.type === "delay") draft.nodes[index] = { ...current, duration_seconds: seconds };
    });
  }

  return (
    <>
      <div className="j-inspector-duration-fields">
        <Field id={`${id}-duration`} label={t("inspector.delay.duration")}>
          <input id={`${id}-duration`} type="number" min={0} step="any" disabled={!editable}
            value={Number.isFinite(amount) ? amount : ""} placeholder={t("inspector.delay.amountPlaceholder")}
            aria-invalid={!valid || undefined} aria-describedby={`${id}-duration-help`}
            onChange={(event) => setSeconds(event.currentTarget.valueAsNumber * unit)} />
        </Field>
        <Field id={`${id}-duration-unit`} label={t("inspector.delay.unit")}>
          <select id={`${id}-duration-unit`} value={unit} disabled={!editable}
            onChange={(event) => {
              const nextUnit = Number(event.currentTarget.value);
              setUnit(nextUnit);
              setSeconds(amount * nextUnit);
            }}>
            {DURATION_UNITS.map((option) => <option key={option} value={option}>{t(`model.unit.${option}`)}</option>)}
          </select>
        </Field>
      </div>
      <p id={`${id}-duration-help`} className={`j-inspector-help${!valid ? " j-inspector-error" : ""}`}>
        {valid ? t("inspector.delay.help") : t("inspector.delay.invalid")}
      </p>
      <div className={`j-inspector-duration-summary${!valid ? " j-inspector-duration-invalid" : ""}`}>
        <span className="j-inspector-duration-summary-icon"><JourneyIcon name="clock" size={26} /></span>
        <span>{t("inspector.delay.summary")}</span>
        <strong>{valid ? formatDuration(node.duration_seconds, t) : t("inspector.delay.checkTime")}</strong>
        {valid && <small>{t("inspector.delay.totalSeconds", { count: node.duration_seconds })}</small>}
      </div>
      {last && <Note warning>{t("inspector.delay.lastWarning")}</Note>}
    </>
  );
}
