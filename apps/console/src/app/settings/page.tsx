"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { AppSettings } from "@nudgeon/api-client";
import { useAppId } from "../use-app-id";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// useSearchParams는 Suspense 경계 안에서 호출해야 정적 프리렌더가 CSR로 안전히 폴백한다(Next 15).
export default function SettingsPage() {
  const t = useTranslations("settings");
  return (
    <Suspense fallback={<main className="mx-auto max-w-2xl p-8"><p className="text-sm text-muted-foreground">{t("loading")}</p></main>}>
      <SettingsInner />
    </Suspense>
  );
}

function SettingsInner() {
  const t = useTranslations("settings");
  const appId = useAppId();
  const qc = useQueryClient();
  // 조직 2FA 강제 등록 흐름 (R-09): 로그인이 enrollment_required면 ?enroll=required로 진입.
  // 이 경우 등록 완료 전까지 SessionGuard가 앱 설정 API를 차단하므로 등록 카드만 노출한다.
  const forcedEnroll = useSearchParams().get("enroll") === "required";
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.auth.me(), retry: false });
  const perms = me.data?.permissions ?? [];
  const settings = useQuery({
    queryKey: ["app-settings", appId],
    queryFn: () => api.appSettings.get(appId!),
    enabled: !!appId && !forcedEnroll,
  });
  const [form, setForm] = useState<AppSettings | null>(null);
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => api.appSettings.update(appId!, form!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app-settings", appId] }),
  });

  return (
    <main className="mx-auto max-w-2xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href="/" className="underline">
            {t("backToDashboard")}
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">{t("title")}</h1>
      </header>

      {forcedEnroll && (
        <div className="mb-4 rounded-md border border-primary/40 bg-primary/10 p-4 text-sm">
          <p className="font-medium">{t("forced.title")}</p>
          <p className="mt-1 text-muted-foreground">
            {t("forced.body")}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <SecurityCard forced={forcedEnroll} />
        {!forcedEnroll && perms.includes("team:write") && (
          <OrgSecurityCard canDelete={perms.includes("tenant:delete")} />
        )}
        {forcedEnroll ? null : form ? (
          <>
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">{t("timezone")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <Input
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              placeholder="Asia/Seoul"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4">
            <CardTitle className="flex items-center justify-between text-sm">
              {t("quiet.title")}
              <Toggle
                on={form.quiet_hours.enabled}
                onChange={(v) => setForm({ ...form, quiet_hours: { ...form.quiet_hours, enabled: v } })}
              />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 p-4 pt-0">
            <div className="flex items-center gap-2 text-sm">
              <Label>{t("quiet.start")}</Label>
              <Input
                className="w-24"
                value={form.quiet_hours.start}
                onChange={(e) =>
                  setForm({ ...form, quiet_hours: { ...form.quiet_hours, start: e.target.value } })
                }
              />
              <Label>{t("quiet.end")}</Label>
              <Input
                className="w-24"
                value={form.quiet_hours.end}
                onChange={(e) =>
                  setForm({ ...form, quiet_hours: { ...form.quiet_hours, end: e.target.value } })
                }
              />
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Label>{t("quiet.policy")}</Label>
              <select
                className="h-9 rounded-md border border-border bg-card px-2 text-sm"
                value={form.quiet_hours.policy}
                onChange={(e) =>
                  setForm({
                    ...form,
                    quiet_hours: {
                      ...form.quiet_hours,
                      policy: e.target.value as "delay_until_open" | "skip",
                    },
                  })
                }
              >
                <option value="delay_until_open">{t("quiet.delay")}</option>
                <option value="skip">{t("quiet.skip")}</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("quiet.note")}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4">
            <CardTitle className="flex items-center justify-between text-sm">
              {t("cap.title")}
              <Toggle
                on={form.frequency_cap.enabled}
                onChange={(v) =>
                  setForm({ ...form, frequency_cap: { ...form.frequency_cap, enabled: v } })
                }
              />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 p-4 pt-0 text-sm">
            <Label>{t("cap.max")}</Label>
            <Input
              className="w-20"
              type="number"
              value={String(form.frequency_cap.max_per_24h)}
              onChange={(e) =>
                setForm({
                  ...form,
                  frequency_cap: { ...form.frequency_cap, max_per_24h: Number(e.target.value) },
                })
              }
            />
            <span>{t("cap.per24h")}</span>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t("saving") : t("save")}
          </Button>
          {save.isSuccess && <span className="text-sm text-primary">{t("saved")}</span>}
          {save.isError && <span className="text-sm text-destructive">{t("saveFailed")}</span>}
        </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("loadingApp")}</p>
        )}
      </div>
    </main>
  );
}

/** 2단계 인증(TOTP) 관리 — 설정·확인·백업코드·해제 (PRD-06 2.1) */
function SecurityCard({ forced = false }: { forced?: boolean }) {
  const t = useTranslations("settings");
  const qc = useQueryClient();
  const router = useRouter();
  const status = useQuery({ queryKey: ["totp-status"], queryFn: () => api.auth.totpStatus() });
  const [step, setStep] = useState<"idle" | "enroll" | "done">("idle");
  const [enroll, setEnroll] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disableCode, setDisableCode] = useState("");

  const startEnroll = useMutation({
    mutationFn: () => api.auth.totpEnroll(),
    onSuccess: (d) => {
      setEnroll(d);
      setStep("enroll");
    },
  });

  // 강제 등록 흐름: 미등록·idle 상태면 자동으로 등록을 시작한다 (사용자 클릭 대기 없이).
  useEffect(() => {
    if (forced && status.data && !status.data.enabled && step === "idle" && !startEnroll.isPending) {
      startEnroll.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forced, status.data, step]);
  const confirm = useMutation({
    mutationFn: () => api.auth.totpEnrollVerify(code),
    onSuccess: (d) => {
      setBackupCodes(d.backup_codes);
      setStep("done");
      setCode("");
      qc.invalidateQueries({ queryKey: ["totp-status"] });
    },
  });
  const disable = useMutation({
    mutationFn: () => api.auth.totpDisable(disableCode),
    onSuccess: () => {
      setDisableCode("");
      qc.invalidateQueries({ queryKey: ["totp-status"] });
    },
  });

  const enabled = status.data?.enabled;

  return (
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="flex items-center justify-between text-sm">
          {t("twofa.title")}
          {enabled != null && (
            <span className={enabled ? "text-xs text-primary" : "text-xs text-muted-foreground"}>
              {enabled ? t("twofa.on") : t("twofa.off")}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0 text-sm">
        {enabled && step !== "done" && (
          <>
            <p className="text-muted-foreground">
              {t("twofa.protected")}
            </p>
            <div className="flex items-center gap-2">
              <Input
                className="w-40"
                placeholder={t("twofa.disablePlaceholder")}
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
              />
              <Button
                variant="outline"
                disabled={disable.isPending || disableCode.length < 6}
                onClick={() => disable.mutate()}
              >
                {t("twofa.disable")}
              </Button>
            </div>
            {disable.isError && <span className="text-destructive">{t("twofa.badCode")}</span>}
          </>
        )}

        {!enabled && step === "idle" && (
          <>
            <p className="text-muted-foreground">
              {t("twofa.intro")}
            </p>
            <Button
              className="self-start"
              disabled={startEnroll.isPending}
              onClick={() => startEnroll.mutate()}
            >
              {t("twofa.setup")}
            </Button>
          </>
        )}

        {step === "enroll" && enroll && (
          <>
            <p className="text-muted-foreground">
              {t("twofa.enrollHint")}
            </p>
            <code className="break-all rounded bg-muted p-2 text-xs">{enroll.secret}</code>
            <a className="break-all text-xs text-primary underline" href={enroll.otpauth_uri}>
              {t("twofa.otpauth")}
            </a>
            <div className="flex items-center gap-2">
              <Input
                className="w-32"
                inputMode="numeric"
                placeholder={t("twofa.codePlaceholder")}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <Button
                disabled={confirm.isPending || code.length < 6}
                onClick={() => confirm.mutate()}
              >
                {t("twofa.confirm")}
              </Button>
            </div>
            {confirm.isError && <span className="text-destructive">{t("twofa.badCode")}</span>}
          </>
        )}

        {step === "done" && backupCodes && (
          <>
            <p className="font-medium text-primary">{t("twofa.activated")}</p>
            <p className="text-muted-foreground">
              {t("twofa.backupHint")}
            </p>
            <div className="grid grid-cols-2 gap-1 rounded bg-muted p-3 font-mono text-xs">
              {backupCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <Button
              variant="outline"
              className="self-start"
              onClick={() => (forced ? router.push("/") : setStep("idle"))}
            >
              {t("twofa.done")}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** 조직 보안 (R-16): 전체 2FA 강제 + 조직 삭제 유예. team:write / tenant:delete 게이팅. */
function OrgSecurityCard({ canDelete }: { canDelete: boolean }) {
  const t = useTranslations("settings");
  const qc = useQueryClient();
  const tenant = useQuery({ queryKey: ["tenant"], queryFn: () => api.tenant.get() });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["tenant"] });

  const set2fa = useMutation({
    mutationFn: (v: boolean) => api.tenant.setRequire2fa(v),
    onSuccess: refresh,
  });
  const requestDeletion = useMutation({
    mutationFn: () => api.tenant.requestDeletion(),
    onSuccess: () => { setConfirmDelete(false); refresh(); },
  });
  const restoreDeletion = useMutation({
    mutationFn: () => api.tenant.restoreDeletion(),
    onSuccess: refresh,
  });

  const pendingDeletion = !!tenant.data?.delete_requested_at;

  return (
    <Card>
      <CardHeader className="p-4"><CardTitle className="text-sm">{t("org.title")}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-4 p-4 pt-0 text-sm">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">{t("org.require2fa")}</p>
            <p className="text-xs text-muted-foreground">
              {t("org.require2faHint")}
            </p>
          </div>
          <Toggle
            on={!!tenant.data?.require_2fa}
            onChange={(v) => set2fa.mutate(v)}
          />
        </div>

        {canDelete && (
          <div className="border-t border-border pt-4">
            <p className="font-medium text-destructive">{t("org.danger")}</p>
            {pendingDeletion ? (
              <div className="mt-2 flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {t("org.scheduled")} {tenant.data?.purge_after
                    ? new Date(tenant.data.purge_after).toISOString().slice(0, 16).replace("T", " ") + " UTC"
                    : "—"}
                </span>
                <Button variant="outline" disabled={restoreDeletion.isPending} onClick={() => restoreDeletion.mutate()}>
                  {t("org.restore")}
                </Button>
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-2">
                <p className="text-xs text-muted-foreground">{t("org.graceHint")}</p>
                {confirmDelete ? (
                  <>
                    <Button variant="outline" className="text-destructive" disabled={requestDeletion.isPending}
                      onClick={() => requestDeletion.mutate()}>{t("org.confirmDelete")}</Button>
                    <Button variant="outline" onClick={() => setConfirmDelete(false)}>{t("org.cancel")}</Button>
                  </>
                ) : (
                  <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
                    {t("org.requestDelete")}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`h-6 w-11 rounded-full transition-colors ${on ? "bg-primary" : "bg-muted"}`}
      onClick={() => onChange(!on)}
    >
      <span
        className={`block h-5 w-5 rounded-full bg-white transition-transform ${on ? "translate-x-5" : "translate-x-0.5"}`}
      />
    </button>
  );
}
