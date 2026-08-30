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
          <CardTitle>시작하기</CardTitle>
          <CardDescription>
            SDK Key → 크리덴셜 등록 → 첫 이벤트 감지 → 테스트 발송 (4단계)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => router.push("/onboarding")}>온보딩 위저드 열기</Button>
        </CardContent>
      </Card>
    </main>
  );
}
