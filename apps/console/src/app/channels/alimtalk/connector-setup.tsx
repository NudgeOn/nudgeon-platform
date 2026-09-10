"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { ChannelConnector, ConnectorCatalogEntry } from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ALIMTALK_CHANNEL } from "./channel";
import { connectorWebhookUrl, reportSummary, serverMessage } from "./alimtalk-labels";
import {
  canSubmit,
  fieldDestination,
  initialValues,
  planConfig,
  planCredential,
  schemaFields,
} from "./connector-schema";
import { SchemaFields } from "./schema-fields";

/** 배선에 저장된 config 중 문자열 값만 폼으로 되돌린다 — 폼 위젯이 다룰 수 있는 형태만 쓴다. */
function savedStringConfig(wired: ChannelConnector | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(wired?.config ?? {})) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * 벤더 설정 입력 — 크리덴셜(비밀)과 채널 배선(config)을 한 번에 저장한다.
 *
 * 폼은 손으로 짜지 않는다: `credentials_schema` · `config_schema`를 그대로 렌더하므로
 * 새 벤더를 매니페스트로 추가해도 콘솔은 그대로다.
 * 부모가 `key={connector.id}`로 렌더해 벤더를 바꾸면 입력값이 초기화된다.
 */
export function ConnectorSetup({
  appId,
  connector,
  wired,
  onSaved,
}: {
  appId: string | undefined;
  connector: ConnectorCatalogEntry;
  wired: ChannelConnector | null;
  onSaved: () => void;
}) {
  const t = useTranslations("alimtalk");
  const credentialFields = useMemo(() => schemaFields(connector.credentials_schema), [connector]);
  const configFields = useMemo(() => schemaFields(connector.config_schema), [connector]);
  const [credentialValues, setCredentialValues] = useState(() => initialValues(credentialFields));
  const [configValues, setConfigValues] = useState(() => ({
    ...initialValues(configFields),
    // 이미 배선돼 있으면 저장된 비(非)비밀 설정을 그대로 보여 준다(비밀은 절대 돌려받지 않는다).
    ...savedStringConfig(wired),
  }));
  const [msg, setMsg] = useState<string | null>(null);

  const plan = planCredential(credentialFields, credentialValues);

  const creds = useQuery({
    queryKey: ["credentials", appId],
    queryFn: () => api.credentials.list(appId!),
    enabled: !!appId,
    // 검증은 채널 워커가 비동기로 한다 — unverified인 동안만 짧게 되묻는다.
    refetchInterval: (query) =>
      (query.state.data?.credentials ?? []).some((c) => c.kind === "alimtalk" && c.status === "unverified")
        ? 5000
        : false,
  });
  const credential = (creds.data?.credentials ?? []).find((c) => c.kind === "alimtalk") ?? null;

  const save = useMutation({
    mutationFn: async () => {
      if (!appId) throw new Error(t("error.noApp"));
      await api.credentials.upsert(appId, {
        kind: "alimtalk",
        connector_id: connector.id,
        // 벤더가 실제로 읽는 이름은 매니페스트가 정한다 — 슬롯 이름으로만 보내면
        // 이름이 다른 벤더(NHN의 app_key)가 "필드 누락"으로 검증에서 떨어진다.
        extra: plan.extra,
        // 슬롯은 흔한 이름을 위한 호환이라 매핑되는 필드가 없으면 아예 보내지 않는다.
        ...plan.credential,
      });
      await api.alimtalk.connector.put(appId, ALIMTALK_CHANNEL, {
        connector_id: connector.id,
        config: planConfig(configFields, configValues),
        enabled: true,
      });
    },
    onSuccess: () => {
      setMsg(t("setup.saved"));
      void creds.refetch();
      onSaved();
    },
    onError: (e) => setMsg(serverMessage(e, t("setup.saveFailed"))),
  });

  const toggle = useMutation({
    mutationFn: () => {
      if (!appId || !wired) throw new Error(t("error.noWiring"));
      return api.alimtalk.connector.put(appId, ALIMTALK_CHANNEL, {
        connector_id: wired.connector_id,
        config: wired.config,
        enabled: !wired.enabled,
      });
    },
    onSuccess: () => {
      setMsg(wired?.enabled ? t("setup.stopped") : t("setup.resumed"));
      onSaved();
    },
    onError: (e) => setMsg(serverMessage(e, t("setup.changeFailed"))),
  });

  const blocked = !canSubmit(plan);

  return (
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="text-sm">{t("setup.title", { name: connector.name })}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0 text-sm">
        <VendorSummary connector={connector} />

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium">{t("setup.credentials")}</p>
          {credentialFields.length === 0 ? (
            <p className="text-xs text-destructive">
              {t("setup.noCredentialSchema")}
            </p>
          ) : (
            <SchemaFields
              fields={credentialFields}
              values={credentialValues}
              idPrefix={`cred-${connector.id}`}
              disabled={save.isPending}
              hint={(field) => { const d = fieldDestination(field); return t(d.key, d.params); }}
              onChange={(name, value) => setCredentialValues((v) => ({ ...v, [name]: value }))}
            />
          )}
        </div>

        {configFields.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium">{t("setup.config")}</p>
            <SchemaFields
              fields={configFields}
              values={configValues}
              idPrefix={`conf-${connector.id}`}
              disabled={save.isPending}
              onChange={(name, value) => setConfigValues((v) => ({ ...v, [name]: value }))}
            />
          </div>
        )}

        {plan.empty && plan.missingRequired.length === 0 && (
          <p className="text-xs text-destructive">{t("setup.nothingToSave")}</p>
        )}
        {plan.missingRequired.length > 0 && (
          <p className="text-xs text-muted-foreground">{t("setup.required", { fields: plan.missingRequired.join(" · ") })}</p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button disabled={!appId || save.isPending || blocked} onClick={() => save.mutate()}>
            {save.isPending ? t("setup.saving") : wired?.connector_id === connector.id ? t("setup.save") : t("setup.wire")}
          </Button>
          {wired?.connector_id === connector.id && (
            <Button variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
              {wired.enabled ? t("setup.stop") : t("setup.resume")}
            </Button>
          )}
        </div>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}

        <VerificationStatus
          status={credential?.status ?? null}
          detail={credential?.status_detail ?? null}
          pending={creds.isPending}
        />

        {connector.callback_path ? (
          <WebhookGuide appId={appId} connector={connector} />
        ) : (
          <p className="rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
            {t("setup.pollingNote")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** 벤더가 무엇을 보고하는지 — 리포트에서 "미지원"과 "0건"을 가르는 근거를 설정 화면에서 미리 밝힌다. */
function VendorSummary({ connector }: { connector: ConnectorCatalogEntry }) {
  const t = useTranslations("alimtalk");
  return (
    <div className="rounded-md border border-border bg-muted/40 p-2 text-xs">
      <p>
        <span className="font-medium">{connector.vendor.name || t("summary.unknownVendor")}</span> ·{" "}
        {t("summary.version", { version: connector.version })} ·{" "}
        {connector.runtime === "in_process_go" ? t("summary.inProcess") : t("summary.remoteHttp")}
      </p>
      {connector.description && <p className="mt-1 text-muted-foreground">{connector.description}</p>}
      <p className="mt-1">{reportSummary(connector.reports, t)}</p>
      {connector.vendor.url && (
        <p className="mt-1">
          <ExternalLink href={connector.vendor.url}>{t("summary.openConsole")}</ExternalLink>
          {connector.vendor.support && (
            <>
              {" · "}
              <ExternalLink href={connector.vendor.support}>{t("summary.docs")}</ExternalLink>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** 검증은 워커가 비동기로 한다 — 저장 직후 "검증 중"이 정상이다. */
function VerificationStatus({
  status,
  detail,
  pending,
}: {
  status: "unverified" | "verified" | "error" | null;
  detail: string | null;
  pending: boolean;
}) {
  const t = useTranslations("alimtalk");
  if (pending) return <p className="text-xs text-muted-foreground">{t("verify.checking")}</p>;
  if (!status) return <p className="text-xs text-muted-foreground">{t("verify.none")}</p>;
  return (
    <p className="text-xs">
      {t("verify.label")}{" "}
      <span
        className={
          status === "verified" ? "text-primary" : status === "error" ? "text-destructive" : "text-muted-foreground"
        }
      >
        {status === "verified" ? t("verify.verified") : status === "error" ? t("verify.error") : t("verify.pending")}
      </span>
      {status === "error" && detail && <span className="text-destructive"> — {detail}</span>}
    </p>
  );
}

/** 콜백형 벤더에만 보인다. 폴링형에는 등록할 URL이 없어 빈 상자를 띄우지 않는다. */
function WebhookGuide({ appId, connector }: { appId: string | undefined; connector: ConnectorCatalogEntry }) {
  const t = useTranslations("alimtalk");
  const [copied, setCopied] = useState(false);
  if (!appId) return null;
  const url = connectorWebhookUrl(
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080",
    appId,
    connector.id,
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="rounded-md border border-border bg-muted/40 p-2 text-xs">
      <p className="font-medium">{t("webhook.title")}</p>
      <p className="mt-1 text-muted-foreground">
        {t("webhook.hint")}
      </p>
      <div className="mt-1 flex items-center gap-1">
        <code className="flex-1 truncate rounded bg-card px-1 py-0.5" title={url}>
          {url}
        </code>
        <Button type="button" variant="outline" className="h-6 px-2 text-xs" onClick={copy}>
          {copied ? t("webhook.copied") : t("webhook.copy")}
        </Button>
      </div>
    </div>
  );
}

/** 외부 콘솔로 나가는 링크 — 항상 새 탭, 아이콘으로 이탈을 알린다. */
export function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  const t = useTranslations("alimtalk");
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-primary underline-offset-2 hover:underline"
    >
      {children}
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-3 w-3 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <path d="M15 3h6v6" />
        <path d="M10 14 21 3" />
      </svg>
      <span className="sr-only">{t("externalLink.newTab")}</span>
    </a>
  );
}
