"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ApiError, type EmailTemplate, type EmailTemplateSummary } from "@onda/api-client";
import { useAppId } from "../use-app-id";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** {{ key }} 치환 — 서버 util/template.ts·워커 render.go와 동일 규약(미리보기·발송 결과 일치). */
function renderVars(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) => vars[k] ?? "");
}
function parseVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export default function EmailTemplatesPage() {
  const appId = useAppId();
  const [selected, setSelected] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["email-templates", appId],
    queryFn: () => api.emailTemplates.list(appId!),
    enabled: !!appId,
  });

  return (
    <main className="mx-auto max-w-6xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground"><Link href="/" className="underline">← 대시보드</Link></p>
        <h1 className="mt-2 text-2xl font-bold">이메일 템플릿</h1>
        <p className="text-sm text-muted-foreground">HTML 템플릿 · {`{{변수}}`} 개인화 · 실시간 미리보기 · 테스트 발송</p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        <div className="flex flex-col gap-3">
          <ProviderCard appId={appId} />
          <Card>
            <CardHeader className="flex flex-row items-center justify-between p-4">
              <CardTitle className="text-sm">템플릿</CardTitle>
              <Button className="h-7 px-2 text-xs" onClick={() => setSelected("new")}>+ 새 템플릿</Button>
            </CardHeader>
            <CardContent className="p-2">
              {list.data?.templates.length === 0 && <p className="p-2 text-xs text-muted-foreground">템플릿이 없습니다.</p>}
              <ul className="flex flex-col">
                {list.data?.templates.map((t: EmailTemplateSummary) => (
                  <li key={t.id}>
                    <button
                      className={`w-full rounded px-2 py-2 text-left text-sm hover:bg-muted ${selected === t.id ? "bg-muted" : ""}`}
                      onClick={() => setSelected(t.id)}
                    >
                      <span className="block font-medium">{t.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{t.subject}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <div>
          {appId && selected ? (
            <TemplateEditor
              key={selected}
              appId={appId}
              templateId={selected === "new" ? null : selected}
              onSaved={(id) => { setSelected(id); list.refetch(); }}
              onDeleted={() => { setSelected(null); list.refetch(); }}
            />
          ) : (
            <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
              왼쪽에서 템플릿을 선택하거나 새로 만드세요.
            </CardContent></Card>
          )}
        </div>
      </div>
    </main>
  );
}

function TemplateEditor({
  appId, templateId, onSaved, onDeleted,
}: { appId: string; templateId: string | null; onSaved: (id: string) => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const existing = useQuery({
    queryKey: ["email-template", appId, templateId],
    queryFn: () => api.emailTemplates.get(appId, templateId!),
    enabled: !!templateId,
  });

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("<h1>안녕하세요 {{name}}님</h1>\n<p>Onda에 오신 것을 환영합니다.</p>");
  const [varsText, setVarsText] = useState("name=홍길동");
  const [toEmail, setToEmail] = useState("");
  const [provider, setProvider] = useState<"" | "email_smtp" | "email_nhn">("");
  const [err, setErr] = useState<string | null>(null);

  // 설정(검증)된 이메일 발송기만 선택 가능하도록 목록을 크리덴셜에서 구성.
  const creds = useQuery({
    queryKey: ["credentials", appId],
    queryFn: () => api.credentials.list(appId),
    enabled: !!appId,
  });
  const verifiedProviders = (creds.data?.credentials ?? []).filter(
    (c) => (c.kind === "email_smtp" || c.kind === "email_nhn") && c.status === "verified",
  );

  useEffect(() => {
    if (existing.data) {
      setName(existing.data.name);
      setSubject(existing.data.subject);
      setHtml(existing.data.html);
    }
  }, [existing.data]);

  const vars = useMemo(() => parseVars(varsText), [varsText]);
  const previewHtml = useMemo(() => renderVars(html, vars), [html, vars]);
  const previewSubject = useMemo(() => renderVars(subject, vars), [subject, vars]);

  const onErr = (e: unknown) => setErr(e instanceof ApiError ? e.message : "요청 실패");

  const save = useMutation({
    mutationFn: () =>
      templateId
        ? api.emailTemplates.update(appId, templateId, { name, subject, html }).then(() => ({ id: templateId }))
        : api.emailTemplates.create(appId, { name, subject, html }),
    onSuccess: (r) => { setErr(null); qc.invalidateQueries({ queryKey: ["email-template", appId] }); onSaved(r.id); },
    onError: onErr,
  });
  const remove = useMutation({
    mutationFn: () => api.emailTemplates.remove(appId, templateId!),
    onSuccess: () => { setErr(null); onDeleted(); },
    onError: onErr,
  });
  const testSend = useMutation({
    mutationFn: () =>
      api.email.test(appId, {
        to_email: toEmail,
        template_id: templateId ?? undefined,
        subject,
        html,
        provider: provider || undefined,
        variables: vars,
      }),
    onSuccess: () => setErr("테스트 발송 큐 적재 완료 — 메일함/발송기 로그 확인"),
    onError: onErr,
  });

  return (
    <div className="flex flex-col gap-4">
      {err && <p className="rounded-md bg-muted p-3 text-sm">{err}</p>}
      <Card>
        <CardHeader className="p-4"><CardTitle className="text-sm">{templateId ? "템플릿 편집" : "새 템플릿"}</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 p-4 pt-0">
          <div className="flex flex-col gap-1">
            <Label htmlFor="t-name">이름</Label>
            <Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="welcome-email" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="t-subject">제목 ({`{{변수}}`} 가능)</Label>
            <Input id="t-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="{{name}}님, 환영합니다" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="t-html">HTML 본문 ({`{{변수}}`} 가능)</Label>
            <textarea id="t-html" className="min-h-[220px] rounded-md border border-border bg-card p-2 font-mono text-xs"
              value={html} onChange={(e) => setHtml(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <Button disabled={save.isPending || !name || !subject || !html} onClick={() => save.mutate()}>
              {save.isPending ? "저장 중…" : "저장"}
            </Button>
            {templateId && (
              <Button variant="outline" className="text-destructive" disabled={remove.isPending}
                onClick={() => { if (confirm("템플릿을 삭제할까요?")) remove.mutate(); }}>삭제</Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4"><CardTitle className="text-sm">미리보기 · 테스트 발송</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 p-4 pt-0">
          <div className="flex flex-col gap-1">
            <Label htmlFor="t-vars">미리보기 변수 (key=value, 줄바꿈)</Label>
            <textarea id="t-vars" className="h-16 rounded-md border border-border bg-card p-2 font-mono text-xs"
              value={varsText} onChange={(e) => setVarsText(e.target.value)} />
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">제목 미리보기: <span className="font-medium text-foreground">{previewSubject}</span></p>
            <iframe title="preview" className="h-[360px] w-full rounded-md border border-border bg-white" sandbox="" srcDoc={previewHtml} />
          </div>
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="t-to">테스트 수신 이메일</Label>
              <Input id="t-to" type="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} placeholder="me@example.com" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="t-provider">발송기</Label>
              <select id="t-provider" className="h-9 rounded-md border border-border bg-card px-2 text-sm"
                value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
                <option value="">자동(활성 발송기)</option>
                {verifiedProviders.map((c) => (
                  <option key={c.kind} value={c.kind}>{c.kind}</option>
                ))}
              </select>
            </div>
            <Button variant="outline"
              disabled={testSend.isPending || !toEmail || !subject || !html || verifiedProviders.length === 0}
              onClick={() => testSend.mutate()}>{testSend.isPending ? "발송 중…" : "테스트 발송"}</Button>
          </div>
          {verifiedProviders.length === 0 ? (
            <p className="text-xs text-destructive">검증된 이메일 발송기가 없습니다 — 왼쪽 &lsquo;이메일 발송기&rsquo;에서 먼저 등록·검증하세요.</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              발송기를 선택하지 않으면 활성(최근 검증) 발송기로 나갑니다. 설정된 발송기: {verifiedProviders.map((c) => c.kind).join(", ")}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type Provider = "smtp" | "ses" | "nhn";

/** 이메일 발송기 등록 — 프리셋: 범용 SMTP / AWS SES(SMTP) / NHN Cloud(API). */
function ProviderCard({ appId }: { appId: string | undefined }) {
  const [provider, setProvider] = useState<Provider>("smtp");
  const [msg, setMsg] = useState<string | null>(null);
  // SMTP/SES 공통 필드
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [region, setRegion] = useState("ap-northeast-2");
  // NHN
  const [appKey, setAppKey] = useState("");
  const [secretKey, setSecretKey] = useState("");

  const creds = useQuery({
    queryKey: ["credentials", appId],
    queryFn: () => api.credentials.list(appId!),
    enabled: !!appId,
  });

  const save = useMutation({
    mutationFn: () => {
      if (!appId) throw new Error("no app");
      if (provider === "nhn") {
        return api.credentials.upsert(appId, {
          kind: "email_nhn", app_key: appKey, secret_key: secretKey, from_email: fromEmail, from_name: fromName,
        });
      }
      const h = provider === "ses" ? `email-smtp.${region}.amazonaws.com` : host;
      return api.credentials.upsert(appId, {
        kind: "email_smtp", host: h, port: Number(port), username, password,
        from_email: fromEmail, from_name: fromName, security: "starttls",
      });
    },
    onSuccess: () => { setMsg("등록됨 — 워커가 검증 중(수 초). 상태는 목록에서 확인"); creds.refetch(); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : "등록 실패"),
  });

  const emailCred = creds.data?.credentials.find((c) => c.kind === "email_smtp" || c.kind === "email_nhn");

  return (
    <Card>
      <CardHeader className="p-4"><CardTitle className="text-sm">이메일 발송기</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2 p-4 pt-0 text-sm">
        {emailCred && (
          <p className="text-xs">
            현재: <span className="font-medium">{emailCred.kind}</span> ·{" "}
            <span className={emailCred.status === "verified" ? "text-primary" : "text-muted-foreground"}>{emailCred.status}</span>
          </p>
        )}
        <select className="h-9 rounded-md border border-border bg-card px-2 text-sm"
          value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
          <option value="smtp">범용 SMTP</option>
          <option value="ses">AWS SES (SMTP)</option>
          <option value="nhn">NHN Cloud (API)</option>
        </select>

        {provider !== "nhn" ? (
          <>
            {provider === "ses" ? (
              <Field label="리전"><Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="ap-northeast-2" /></Field>
            ) : (
              <>
                <Field label="호스트"><Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" /></Field>
                <Field label="포트"><Input value={port} onChange={(e) => setPort(e.target.value)} /></Field>
              </>
            )}
            <Field label={provider === "ses" ? "SMTP 사용자명(SES)" : "사용자명"}><Input value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
            <Field label={provider === "ses" ? "SMTP 비밀번호(SES)" : "비밀번호"}><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          </>
        ) : (
          <>
            <Field label="App Key"><Input value={appKey} onChange={(e) => setAppKey(e.target.value)} /></Field>
            <Field label="Secret Key"><Input type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} /></Field>
          </>
        )}
        <Field label="발신 이메일"><Input type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="noreply@yourdomain.com" /></Field>
        <Field label="발신 이름"><Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Onda" /></Field>
        <Button className="mt-1" disabled={save.isPending || !fromEmail} onClick={() => save.mutate()}>
          {save.isPending ? "등록 중…" : "발송기 등록/교체"}
        </Button>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
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
