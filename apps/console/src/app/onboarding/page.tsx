"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CredentialsStep } from "./credentials-step";
import { PLATFORMS, PLATFORM_LABELS, snippet, type Platform } from "./snippets";

/** 온보딩 위저드 4단계 (PRD-05 3.1) — activation 관문. 목표: 30분 내 1→4 완주. */
export default function OnboardingPage() {
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.apps.list() });
  const app = apps.data?.apps[0];

  if (apps.isPending) {
    return <Centered>불러오는 중…</Centered>;
  }
  if (apps.isError || !app) {
    return (
      <Centered>
        앱 정보를 불러올 수 없습니다.{" "}
        <Link href="/login" className="text-primary underline">
          다시 로그인
        </Link>
      </Centered>
    );
  }
  return <Wizard appId={app.id} appName={app.name} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      {children}
    </main>
  );
}

function Wizard({ appId, appName }: { appId: string; appName: string }) {
  const creds = useQuery({
    queryKey: ["credentials", appId],
    queryFn: () => api.credentials.list(appId),
  });
  const ingest = useQuery({
    queryKey: ["ingest-status", appId],
    queryFn: () => api.apps.ingestStatus(appId),
    // 첫 이벤트 수신 대기 — 도착 순간 체크 전환 (5s 폴링, 웹소켓 비도입 원칙)
    refetchInterval: (q) => ((q.state.data?.events_total ?? 0) > 0 ? false : 5000),
  });
  const [pushSent, setPushSent] = useState(false);

  const step2Done = creds.data?.credentials.some((c) => c.status === "verified") ?? false;
  const step3Done = (ingest.data?.events_total ?? 0) > 0;

  return (
    <main className="mx-auto max-w-3xl p-8">
      <header className="mb-8">
        <p className="text-sm text-muted-foreground">
          <Link href="/" className="underline">
            ← 대시보드
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">시작하기 — {appName}</h1>
        <p className="text-sm text-muted-foreground">
          4단계를 완료하면 첫 푸시까지 연결됩니다.
        </p>
      </header>

      <div className="flex flex-col gap-6">
        <Step n={1} title="SDK Key 준비" done>
          <KeysStep appId={appId} />
        </Step>

        <Step n={2} title="채널 크리덴셜 등록 (푸시 · 이메일)" done={step2Done}>
          <CredentialsStep appId={appId} />
        </Step>

        <Step n={3} title="SDK 연동 — 첫 이벤트 수신" done={step3Done}>
          <SnippetStep appId={appId} received={step3Done} lastEventAt={ingest.data?.last_event_at ?? null} />
        </Step>

        <Step n={4} title="테스트 발송" done={pushSent}>
          <TestPushStep appId={appId} onQueued={() => setPushSent(true)} />
        </Step>
      </div>
    </main>
  );
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
              done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            }`}
          >
            {done ? "✓" : n}
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** 1단계 — 키는 해시 저장이라 재노출 불가. prefix 확인 + 분실 시 회전 발급. */
function KeysStep({ appId }: { appId: string }) {
  const keys = useQuery({ queryKey: ["keys", appId], queryFn: () => api.apps.keys(appId) });
  const [rotated, setRotated] = useState<string | null>(null);
  const activeSdk = keys.data?.keys.find((k) => k.kind === "sdk" && k.status === "active");
  const rotate = useMutation({
    mutationFn: () => api.apps.rotateSdkKey(appId, activeSdk!.id),
    onSuccess: (r) => {
      setRotated(r.sdk_key);
      void keys.refetch();
    },
  });

  if (keys.isError) {
    return <p className="text-sm text-muted-foreground">API 키는 Owner/Admin만 볼 수 있습니다.</p>;
  }
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        가입 시 발급된 <strong>SDK Key</strong>
        {activeSdk && <> (<code>{activeSdk.prefix}…</code>)</>}를 사용하세요. 키 원문은 보안상
        재표시되지 않습니다 — 분실했다면 회전으로 새 키를 발급하세요 (구키는 30일 병행 유효).
      </p>
      {rotated ? (
        <div>
          <Label>새 SDK Key — 지금 한 번만 표시됩니다</Label>
          <code className="mt-1 block break-all rounded-md bg-muted p-3 text-xs">{rotated}</code>
        </div>
      ) : (
        <Button
          variant="outline"
          className="w-fit"
          disabled={!activeSdk || rotate.isPending}
          onClick={() => rotate.mutate()}
        >
          SDK Key 회전 (새 키 발급)
        </Button>
      )}
    </div>
  );
}

/** 3단계 — 플랫폼 스니펫 + 첫 이벤트 실시간 감지 */
function SnippetStep({
  appId,
  received,
  lastEventAt,
}: {
  appId: string;
  received: boolean;
  lastEventAt: string | null;
}) {
  const [platform, setPlatform] = useState<Platform>("curl");
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
  void appId;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {PLATFORMS.map((p) => (
          <Button
            key={p}
            variant={p === platform ? "primary" : "outline"}
            className="h-8 px-3 text-xs"
            onClick={() => setPlatform(p)}
          >
            {PLATFORM_LABELS[p]}
          </Button>
        ))}
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">
        {snippet(platform, "pk_YOUR_SDK_KEY", apiUrl)}
      </pre>
      {received ? (
        <p className="text-sm text-primary">
          ✓ 첫 이벤트 수신 확인{lastEventAt ? ` (${lastEventAt} UTC)` : ""}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          <span className="animate-pulse">●</span> 첫 이벤트 수신 대기 중… (5초마다 확인)
        </p>
      )}
    </div>
  );
}

/** 4단계 — 내 디바이스로 테스트 발송 (M-1 경로) */
function TestPushStep({ appId, onQueued }: { appId: string; onQueued: () => void }) {
  const [externalId, setExternalId] = useState("");
  const send = useMutation({
    mutationFn: () =>
      api.apps.testPush(appId, {
        external_id: externalId,
        title: "NudgeOn 테스트",
        body: "축하합니다 — 발송 파이프라인이 연결되었습니다!",
      }),
    onSuccess: onQueued,
  });

  return (
    <form
      className="flex flex-col gap-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <p className="text-muted-foreground">
        앱에서 <code>identify</code> + <code>registerForPush</code>를 마친 유저의 external_id를
        입력하세요.
      </p>
      <div className="flex gap-2">
        <Input
          placeholder="external_id"
          value={externalId}
          onChange={(e) => setExternalId(e.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" disabled={!externalId || send.isPending}>
          테스트 발송
        </Button>
      </div>
      {send.isSuccess && (
        <p className="text-primary">✓ {send.data.queued}개 디바이스로 발송 큐에 적재되었습니다</p>
      )}
      {send.isError && (
        <p className="text-destructive">
          발송 실패 — 대상 유저의 토큰(active)·OS 권한(granted)·크리덴셜 등록 상태를 확인하세요
        </p>
      )}
    </form>
  );
}
