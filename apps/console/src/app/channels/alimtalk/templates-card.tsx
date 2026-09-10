"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { AlimtalkSender, AlimtalkTemplate } from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AD_TEMPLATE_NOTICE_KEY,
  MISSING_IN_VENDOR_NOTICE_KEY,
  isAdMessageType,
  isMissingInVendor,
  messageTypeLabel,
  serverMessage,
  templateStateLabel,
} from "./alimtalk-labels";

/** 동기화는 워커가 비동기로 한다 — 202 직후에는 아직 목록이 그대로다. */
const SYNC_REFETCH_DELAY_MS = 4000;

/**
 * 승인 템플릿 캐시. NudgeOn는 템플릿을 편집하지 않는다 —
 * 알림톡 본문은 카카오 심사를 통과한 것과 정확히 일치해야 하므로 벤더에서 읽어 캐시만 한다.
 */
export function TemplatesCard({
  appId,
  senders,
  onSynced,
}: {
  appId: string | undefined;
  senders: AlimtalkSender[];
  onSynced?: () => void;
}) {
  const t = useTranslations("alimtalk");
  const [senderId, setSenderId] = useState<string>("");
  const [msg, setMsg] = useState<string | null>(null);
  const selected = senderId || senders.find((s) => s.is_default)?.id || senders[0]?.id || "";

  const templates = useQuery({
    queryKey: ["alimtalk-templates", appId, selected],
    queryFn: () => api.alimtalk.templates.list(appId!, selected ? { sender_id: selected } : undefined),
    enabled: !!appId,
  });

  const sync = useMutation({
    mutationFn: () => {
      if (!appId) throw new Error(t("error.noApp"));
      // 보고 있는 발신프로필만 동기화한다 — 미지정이면 서버가 기본 발신프로필을 고른다.
      return api.alimtalk.templates.sync(appId, selected ? { sender_id: selected } : undefined);
    },
    onSuccess: () => {
      setMsg(t("templates.syncRequested"));
      onSynced?.();
      setTimeout(() => void templates.refetch(), SYNC_REFETCH_DELAY_MS);
    },
    // 400은 서버가 무엇이 없는지 한국어로 지목한다(발신프로필·배선·검증된 크리덴셜).
    // 아무것도 못 하는 상태에서 202를 주지 않으려고 일부러 막아둔 것이라 문구를 그대로 보여 준다.
    onError: (e) => setMsg(serverMessage(e, t("templates.syncFailed"))),
  });

  const rows = templates.data?.templates ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 p-4">
        <CardTitle className="text-sm">{t("templates.title")}</CardTitle>
        <Button
          className="h-7 shrink-0 px-2 text-xs"
          disabled={!appId || sync.isPending}
          onClick={() => sync.mutate()}
        >
          {sync.isPending ? t("templates.syncing") : t("templates.sync")}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0 text-sm">
        {senders.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("templates.needSender")}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <label htmlFor="template-sender" className="text-xs">
              {t("senders.title")}
            </label>
            <select
              id="template-sender"
              className="h-9 rounded-md border border-border bg-card px-2 text-sm"
              value={selected}
              onChange={(e) => setSenderId(e.target.value)}
            >
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.channel_name || s.sender_key}
                  {s.is_default ? ` (${t("senders.default")})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {templates.isPending ? (
          <p className="text-xs text-muted-foreground">{t("loading")}</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("templates.empty")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="p-2 font-medium">{t("templates.col.code")}</th>
                  <th className="p-2 font-medium">{t("templates.col.name")}</th>
                  <th className="p-2 font-medium">{t("templates.col.type")}</th>
                  <th className="p-2 font-medium">{t("templates.col.status")}</th>
                  <th className="p-2 font-medium">{t("templates.col.variables")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <TemplateRow key={row.id} template={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {rows.some((row) => isAdMessageType(row.message_type)) && (
          <p className="rounded-md border border-border bg-muted/40 p-2 text-xs">{t(AD_TEMPLATE_NOTICE_KEY)}</p>
        )}
        {rows.some((row) => isMissingInVendor(row.vendor_status)) && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
            {t(MISSING_IN_VENDOR_NOTICE_KEY)} {t("templates.missingKeptNote")}
          </p>
        )}
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}

function TemplateRow({ template }: { template: AlimtalkTemplate }) {
  const t = useTranslations("alimtalk");
  const ad = isAdMessageType(template.message_type);
  const missing = isMissingInVendor(template.vendor_status);
  return (
    <tr className={`border-b border-border align-top ${ad ? "bg-amber-50/60" : ""}`}>
      <td className="p-2">
        <code>{template.template_code}</code>
      </td>
      <td className="p-2">{template.name || t("templates.noName")}</td>
      <td className="p-2">
        {messageTypeLabel(template.message_type, t)}
        {ad && (
          <span className="ml-1 rounded bg-amber-200 px-1 text-[10px] font-medium text-amber-900" title={t(AD_TEMPLATE_NOTICE_KEY)}>
            {t("templates.adBadge")}
          </span>
        )}
      </td>
      <td className="p-2">
        <span
          className={
            missing ? "text-destructive" : template.status === "approved" ? "text-primary" : "text-muted-foreground"
          }
          title={missing ? t(MISSING_IN_VENDOR_NOTICE_KEY) : undefined}
        >
          {templateStateLabel(template.status, template.vendor_status, t)}
        </span>
        {template.vendor_status && !missing && (
          <span className="block text-[10px] text-muted-foreground">{t("templates.vendorStatus", { status: template.vendor_status })}</span>
        )}
      </td>
      <td className="p-2">
        {template.variables.length === 0 ? (
          <span className="text-muted-foreground">{t("templates.noVariables")}</span>
        ) : (
          template.variables.map((v) => (
            <code key={v} className="mr-1 rounded bg-muted px-1">
              {`#{${v}}`}
            </code>
          ))
        )}
      </td>
    </tr>
  );
}
