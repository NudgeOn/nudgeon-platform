"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/** 2단계 인증(TOTP) 관리 — 설정·확인·백업코드·해제 (PRD-06 2.1) */
export function SecurityCard({ forced = false, onComplete }: { forced?: boolean; onComplete?: () => void }) {
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
      setEnroll(null);
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
        {(status.isError || startEnroll.isError) && <p role="alert" className="text-destructive">{t("twofa.loadFailed")}</p>}
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
              disabled={startEnroll.isPending || !status.data}
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
                aria-label={t("twofa.codePlaceholder")}
                autoComplete="one-time-code"
                maxLength={6}
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
              onClick={() => (onComplete ? onComplete() : forced ? router.push("/") : setStep("idle"))}
            >
              {t("twofa.done")}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
