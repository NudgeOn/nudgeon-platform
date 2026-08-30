"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useAppId } from "../use-app-id";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function DataPage() {
  const appId = useAppId();
  const [tab, setTab] = useState<"attributes" | "errors">("attributes");

  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href="/" className="underline">
            ← 대시보드
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">데이터</h1>
      </header>

      <div className="mb-4 flex gap-2">
        <button
          className={`rounded-md px-3 py-1 text-sm ${tab === "attributes" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
          onClick={() => setTab("attributes")}
        >
          속성 사전
        </button>
        <button
          className={`rounded-md px-3 py-1 text-sm ${tab === "errors" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
          onClick={() => setTab("errors")}
        >
          수집 오류
        </button>
      </div>

      {appId && (tab === "attributes" ? <Attributes appId={appId} /> : <Errors appId={appId} />)}
    </main>
  );
}

function Attributes({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const attrs = useQuery({
    queryKey: ["attributes", appId],
    queryFn: () => api.data.attributes(appId),
  });
  const del = useMutation({
    mutationFn: ({ key, force }: { key: string; force?: boolean }) =>
      api.data.deleteAttribute(appId, key, force),
    onSuccess: (r) => {
      if (r.deleted) qc.invalidateQueries({ queryKey: ["attributes", appId] });
    },
  });

  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">키</th>
              <th className="p-3">타입</th>
              <th className="p-3">참조 세그먼트</th>
              <th className="p-3">최근 수신</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {attrs.data?.attributes.map((a) => (
              <tr key={a.key} className="border-b border-border/50">
                <td className="p-3 font-medium">{a.key}</td>
                <td className="p-3 text-xs">{a.type}</td>
                <td className="p-3 text-xs">{a.seg_ref_count}</td>
                <td className="p-3 text-xs text-muted-foreground">
                  {new Date(a.last_seen_at).toLocaleDateString("ko-KR")}
                </td>
                <td className="p-3">
                  <button
                    className="text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      const r = del.data;
                      const force = r && !r.deleted && r.referencing_segments;
                      del.mutate({ key: a.key, force: !!force });
                    }}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {del.data && !del.data.deleted && del.data.referencing_segments && (
          <div className="border-t border-border p-3 text-sm text-destructive">
            참조 중인 세그먼트가 있습니다: {del.data.referencing_segments.map((s) => s.name).join(", ")} —
            다시 삭제를 누르면 강제 삭제됩니다.
          </div>
        )}
        {attrs.data?.attributes.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            아직 수집된 커스텀 속성이 없습니다.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Errors({ appId }: { appId: string }) {
  const errors = useQuery({
    queryKey: ["ingestion-errors", appId],
    queryFn: () => api.data.ingestionErrors(appId),
  });

  return (
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="text-sm">수집 오류 (타입 불일치·스키마 오류 거부 건)</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">시각</th>
              <th className="p-3">엔드포인트</th>
              <th className="p-3">사유</th>
              <th className="p-3">상세</th>
            </tr>
          </thead>
          <tbody>
            {errors.data?.errors.map((e, i) => (
              <tr key={i} className="border-b border-border/50">
                <td className="p-3 text-xs text-muted-foreground">{e.received_at}</td>
                <td className="p-3 text-xs">{e.endpoint}</td>
                <td className="p-3 text-xs text-destructive">{e.reason}</td>
                <td className="p-3 text-xs text-muted-foreground">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {errors.data?.errors.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">수집 오류가 없습니다. 👍</p>
        )}
      </CardContent>
    </Card>
  );
}
