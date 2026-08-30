"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useAppId } from "../use-app-id";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const STATUS_LABEL: Record<string, string> = {
  draft: "초안",
  active: "활성",
  paused: "일시정지",
  archived: "보관",
};

export default function JourneysPage() {
  const appId = useAppId();
  const journeys = useQuery({
    queryKey: ["journeys", appId],
    queryFn: () => api.journeys.list(appId!),
    enabled: !!appId,
  });

  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href="/" className="underline">
              ← 대시보드
            </Link>
          </p>
          <h1 className="mt-2 text-2xl font-bold">캠페인 · 저니</h1>
        </div>
        <Link href="/journeys/new">
          <Button>새 저니</Button>
        </Link>
      </header>

      {journeys.data?.journeys.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            아직 저니가 없습니다. 단발 캠페인이나 선형 저니를 만들어보세요.
          </CardContent>
        </Card>
      )}
      <div className="flex flex-col gap-3">
        {journeys.data?.journeys.map((j) => (
          <Link key={j.id} href={`/journeys/${j.id}`}>
            <Card className="transition-colors hover:border-primary">
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  <span>{j.name}</span>
                  <span className="rounded bg-muted px-2 py-0.5 text-xs">
                    {STATUS_LABEL[j.status] ?? j.status}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {j.category === "transactional" ? "거래성" : "마케팅"}
                {j.active_version ? ` · v${j.active_version}` : ""}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </main>
  );
}
