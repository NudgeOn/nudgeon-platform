"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { ApiError, type SignupResponse } from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    tenant_name: "",
    name: "",
    email: "",
    password: "",
  });
  const [keys, setKeys] = useState<SignupResponse | null>(null);

  const signup = useMutation({
    mutationFn: () => api.auth.signup(form),
    onSuccess: (res) => setKeys(res),
  });

  const errorMessage =
    signup.error instanceof ApiError && signup.error.status === 409
      ? "이미 가입된 이메일입니다"
      : signup.error
        ? "가입에 실패했습니다. 입력값을 확인해주세요."
        : null;

  if (keys) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>가입 완료 — API 키를 보관하세요</CardTitle>
            <CardDescription>
              아래 키는 지금 한 번만 표시됩니다 (재발급은 회전으로만 가능).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>SDK Key (앱에 내장)</Label>
              <code className="break-all rounded-md bg-muted p-3 text-xs">{keys.sdk_key}</code>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Server Key (백엔드 전용 — 비밀)</Label>
              <code className="break-all rounded-md bg-muted p-3 text-xs">{keys.server_key}</code>
            </div>
            <Button onClick={() => router.push("/")}>콘솔로 이동</Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>NudgeOn 시작하기</CardTitle>
          <CardDescription>조직을 만들고 바로 수집을 시작하세요</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              signup.mutate();
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="tenant_name">조직 이름</Label>
              <Input
                id="tenant_name"
                required
                value={form.tenant_name}
                onChange={(e) => setForm({ ...form, tenant_name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">이름</Label>
              <Input
                id="name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">이메일</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">비밀번호 (8자 이상)</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </div>
            {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
            <Button type="submit" disabled={signup.isPending}>
              {signup.isPending ? "생성 중…" : "조직 만들기"}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              이미 계정이 있나요?{" "}
              <Link href="/login" className="text-primary underline">
                로그인
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
