"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { AuditEntry } from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** 감사 로그 조회 (R-16, DEV-sub-07 T-9). team:read 권한 필요. */
export default function AuditPage() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.auth.me(), retry: false });
  const canRead = (me.data?.permissions ?? []).includes("team:read");
  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.audit.list(200),
    enabled: canRead,
  });

  if (me.isPending) return <Shell><p className="text-sm text-muted-foreground">불러오는 중…</p></Shell>;
  if (!canRead) return <Shell><p className="text-sm text-destructive">감사 로그 조회 권한이 없습니다.</p></Shell>;

  return (
    <Shell>
      <Card>
        <CardHeader className="p-4">
          <CardTitle className="text-sm">최근 감사 기록 ({audit.data?.entries.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="p-3">시각 (UTC)</th>
                  <th className="p-3">행위자</th>
                  <th className="p-3">동작</th>
                  <th className="p-3">대상</th>
                  <th className="p-3">IP</th>
                  <th className="p-3">상세</th>
                </tr>
              </thead>
              <tbody>
                {audit.data?.entries.map((e: AuditEntry) => (
                  <tr key={e.id} className="border-b border-border/50 align-top">
                    <td className="p-3 whitespace-nowrap font-mono text-xs">
                      {new Date(e.created_at).toISOString().replace("T", " ").slice(0, 19)}
                    </td>
                    <td className="p-3">{e.actor_email ?? "—"}</td>
                    <td className="p-3"><span className="font-medium">{e.action}</span></td>
                    <td className="p-3 text-xs">
                      {e.target_type ? `${e.target_type}` : "—"}
                      {e.target_id ? <span className="block font-mono text-muted-foreground">{e.target_id.slice(0, 8)}…</span> : null}
                    </td>
                    <td className="p-3 font-mono text-xs">{e.ip ?? "—"}</td>
                    <td className="p-3 text-xs">
                      {e.detail && Object.keys(e.detail).length > 0 ? (
                        <code className="break-all">{JSON.stringify(e.detail)}</code>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {audit.isPending && <p className="p-4 text-sm text-muted-foreground">감사 로그 불러오는 중…</p>}
          {audit.data?.entries.length === 0 && <p className="p-4 text-sm text-muted-foreground">기록이 없습니다.</p>}
        </CardContent>
      </Card>
      <p className="mt-4 text-xs text-muted-foreground">
        로그인·2FA·팀·키·크리덴셜·조직 설정 등 보안 민감 동작이 기록됩니다. 최신 200건 표시.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground"><Link href="/" className="underline">← 대시보드</Link></p>
        <h1 className="mt-2 text-2xl font-bold">감사 로그</h1>
      </header>
      {children}
    </main>
  );
}
