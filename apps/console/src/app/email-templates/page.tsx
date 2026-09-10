"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ApiError, EMAIL_PROVIDER_LABELS, type EmailProvider, type EmailTemplate, type EmailTemplateSummary } from "@nudgeon/api-client";
import { useAppId } from "../use-app-id";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmailProviderCard, isEmailProvider } from "./email-provider-card";

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
  const t = useTranslations("emailTemplates");
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
        <p className="text-sm text-muted-foreground"><Link href="/" className="underline">{t("backToDashboard")}</Link></p>
        <h1 className="mt-2 text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        <div className="flex flex-col gap-3">
          <EmailProviderCard appId={appId} />
          <Card>
            <CardHeader className="flex flex-row items-center justify-between p-4">
              <CardTitle className="text-sm">{t("list.title")}</CardTitle>
              <Button className="h-7 px-2 text-xs" onClick={() => setSelected("new")}>{t("list.new")}</Button>
            </CardHeader>
            <CardContent className="p-2">
              {list.data?.templates.length === 0 && <p className="p-2 text-xs text-muted-foreground">{t("list.empty")}</p>}
              <ul className="flex flex-col">
                {list.data?.templates.map((tpl: EmailTemplateSummary) => (
                  <li key={tpl.id}>
                    <button
                      className={`w-full rounded px-2 py-2 text-left text-sm hover:bg-muted ${selected === tpl.id ? "bg-muted" : ""}`}
                      onClick={() => setSelected(tpl.id)}
                    >
                      <span className="block font-medium">{tpl.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{tpl.subject}</span>
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
              {t("list.pick")}
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
  const t = useTranslations("emailTemplates");
  const qc = useQueryClient();
  const existing = useQuery({
    queryKey: ["email-template", appId, templateId],
    queryFn: () => api.emailTemplates.get(appId, templateId!),
    enabled: !!templateId,
  });

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState(t("editor.defaultHtml"));
  const [varsText, setVarsText] = useState(t("editor.defaultVars"));
  const [toEmail, setToEmail] = useState("");
  const [provider, setProvider] = useState<"" | EmailProvider>("");
  const [err, setErr] = useState<string | null>(null);

  // 설정(검증)된 이메일 발송기만 선택 가능하도록 목록을 크리덴셜에서 구성.
  const creds = useQuery({
    queryKey: ["credentials", appId],
    queryFn: () => api.credentials.list(appId),
    enabled: !!appId,
  });
  const verifiedProviders = (creds.data?.credentials ?? []).flatMap((c) =>
    isEmailProvider(c.kind) && c.status === "verified" ? [c.kind] : [],
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

  const onErr = (e: unknown) => setErr(e instanceof ApiError ? e.message : t("editor.requestFailed"));

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
    onSuccess: () => setErr(t("test.queued")),
    onError: onErr,
  });

  return (
    <div className="flex flex-col gap-4">
      {err && <p className="rounded-md bg-muted p-3 text-sm">{err}</p>}
      <Card>
        <CardHeader className="p-4"><CardTitle className="text-sm">{templateId ? t("editor.edit") : t("editor.new")}</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 p-4 pt-0">
          <div className="flex flex-col gap-1">
            <Label htmlFor="t-name">{t("editor.name")}</Label>
            <Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="welcome-email" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="t-subject">{t("editor.subject")}</Label>
            <Input id="t-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("editor.subjectPlaceholder")} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="t-html">{t("editor.html")}</Label>
            <textarea id="t-html" className="min-h-[220px] rounded-md border border-border bg-card p-2 font-mono text-xs"
              value={html} onChange={(e) => setHtml(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <Button disabled={save.isPending || !name || !subject || !html} onClick={() => save.mutate()}>
              {save.isPending ? t("editor.saving") : t("editor.save")}
            </Button>
            {templateId && (
              <Button variant="outline" className="text-destructive" disabled={remove.isPending}
                onClick={() => { if (confirm(t("editor.confirmDelete"))) remove.mutate(); }}>{t("editor.delete")}</Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4"><CardTitle className="text-sm">{t("test.title")}</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 p-4 pt-0">
          <div className="flex flex-col gap-1">
            <Label htmlFor="t-vars">{t("test.vars")}</Label>
            <textarea id="t-vars" className="h-16 rounded-md border border-border bg-card p-2 font-mono text-xs"
              value={varsText} onChange={(e) => setVarsText(e.target.value)} />
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{t("test.subjectPreview")} <span className="font-medium text-foreground">{previewSubject}</span></p>
            <iframe title="preview" className="h-[360px] w-full rounded-md border border-border bg-white" sandbox="" srcDoc={previewHtml} />
          </div>
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="t-to">{t("test.to")}</Label>
              <Input id="t-to" type="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} placeholder="me@example.com" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="t-provider">{t("test.provider")}</Label>
              <select id="t-provider" className="h-9 rounded-md border border-border bg-card px-2 text-sm"
                value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
                <option value="">{t("test.autoProvider")}</option>
                {verifiedProviders.map((kind) => (
                  <option key={kind} value={kind}>{EMAIL_PROVIDER_LABELS[kind]}</option>
                ))}
              </select>
            </div>
            <Button variant="outline"
              disabled={testSend.isPending || !toEmail || !subject || !html || verifiedProviders.length === 0}
              onClick={() => testSend.mutate()}>{testSend.isPending ? t("test.sending") : t("test.send")}</Button>
          </div>
          {verifiedProviders.length === 0 ? (
            <p className="text-xs text-destructive">{t("test.noProvider")}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("test.providerHint", { providers: verifiedProviders.map((kind) => EMAIL_PROVIDER_LABELS[kind]).join(", ") })}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
