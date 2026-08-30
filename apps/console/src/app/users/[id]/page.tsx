"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAppId } from "../../use-app-id";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const TOKEN_KO: Record<string, string> = { active: "유효", invalid: "무효", expired: "만료" };
const PERM_KO: Record<string, string> = {
  granted: "허용",
  denied: "거부",
  undetermined: "미정",
};

export default function UserDetailPage() {
  const appId = useAppId();
  const params = useParams<{ id: string }>();
  const detail = useQuery({
    queryKey: ["user-detail", appId, params.id],
    queryFn: () => api.users.detail(appId!, params.id),
    enabled: !!appId,
  });

  if (!appId || detail.isPending) {
    return <main className="p-8 text-sm text-muted-foreground">불러오는 중…</main>;
  }
  if (detail.isError) {
    return <main className="p-8 text-sm text-destructive">유저를 찾을 수 없습니다.</main>;
  }
  const d = detail.data;
  const pushSub = (d.user.subscriptions as { push?: string })?.push ?? "unknown";

  return (
    <main className="mx-auto max-w-3xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href="/users" className="underline">
            ← 유저 검색
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">{d.user.external_id ?? "(익명 유저)"}</h1>
        <p className="text-sm text-muted-foreground">
          구독: 푸시 {pushSub === "opted_in" ? "수신" : "거부"} · {d.user.status}
        </p>
      </header>

      {/* 디바이스 — "왜 안 받았나"의 1차 답 (U-7) */}
      <Card className="mb-4">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">디바이스</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {d.devices.length === 0 && <p className="text-sm text-muted-foreground">디바이스 없음</p>}
          {d.devices.map((dev) => (
            <div key={dev.id} className="flex items-center gap-3 border-b border-border/50 py-2 text-sm last:border-0">
              <span className="font-medium">{dev.platform}</span>
              <span className={dev.token_status === "active" ? "text-primary" : "text-destructive"}>
                토큰 {TOKEN_KO[dev.token_status] ?? dev.token_status}
              </span>
              <span className="text-muted-foreground">권한 {PERM_KO[dev.os_permission] ?? dev.os_permission}</span>
              {!dev.has_token && <span className="text-xs text-destructive">토큰 없음</span>}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* 속성 */}
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">속성</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-xs">
            {Object.entries({ ...d.user.std_attrs, ...d.user.custom_attrs }).map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-border/30 py-1">
                <span className="text-muted-foreground">{k}</span>
                <span>{JSON.stringify(v)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* 저니 */}
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">저니</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-xs">
            {d.journeys.length === 0 && <p className="text-muted-foreground">진행 중 저니 없음</p>}
            {d.journeys.map((j, i) => (
              <div key={i} className="border-b border-border/30 py-1">
                <span className="font-medium">{j.name}</span> · {j.status} · 노드 {j.current_node}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* 메시지 이력 — skip 사유 포함 (U-7) */}
      <Card className="mt-4">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">메시지 이력</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {d.messages.length === 0 && <p className="text-sm text-muted-foreground">발송 이력 없음</p>}
          {d.messages.map((m, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border/30 py-1 text-xs">
              <span className="text-muted-foreground">{m.sent_at}</span>
              <span>{m.channel}</span>
              <span className={m.status === "sent" ? "text-primary" : "text-destructive"}>{m.status}</span>
              {m.failure_class && <span className="text-muted-foreground">— {m.failure_class}</span>}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 활동 */}
      <Card className="mt-4">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">최근 활동</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0 text-xs">
          {d.events.map((e, i) => (
            <div key={i} className="flex justify-between border-b border-border/30 py-1">
              <span>{e.event_name}</span>
              <span className="text-muted-foreground">{e.ts}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </main>
  );
}
