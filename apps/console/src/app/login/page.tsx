"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ApiError } from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const t = useTranslations("login");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  // 2FA 활성 계정 — 1단계 응답이 totp_required면 2단계 코드 입력으로 전환
  const [needTotp, setNeedTotp] = useState(false);

  const bootstrap = useQuery({ queryKey: ["bootstrap-status"], queryFn: () => api.auth.bootstrapStatus(), staleTime: 60_000 });
  const login = useMutation({
    mutationFn: () => api.auth.login({ email, password, totp: needTotp ? totp : undefined }),
    onSuccess: (result) => {
      if ("totp_required" in result) {
        setNeedTotp(true);
        return;
      }
      // 조직 2FA 강제인데 미등록 — 세션은 발급되었으나 SessionGuard가 등록 완료 전까지
      // /v1/auth/totp 외 모든 접근을 차단한다. 등록 화면으로 강제 이동한다 (T-5, R-09).
      if ("enrollment_required" in result) {
        router.push("/settings?enroll=required");
        return;
      }
      router.push("/");
    },
  });

  const errorMessage =
    login.error instanceof ApiError && login.error.status === 401
      ? needTotp
        ? t("errorTotp")
        : t("errorCredentials")
      : login.error
        ? t("errorGeneric")
        : null;

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>
            {needTotp ? t("subtitleTotp") : t("subtitle")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate();
            }}
          >
            {!needTotp && (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="email">{t("email")}</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="password">{t("password")}</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              </>
            )}
            {needTotp && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="totp">{t("totpCode")}</Label>
                <Input
                  id="totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder={t("totpPlaceholder")}
                  required
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("totpBackupHint")}
                </p>
              </div>
            )}
            {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
            <Button type="submit" disabled={login.isPending}>
              {login.isPending ? t("checking") : needTotp ? t("verify") : t("submit")}
            </Button>
            {needTotp && (
              <button
                type="button"
                className="text-center text-sm text-muted-foreground underline"
                onClick={() => {
                  setNeedTotp(false);
                  setTotp("");
                  login.reset();
                }}
              >
                {t("backToStart")}
              </button>
            )}
            {!needTotp && bootstrap.data?.mode === "single_tenant" && bootstrap.data.state !== "secured" && (
              <p className="text-center text-sm text-muted-foreground">
                {t("installPending")}{" "}
                <a href="/setup" className="text-primary underline">
                  {t("installLink")}
                </a>
              </p>
            )}
            {!needTotp && bootstrap.data?.mode !== "single_tenant" && (
              <p className="text-center text-sm text-muted-foreground">
                {t("noAccount")}{" "}
                <Link href="/signup" className="text-primary underline">
                  {t("signup")}
                </Link>
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
