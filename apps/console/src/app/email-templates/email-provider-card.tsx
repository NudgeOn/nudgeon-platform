"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { ApiError, EMAIL_PROVIDER_LABELS, EMAIL_PROVIDERS, type EmailProvider } from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { RESEND_LINKS, RESEND_WEBHOOK_EVENTS, isEmailProvider, resendWebhookUrl } from "./email-provider-links";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export { RESEND_LINKS, RESEND_WEBHOOK_EVENTS, isEmailProvider, resendWebhookUrl };

/** 발송기 프리셋 — smtp/ses/resend_smtp는 email_smtp 크리덴셜, nhn/resend는 각 API 크리덴셜 */
type Preset = "smtp" | "ses" | "resend_smtp" | "nhn" | "resend";

const PRESETS: Preset[] = ["smtp", "ses", "resend_smtp", "nhn", "resend"];

/**
 * 이메일 발송기 등록 카드 — 온보딩 2단계·이메일 템플릿 페이지 공용.
 * 프리셋: 범용 SMTP / AWS SES(SMTP) / Resend(SMTP) / NHN Cloud(API) / Resend(API).
 */
export function EmailProviderCard({ appId, onSaved }: { appId: string | undefined; onSaved?: () => void }) {
  const t = useTranslations("emailTemplates");
  const [preset, setPreset] = useState<Preset>("smtp");
  const [msg, setMsg] = useState<string | null>(null);
  // SMTP 공통
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [region, setRegion] = useState("ap-northeast-2");
  // 발신자 공통
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  // NHN
  const [appKey, setAppKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  // Resend API
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  const creds = useQuery({
    queryKey: ["credentials", appId],
    queryFn: () => api.credentials.list(appId!),
    enabled: !!appId,
  });

  const save = useMutation({
    mutationFn: () => {
      if (!appId) throw new Error("no app");
      if (preset === "nhn") {
        return api.credentials.upsert(appId, {
          kind: "email_nhn", app_key: appKey, secret_key: secretKey, from_email: fromEmail, from_name: fromName,
        });
      }
      if (preset === "resend") {
        return api.credentials.upsert(appId, {
          kind: "email_resend", api_key: apiKey, from_email: fromEmail, from_name: fromName,
          ...(webhookSecret ? { webhook_secret: webhookSecret } : {}),
        });
      }
      if (preset === "resend_smtp") {
        return api.credentials.upsert(appId, {
          kind: "email_smtp", host: "smtp.resend.com", port: 465, username: "resend", password,
          from_email: fromEmail, from_name: fromName, security: "tls",
        });
      }
      const h = preset === "ses" ? `email-smtp.${region}.amazonaws.com` : host;
      return api.credentials.upsert(appId, {
        kind: "email_smtp", host: h, port: Number(port), username, password,
        from_email: fromEmail, from_name: fromName, security: "starttls",
      });
    },
    onSuccess: () => { setMsg(t("provider.registered")); creds.refetch(); onSaved?.(); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : t("provider.registerFailed")),
  });

  const emailCreds = (creds.data?.credentials ?? []).filter((c) => isEmailProvider(c.kind));
  const canSave = !!fromEmail && (
    preset === "nhn" ? !!appKey && !!secretKey
      : preset === "resend" ? !!apiKey
        : preset === "resend_smtp" ? !!password
          : preset === "ses" ? !!username && !!password
            : !!host && !!port
  );

  return (
    <Card>
      <CardHeader className="p-4"><CardTitle className="text-sm">{t("provider.title")}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2 p-4 pt-0 text-sm">
        {emailCreds.length > 0 && (
          <p className="text-xs">
            {t("provider.registeredList")}{" "}
            {emailCreds.map((c, i) => (
              <span key={c.kind}>
                {i > 0 && " · "}
                <span className="font-medium">{isEmailProvider(c.kind) ? EMAIL_PROVIDER_LABELS[c.kind] : c.kind}</span>{" "}
                <span className={c.status === "verified" ? "text-primary" : c.status === "error" ? "text-destructive" : "text-muted-foreground"}>
                  ({c.status === "verified" ? t("provider.status.verified") : c.status === "error" ? t("provider.status.error") : t("provider.status.pending")})
                </span>
              </span>
            ))}
          </p>
        )}
        {emailCreds.filter((c) => c.status === "error" && c.status_detail).map((c) => (
          <p key={c.kind} className="text-xs text-destructive">
            {t("provider.verifyFailed", { provider: isEmailProvider(c.kind) ? EMAIL_PROVIDER_LABELS[c.kind] : c.kind, detail: c.status_detail ?? "" })}{" "}
            {c.kind === "email_resend" && <ExternalLink href={RESEND_LINKS.domains}>{t("provider.resend.checkDomain")}</ExternalLink>}
          </p>
        ))}
        <select className="h-9 rounded-md border border-border bg-card px-2 text-sm"
          value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
          {PRESETS.map((p) => <option key={p} value={p}>{t(`provider.preset.${p}`)}</option>)}
        </select>

        {(preset === "resend" || preset === "resend_smtp") && (
          <div className="rounded-md border border-border bg-muted/40 p-2 text-xs">
            <p className="font-medium">{t("provider.resend.setup")}</p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              <ExternalLink href={RESEND_LINKS.apiKeys}>{t("provider.resend.apiKeys")}</ExternalLink>
              <ExternalLink href={RESEND_LINKS.domains}>{t("provider.resend.domains")}</ExternalLink>
              {preset === "resend" && <ExternalLink href={RESEND_LINKS.webhooks}>{t("provider.resend.webhooks")}</ExternalLink>}
              <ExternalLink href={RESEND_LINKS.emails}>{t("provider.resend.emails")}</ExternalLink>
            </div>
          </div>
        )}

        {preset === "smtp" && (
          <>
            <Field label={t("provider.field.host")}><Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" /></Field>
            <Field label={t("provider.field.port")}><Input value={port} onChange={(e) => setPort(e.target.value)} /></Field>
            <Field label={t("provider.field.username")}><Input value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
            <Field label={t("provider.field.password")}><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          </>
        )}
        {preset === "ses" && (
          <>
            <Field label={t("provider.field.region")}><Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="ap-northeast-2" /></Field>
            <Field label={t("provider.field.sesUsername")}><Input value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
            <Field label={t("provider.field.sesPassword")}><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          </>
        )}
        {preset === "resend_smtp" && (
          <>
            <p className="text-xs text-muted-foreground">
              {t.rich("provider.resend.smtpFixed", { code: (c) => <code>{c}</code> })}
            </p>
            <Field label={t("provider.field.resendSmtpPassword")} action={<ExternalLink href={RESEND_LINKS.apiKeys}>{t("provider.resend.getKey")}</ExternalLink>}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="re_…" />
            </Field>
          </>
        )}
        {preset === "nhn" && (
          <>
            <Field label="App Key"><Input value={appKey} onChange={(e) => setAppKey(e.target.value)} /></Field>
            <Field label="Secret Key"><Input type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} /></Field>
          </>
        )}
        {preset === "resend" && (
          <>
            <Field label={t("provider.field.resendApiKey")} action={<ExternalLink href={RESEND_LINKS.apiKeys}>{t("provider.resend.getKey")}</ExternalLink>}>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="re_…" />
            </Field>
            <Field label={t("provider.field.webhookSecret")}
              action={<ExternalLink href={RESEND_LINKS.webhooks}>{t("provider.resend.setupWebhook")}</ExternalLink>}>
              <Input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="whsec_…" />
            </Field>
            {appId && <ResendWebhookGuide appId={appId} />}
          </>
        )}
        <Field label={t("provider.field.fromEmail")}
          action={(preset === "resend" || preset === "resend_smtp")
            ? <ExternalLink href={RESEND_LINKS.domains}>{t("provider.resend.verifyDomain")}</ExternalLink> : undefined}>
          <Input type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="noreply@yourdomain.com" />
        </Field>
        <Field label={t("provider.field.fromName")}><Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="NudgeOn" /></Field>
        <Button className="mt-1" disabled={save.isPending || !canSave} onClick={() => save.mutate()}>
          {save.isPending ? t("provider.registering") : t("provider.register")}
        </Button>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}

/** Resend 대시보드 → Webhooks에 등록할 URL·이벤트 안내 (도달/오픈/클릭/반송 리포트 연결) */
function ResendWebhookGuide({ appId }: { appId: string }) {
  const t = useTranslations("emailTemplates");
  const [copied, setCopied] = useState(false);
  const url = resendWebhookUrl(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080", appId);
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
      <p className="mt-1 text-muted-foreground">{t("webhook.guide")}</p>
      <div className="mt-1 flex items-center gap-1">
        <code className="flex-1 truncate rounded bg-card px-1 py-0.5" title={url}>{url}</code>
        <Button type="button" variant="outline" className="h-6 px-2 text-xs" onClick={copy}>{copied ? t("webhook.copied") : t("webhook.copy")}</Button>
      </div>
      <p className="mt-1 text-muted-foreground">{t("webhook.events", { events: RESEND_WEBHOOK_EVENTS.join(", ") })}</p>
      <p className="mt-1"><ExternalLink href={RESEND_LINKS.webhooks}>{t("webhook.open")}</ExternalLink></p>
    </div>
  );
}

function Field({ label, action, children }: { label: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">{label}</Label>
        {action}
      </div>
      {children}
    </div>
  );
}

/** 외부 콘솔로 나가는 링크 — 항상 새 탭, 아이콘으로 이탈을 알린다. */
function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  const t = useTranslations("emailTemplates");
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-primary underline-offset-2 hover:underline">
      {children}
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <path d="M15 3h6v6" />
        <path d="M10 14 21 3" />
      </svg>
      <span className="sr-only">{t("externalLink")}</span>
    </a>
  );
}
