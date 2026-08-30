"use client";

import { useQuery, useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function DashboardPage() {
  const router = useRouter();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.auth.me(), retry: false });
  const logout = useMutation({
    mutationFn: () => api.auth.logout(),
    onSuccess: () => router.push("/login"),
  });

  useEffect(() => {
    if (me.isError) router.push("/login");
  }, [me.isError, router]);

  if (me.isPending || me.isError) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">불러오는 중…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Onda 콘솔</h1>
          <p className="text-sm text-muted-foreground">
            {me.data.name} ({me.data.email}) · {me.data.role}
          </p>
        </div>
        <Button variant="outline" onClick={() => logout.mutate()}>
          로그아웃
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>온보딩 위저드</CardTitle>
          <CardDescription>
            S2에서 열립니다 — SDK 설치 → 크리덴셜 등록 → 첫 이벤트 감지 → 테스트 발송 (PRD-05 3.1)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            지금은 가입 시 발급된 SDK Key로 <code>POST /v1/track</code> 수집을 시작할 수 있습니다.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
