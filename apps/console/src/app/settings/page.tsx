"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AppSettings } from "@onda/api-client";
import { useAppId } from "../use-app-id";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SettingsPage() {
  const appId = useAppId();
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["app-settings", appId],
    queryFn: () => api.appSettings.get(appId!),
    enabled: !!appId,
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
            ← 대시보드
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">설정</h1>
      </header>

      <div className="flex flex-col gap-4">
        <SecurityCard />
        {form ? (
          <>
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">시간대</CardTitle>
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
              조용시간 (Quiet Hours)
              <Toggle
                on={form.quiet_hours.enabled}
                onChange={(v) => setForm({ ...form, quiet_hours: { ...form.quiet_hours, enabled: v } })}
              />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 p-4 pt-0">
            <div className="flex items-center gap-2 text-sm">
              <Label>시작</Label>
              <Input
                className="w-24"
                value={form.quiet_hours.start}
                onChange={(e) =>
                  setForm({ ...form, quiet_hours: { ...form.quiet_hours, start: e.target.value } })
                }
              />
              <Label>종료</Label>
              <Input
                className="w-24"
                value={form.quiet_hours.end}
                onChange={(e) =>
                  setForm({ ...form, quiet_hours: { ...form.quiet_hours, end: e.target.value } })
                }
              />
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Label>정책</Label>
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
                <option value="delay_until_open">다음 허용 시각에 발송</option>
                <option value="skip">발송 생략</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              거래성(transactional) 메시지는 조용시간을 우회합니다. 정보통신망법 야간 광고 제한
              (21~08시) 준수 장치입니다.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4">
            <CardTitle className="flex items-center justify-between text-sm">
              발송 빈도 제한 (Frequency Cap)
              <Toggle
                on={form.frequency_cap.enabled}
                onChange={(v) =>
                  setForm({ ...form, frequency_cap: { ...form.frequency_cap, enabled: v } })
                }
              />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 p-4 pt-0 text-sm">
            <Label>유저당 최대</Label>
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
            <span>건 / 24시간</span>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "저장 중…" : "저장"}
          </Button>
          {save.isSuccess && <span className="text-sm text-primary">✓ 저장됨</span>}
          {save.isError && <span className="text-sm text-destructive">저장 실패</span>}
        </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">앱 설정 불러오는 중…</p>
        )}
      </div>
    </main>
  );
}

/** 2단계 인증(TOTP) 관리 — 설정·확인·백업코드·해제 (PRD-06 2.1) */
function SecurityCard() {
  const qc = useQueryClient();
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
          2단계 인증 (2FA)
          {enabled != null && (
            <span className={enabled ? "text-xs text-primary" : "text-xs text-muted-foreground"}>
              {enabled ? "사용 중" : "미사용"}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0 text-sm">
        {enabled && step !== "done" && (
          <>
            <p className="text-muted-foreground">
              인증 앱으로 로그인 2단계를 보호하고 있습니다.
            </p>
            <div className="flex items-center gap-2">
              <Input
                className="w-40"
                placeholder="코드로 해제"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
              />
              <Button
                variant="outline"
                disabled={disable.isPending || disableCode.length < 6}
                onClick={() => disable.mutate()}
              >
                2FA 해제
              </Button>
            </div>
            {disable.isError && <span className="text-destructive">코드가 올바르지 않습니다</span>}
          </>
        )}

        {!enabled && step === "idle" && (
          <>
            <p className="text-muted-foreground">
              인증 앱(Google Authenticator 등)으로 로그인 보안을 강화하세요.
            </p>
            <Button
              className="self-start"
              disabled={startEnroll.isPending}
              onClick={() => startEnroll.mutate()}
            >
              2FA 설정
            </Button>
          </>
        )}

        {step === "enroll" && enroll && (
          <>
            <p className="text-muted-foreground">
              인증 앱에 아래 키를 추가한 뒤 6자리 코드를 입력하세요.
            </p>
            <code className="break-all rounded bg-muted p-2 text-xs">{enroll.secret}</code>
            <a className="break-all text-xs text-primary underline" href={enroll.otpauth_uri}>
              otpauth 링크로 추가
            </a>
            <div className="flex items-center gap-2">
              <Input
                className="w-32"
                inputMode="numeric"
                placeholder="6자리 코드"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <Button
                disabled={confirm.isPending || code.length < 6}
                onClick={() => confirm.mutate()}
              >
                확인·활성화
              </Button>
            </div>
            {confirm.isError && <span className="text-destructive">코드가 올바르지 않습니다</span>}
          </>
        )}

        {step === "done" && backupCodes && (
          <>
            <p className="font-medium text-primary">2FA가 활성화되었습니다.</p>
            <p className="text-muted-foreground">
              백업 코드를 안전한 곳에 보관하세요. 각 코드는 1회만 사용됩니다.
            </p>
            <div className="grid grid-cols-2 gap-1 rounded bg-muted p-3 font-mono text-xs">
              {backupCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <Button variant="outline" className="self-start" onClick={() => setStep("idle")}>
              완료
            </Button>
          </>
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
