"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { ApiError } from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  // 2FA 활성 계정 — 1단계 응답이 totp_required면 2단계 코드 입력으로 전환
  const [needTotp, setNeedTotp] = useState(false);

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
        ? "인증 코드가 올바르지 않거나 잠금되었습니다"
        : "이메일 또는 비밀번호가 올바르지 않습니다"
      : login.error
        ? "로그인에 실패했습니다. 잠시 후 다시 시도해주세요."
        : null;

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>NudgeOn 콘솔</CardTitle>
          <CardDescription>
            {needTotp ? "인증 앱의 6자리 코드를 입력하세요" : "계정으로 로그인하세요"}
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
                  <Label htmlFor="email">이메일</Label>
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
                  <Label htmlFor="password">비밀번호</Label>
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
                <Label htmlFor="totp">인증 코드</Label>
                <Input
                  id="totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder="6자리 코드 또는 백업 코드"
                  required
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  기기를 분실했다면 백업 코드(XXXXX-XXXXX)를 입력하세요.
                </p>
              </div>
            )}
            {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
            <Button type="submit" disabled={login.isPending}>
              {login.isPending ? "확인 중…" : needTotp ? "인증" : "로그인"}
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
                ← 처음으로
              </button>
            )}
            {!needTotp && (
              <p className="text-center text-sm text-muted-foreground">
                계정이 없나요?{" "}
                <Link href="/signup" className="text-primary underline">
                  가입하기
                </Link>
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
