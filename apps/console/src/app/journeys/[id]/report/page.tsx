"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAppId } from "../../../use-app-id";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const STATE_KO: Record<string, string> = {
  active: "진행",
  waiting: "대기",
  claimed: "처리중",
  completed: "완료",
  exited: "이탈",
  failed: "실패",
};
const SEND_KO: Record<string, string> = {
  sent: "발송",
  failed: "실패",
  duplicate: "중복",
  skipped_quiet_hours: "조용시간 생략",
  skipped_cap: "빈도제한 생략",
  skipped_unreachable: "도달불가 생략",
};

export default function JourneyReportPage() {
  const appId = useAppId();
  const params = useParams<{ id: string }>();
  const report = useQuery({
    queryKey: ["journey-report", appId, params.id],
    queryFn: () => api.analytics.journeyReport(appId!, params.id),
    enabled: !!appId,
  });

  if (!appId || report.isPending) {
    return <main className="p-8 text-sm text-muted-foreground">불러오는 중…</main>;
  }
  if (report.isError) return <main className="p-8 text-sm text-destructive">리포트를 불러올 수 없습니다.</main>;

  const r = report.data;
  const totalStates = Object.values(r.state_distribution).reduce((a, b) => a + b, 0);

  return (
    <main className="mx-auto max-w-3xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href={`/journeys/${params.id}`} className="underline">
            ← {r.name}
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">리포트 — {r.name}</h1>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">유저 상태 분포 (총 {totalStates.toLocaleString()})</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-sm">
            {Object.entries(r.state_distribution).map(([status, n]) => (
              <div key={status} className="flex justify-between border-b border-border/30 py-1">
                <span>{STATE_KO[status] ?? status}</span>
                <span className="font-medium">{n.toLocaleString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">발송 결과 (노드별)</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-sm">
            {r.sends.length === 0 && <p className="text-muted-foreground">발송 없음</p>}
            {r.sends.map((s, i) => (
              <div key={i} className="flex justify-between border-b border-border/30 py-1">
                <span>
                  노드 {s.node_index} · {SEND_KO[s.status] ?? s.status}
                </span>
                <span className="font-medium">{s.count.toLocaleString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
