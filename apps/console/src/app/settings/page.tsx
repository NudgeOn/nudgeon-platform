"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AppSettings } from "@onda/api-client";
import { useAppId } from "../use-app-id";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SettingsPage() {
  const appId = useAppId();
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["app-settings", appId],
    queryFn: () => api.appSettings.get(appId!),
    enabled: !!appId,
  });
  const [form, setForm] = useState<AppSettings | null>(null);
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => api.appSettings.update(appId!, form!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app-settings", appId] }),
  });

  if (!form) return <main className="p-8 text-sm text-muted-foreground">불러오는 중…</main>;

  return (
    <main className="mx-auto max-w-2xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href="/" className="underline">
            ← 대시보드
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">앱 설정</h1>
      </header>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">시간대</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <Input
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              placeholder="Asia/Seoul"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4">
            <CardTitle className="flex items-center justify-between text-sm">
              조용시간 (Quiet Hours)
              <Toggle
                on={form.quiet_hours.enabled}
                onChange={(v) => setForm({ ...form, quiet_hours: { ...form.quiet_hours, enabled: v } })}
              />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 p-4 pt-0">
            <div className="flex items-center gap-2 text-sm">
              <Label>시작</Label>
              <Input
                className="w-24"
                value={form.quiet_hours.start}
                onChange={(e) =>
                  setForm({ ...form, quiet_hours: { ...form.quiet_hours, start: e.target.value } })
                }
              />
              <Label>종료</Label>
              <Input
                className="w-24"
                value={form.quiet_hours.end}
                onChange={(e) =>
                  setForm({ ...form, quiet_hours: { ...form.quiet_hours, end: e.target.value } })
                }
              />
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Label>정책</Label>
              <select
                className="h-9 rounded-md border border-border bg-card px-2 text-sm"
                value={form.quiet_hours.policy}
                onChange={(e) =>
                  setForm({
                    ...form,
                    quiet_hours: {
                      ...form.quiet_hours,
                      policy: e.target.value as "delay_until_open" | "skip",
                    },
                  })
                }
              >
                <option value="delay_until_open">다음 허용 시각에 발송</option>
                <option value="skip">발송 생략</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              거래성(transactional) 메시지는 조용시간을 우회합니다. 정보통신망법 야간 광고 제한
              (21~08시) 준수 장치입니다.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4">
            <CardTitle className="flex items-center justify-between text-sm">
              발송 빈도 제한 (Frequency Cap)
              <Toggle
                on={form.frequency_cap.enabled}
                onChange={(v) =>
                  setForm({ ...form, frequency_cap: { ...form.frequency_cap, enabled: v } })
                }
              />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 p-4 pt-0 text-sm">
            <Label>유저당 최대</Label>
            <Input
              className="w-20"
              type="number"
              value={String(form.frequency_cap.max_per_24h)}
              onChange={(e) =>
                setForm({
                  ...form,
                  frequency_cap: { ...form.frequency_cap, max_per_24h: Number(e.target.value) },
                })
              }
            />
            <span>건 / 24시간</span>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "저장 중…" : "저장"}
          </Button>
          {save.isSuccess && <span className="text-sm text-primary">✓ 저장됨</span>}
          {save.isError && <span className="text-sm text-destructive">저장 실패</span>}
        </div>
      </div>
    </main>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`h-6 w-11 rounded-full transition-colors ${on ? "bg-primary" : "bg-muted"}`}
      onClick={() => onChange(!on)}
    >
      <span
        className={`block h-5 w-5 rounded-full bg-white transition-transform ${on ? "translate-x-5" : "translate-x-0.5"}`}
      />
    </button>
  );
}
