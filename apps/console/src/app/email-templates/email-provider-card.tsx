"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, EMAIL_PROVIDER_LABELS, EMAIL_PROVIDERS, type EmailProvider } from "@onda/api-client";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** 발송기 프리셋 — smtp/ses/resend_smtp는 email_smtp 크리덴셜, nhn/resend는 각 API 크리덴셜 */
type Preset = "smtp" | "ses" | "resend_smtp" | "nhn" | "resend";

const PRESET_LABELS: Record<Preset, string> = {
  smtp: "범용 SMTP",
  ses: "AWS SES (SMTP)",
  resend_smtp: "Resend (SMTP)",
  nhn: "NHN Cloud (API)",
  resend: "Resend (API)",
};

/** Resend 웹훅에서 켜야 하는 이벤트 — 서버 매핑(resend-webhook.service.ts)과 동일 목록 */
export const RESEND_WEBHOOK_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
  "email.failed",
] as const;

/** 콘솔이 안내하는 Resend 웹훅 URL — API의 POST /v1/webhooks/resend/:appId */
export function resendWebhookUrl(apiUrl: string, appId: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/v1/webhooks/resend/${appId}`;
}

export function isEmailProvider(kind: string): kind is EmailProvider {
  return (EMAIL_PROVIDERS as readonly string[]).includes(kind);
}

/**
 * 이메일 발송기 등록 카드 — 온보딩 2단계·이메일 템플릿 페이지 공용.
 * 프리셋: 범용 SMTP / AWS SES(SMTP) / Resend(SMTP) / NHN Cloud(API) / Resend(API).
 */
export function EmailProviderCard({ appId, onSaved }: { appId: string | undefined; onSaved?: () => void }) {
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
    onSuccess: () => { setMsg("등록됨 — 워커가 검증 중(수 초). 상태는 목록에서 확인"); creds.refetch(); onSaved?.(); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : "등록 실패"),
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
      <CardHeader className="p-4"><CardTitle className="text-sm">이메일 발송기</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2 p-4 pt-0 text-sm">
        {emailCreds.length > 0 && (
          <p className="text-xs">
            등록됨:{" "}
            {emailCreds.map((c, i) => (
              <span key={c.kind}>
                {i > 0 && " · "}
                <span className="font-medium">{isEmailProvider(c.kind) ? EMAIL_PROVIDER_LABELS[c.kind] : c.kind}</span>{" "}
                <span className={c.status === "verified" ? "text-primary" : c.status === "error" ? "text-destructive" : "text-muted-foreground"}>
                  ({c.status === "verified" ? "검증 완료" : c.status === "error" ? "검증 실패" : "검증 중"})
                </span>
              </span>
            ))}
          </p>
        )}
        <select className="h-9 rounded-md border border-border bg-card px-2 text-sm"
          value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
          {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => <option key={p} value={p}>{PRESET_LABELS[p]}</option>)}
        </select>

        {preset === "smtp" && (
          <>
            <Field label="호스트"><Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" /></Field>
            <Field label="포트"><Input value={port} onChange={(e) => setPort(e.target.value)} /></Field>
            <Field label="사용자명"><Input value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
            <Field label="비밀번호"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          </>
        )}
        {preset === "ses" && (
          <>
            <Field label="리전"><Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="ap-northeast-2" /></Field>
            <Field label="SMTP 사용자명(SES)"><Input value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
            <Field label="SMTP 비밀번호(SES)"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          </>
        )}
        {preset === "resend_smtp" && (
          <>
            <p className="text-xs text-muted-foreground">
              호스트 <code>smtp.resend.com</code> · 포트 <code>465</code>(TLS) · 사용자명 <code>resend</code>로 고정됩니다.
            </p>
            <Field label="비밀번호 = Resend API 키"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="re_…" /></Field>
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
            <Field label="Resend API 키"><Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="re_…" /></Field>
            <Field label="웹훅 서명 비밀 (선택 — Signing secret, whsec_…)">
              <Input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="whsec_…" />
            </Field>
            {appId && <ResendWebhookGuide appId={appId} />}
          </>
        )}
        <Field label="발신 이메일"><Input type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="noreply@yourdomain.com" /></Field>
        <Field label="발신 이름"><Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Onda" /></Field>
        <Button className="mt-1" disabled={save.isPending || !canSave} onClick={() => save.mutate()}>
          {save.isPending ? "등록 중…" : "발송기 등록/교체"}
        </Button>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}

/** Resend 대시보드 → Webhooks에 등록할 URL·이벤트 안내 (도달/오픈/클릭/반송 리포트 연결) */
function ResendWebhookGuide({ appId }: { appId: string }) {
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
      <p className="font-medium">Resend 웹훅 등록 (도달·오픈·클릭·반송 집계)</p>
      <p className="mt-1 text-muted-foreground">Resend 대시보드 → Webhooks → Add Endpoint에 아래 URL을 등록하고, 발급된 Signing secret을 위 &lsquo;웹훅 서명 비밀&rsquo;에 넣으세요.</p>
      <div className="mt-1 flex items-center gap-1">
        <code className="flex-1 truncate rounded bg-card px-1 py-0.5">{url}</code>
        <Button type="button" variant="outline" className="h-6 px-2 text-xs" onClick={copy}>{copied ? "복사됨" : "복사"}</Button>
      </div>
      <p className="mt-1 text-muted-foreground">켤 이벤트: {RESEND_WEBHOOK_EVENTS.join(", ")}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
