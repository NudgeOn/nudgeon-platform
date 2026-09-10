"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { AlimtalkContent, MessageNode } from "@nudgeon/journey-model";
import { api } from "@/lib/api";
import { useAppId } from "../use-app-id";
import {
  AD_TEMPLATE_NOTICE_KEY,
  MISSING_IN_VENDOR_NOTICE_KEY,
  isAdMessageType,
  isMissingInVendor,
  messageTypeLabel,
  templateBlockReason,
} from "../channels/alimtalk/alimtalk-labels";
import type { GraphDefinition } from "./journey-graph";
import {
  isProfileReference,
  renderTemplatePreview,
  staleVariables,
  templateVariables,
  unmappedVariables,
} from "./alimtalk-variables";
import { JourneyIcon } from "./journey-ui";

const EMPTY_ALIMTALK: AlimtalkContent = { sender_id: "", template_code: "" };

/**
 * 저니 알림톡 노드 편집.
 *
 * 본문은 편집하지 않는다 — 알림톡은 카카오 심사를 통과한 템플릿과 정확히 일치해야 하므로,
 * 승인 템플릿을 고르고 치환자만 매핑한다.
 * 발송 벤더는 노드가 아니라 앱의 채널 배선이 정한다: 벤더를 바꿔도 저니를 다시 쓰지 않아도 된다.
 */
export function AlimtalkMessageFields({
  node,
  index,
  editable,
  onUpdate,
  id,
}: {
  node: MessageNode;
  index: number;
  editable: boolean;
  onUpdate: (mutator: (definition: GraphDefinition) => void) => void;
  id: string;
}) {
  const t = useTranslations("journeyEditor.alimtalk");
  const ta = useTranslations("alimtalk"); // 채널 화면과 공유하는 라벨(alimtalk-labels.ts)
  const appId = useAppId();
  const content = node.alimtalk ?? EMPTY_ALIMTALK;

  const senders = useQuery({
    queryKey: ["alimtalk-senders", appId],
    queryFn: () => api.alimtalk.senders.list(appId!),
    enabled: !!appId,
  });
  const templates = useQuery({
    queryKey: ["alimtalk-templates", appId, content.sender_id],
    queryFn: () => api.alimtalk.templates.list(appId!, { sender_id: content.sender_id }),
    enabled: !!appId && !!content.sender_id,
  });

  const senderList = senders.data?.senders ?? [];
  const templateList = templates.data?.templates ?? [];
  const template = templateList.find((item) => item.template_code === content.template_code) ?? null;
  // 저장된 템플릿 코드가 캐시에 없다 — 벤더에서 지워졌거나 발신프로필이 바뀐 저니다.
  const orphaned = !!content.template_code && !template && !templates.isPending && templateList.length > 0;
  const blockReason = template ? templateBlockReason(template.status, template.vendor_status, ta) : null;
  const variables = templateVariables(template);
  const missing = unmappedVariables(variables, content.variables);
  const stale = staleVariables(variables, content.variables);

  function change(patch: Partial<AlimtalkContent>) {
    onUpdate((draft) => {
      const current = draft.nodes[index];
      if (current?.type !== "message") return;
      // 채널은 정확히 하나 — 알림톡을 쓰면 푸시·이메일 키를 남기지 않는다.
      draft.nodes[index] = {
        id: current.id,
        type: "message",
        alimtalk: { ...(current.alimtalk ?? EMPTY_ALIMTALK), ...patch },
      };
    });
  }

  function setVariable(name: string, value: string) {
    const next = { ...(content.variables ?? {}) };
    if (value) next[name] = value;
    else delete next[name];
    change({ variables: next });
  }

  function setFallback(patch: Partial<NonNullable<AlimtalkContent["fallback"]>> | null) {
    if (patch === null) {
      change({ fallback: undefined });
      return;
    }
    change({ fallback: { type: "SMS", text: "", ...(content.fallback ?? {}), ...patch } });
  }

  return (
    <>
      <div className="j-inspector-field">
        <div className="j-inspector-label-row">
          <label htmlFor={`${id}-alimtalk-sender`}>{t("sender")}</label>
        </div>
        <select
          id={`${id}-alimtalk-sender`}
          value={content.sender_id}
          disabled={!editable}
          onChange={(e) => change({ sender_id: e.currentTarget.value, template_code: "", variables: {} })}
        >
          <option value="">{t("chooseSender")}</option>
          {senderList.map((s) => (
            <option key={s.id} value={s.id}>
              {s.channel_name || s.sender_key}
              {s.is_default ? ` ${t("defaultSuffix")}` : ""}
            </option>
          ))}
        </select>
      </div>
      {!senders.isPending && senderList.length === 0 && (
        <InspectorNote>
          {t("noSenders")}
        </InspectorNote>
      )}

      <div className="j-inspector-field">
        <div className="j-inspector-label-row">
          <label htmlFor={`${id}-alimtalk-template`}>{t("template")}</label>
        </div>
        <select
          id={`${id}-alimtalk-template`}
          value={content.template_code}
          disabled={!editable || !content.sender_id}
          onChange={(e) => change({ template_code: e.currentTarget.value, variables: {} })}
        >
          <option value="">{t("chooseTemplate")}</option>
          {templateList.map((item) => {
            const blocked = templateBlockReason(item.status, item.vendor_status, ta);
            return (
              <option key={item.id} value={item.template_code} disabled={blocked !== null}>
                {item.template_code} · {item.name || t("unnamed")}
                {blocked ? ` — ${blocked}` : ""}
              </option>
            );
          })}
        </select>
        {template && (
          <p className="j-inspector-help">
            {t("templateMeta", { type: messageTypeLabel(template.message_type, ta), count: variables.length })}
          </p>
        )}
      </div>
      {content.sender_id && !templates.isPending && templateList.length === 0 && (
        <InspectorNote>
          {t("noTemplates")}
        </InspectorNote>
      )}
      {orphaned && (
        <InspectorNote warning>
          {t.rich("orphaned", { code: content.template_code, c: (chunks) => <code>{chunks}</code> })}
        </InspectorNote>
      )}
      {template && isMissingInVendor(template.vendor_status) ? (
        <InspectorNote warning>{ta(MISSING_IN_VENDOR_NOTICE_KEY)}</InspectorNote>
      ) : (
        blockReason && (
          <InspectorNote warning>
            {t("notApproved", { reason: blockReason })}
          </InspectorNote>
        )
      )}
      {template && isAdMessageType(template.message_type) && (
        <InspectorNote warning>{ta(AD_TEMPLATE_NOTICE_KEY)}</InspectorNote>
      )}

      {template && variables.length > 0 && (
        <div className="j-inspector-field">
          <div className="j-inspector-label-row">
            <span className="j-inspector-group-label" id={`${id}-alimtalk-vars-label`}>
              {t("variableMapping")}
            </span>
          </div>
          <ul className="j-alimtalk-vars" aria-labelledby={`${id}-alimtalk-vars-label`}>
            {variables.map((name) => {
              const value = content.variables?.[name] ?? "";
              return (
                <li key={name} className={`j-alimtalk-var${value.trim() ? "" : " is-unmapped"}`}>
                  <label htmlFor={`${id}-var-${name}`}>
                    <code>{`#{${name}}`}</code>
                  </label>
                  <input
                    id={`${id}-var-${name}`}
                    value={value}
                    disabled={!editable}
                    placeholder={t("variablePlaceholder")}
                    aria-invalid={!value.trim() || undefined}
                    onChange={(e) => setVariable(name, e.currentTarget.value)}
                  />
                  <span className="j-alimtalk-var-kind">
                    {!value.trim() ? t("unmapped") : isProfileReference(value) ? t("profileAttribute") : t("literal")}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="j-inspector-help">
            {t.rich("variableHelp", { c: (chunks) => <code>{chunks}</code> })}
          </p>
        </div>
      )}

      {missing.length > 0 && (
        <InspectorNote warning>
          {t("missingVariables", { list: missing.map((v) => `#{${v}}`).join(" · ") })}
        </InspectorNote>
      )}
      {stale.length > 0 && (
        <InspectorNote>
          {t("staleVariables", { list: stale.join(" · ") })}
        </InspectorNote>
      )}

      {template && (
        <section className="j-inspector-preview" aria-label={t("preview")}>
          <div className="j-inspector-preview-label">
            <h3>{t("preview")}</h3>
            <span>ALIMTALK</span>
          </div>
          <pre className="j-alimtalk-preview">{renderTemplatePreview(template.content, content.variables)}</pre>
          <p className="j-inspector-preview-caption">
            {t.rich("previewCaption", { c: (chunks) => <code>{chunks}</code> })}
          </p>
        </section>
      )}

      <div className="j-inspector-field">
        <div className="j-inspector-label-row">
          <span className="j-inspector-group-label">{t("fallback")}</span>
        </div>
        <label className="j-alimtalk-fallback-toggle">
          <input
            type="checkbox"
            checked={!!content.fallback}
            disabled={!editable}
            onChange={(e) => setFallback(e.currentTarget.checked ? {} : null)}
          />
          <span>{t("fallbackToggle")}</span>
        </label>
        {content.fallback && (
          <>
            <select
              aria-label={t("fallbackType")}
              value={content.fallback.type}
              disabled={!editable}
              onChange={(e) => setFallback({ type: e.currentTarget.value as "SMS" | "LMS" })}
            >
              <option value="SMS">{t("sms")}</option>
              <option value="LMS">{t("lms")}</option>
            </select>
            {content.fallback.type === "LMS" && (
              <input
                aria-label={t("fallbackTitle")}
                value={content.fallback.title ?? ""}
                disabled={!editable}
                placeholder={t("fallbackTitlePlaceholder")}
                onChange={(e) => setFallback({ title: e.currentTarget.value })}
              />
            )}
            <textarea
              aria-label={t("fallbackText")}
              value={content.fallback.text}
              rows={3}
              disabled={!editable}
              placeholder={t("fallbackTextPlaceholder")}
              onChange={(e) => setFallback({ text: e.currentTarget.value })}
            />
            <p className="j-inspector-help">
              {t("fallbackHelp")}
            </p>
          </>
        )}
      </div>

      <InspectorNote>
        {t("vendorNote")}
      </InspectorNote>
    </>
  );
}

/** JourneyInspector의 Note와 같은 모양 — 모듈 밖으로 내보내지 않은 컴포넌트라 여기서 다시 쓴다. */
function InspectorNote({ children, warning = false }: { children: ReactNode; warning?: boolean }) {
  return (
    <div className={`j-inspector-note${warning ? " j-inspector-note-warning" : ""}`}>
      <JourneyIcon name="info" size={16} />
      <p>{children}</p>
    </div>
  );
}
