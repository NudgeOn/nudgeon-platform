"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CredentialsStep } from "./credentials-step";
import { PLATFORMS, PLATFORM_LABELS, resolveApiUrl, snippet, type Platform } from "./snippets";

/** 온보딩 위저드 4단계 (PRD-05 3.1) — activation 관문. 목표: 30분 내 1→4 완주. */
export default function OnboardingPage() {
  const t = useTranslations("onboarding");
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.apps.list() });
  const app = apps.data?.apps[0];

  if (apps.isPending) {
    return <Centered>{t("loading")}</Centered>;
  }
  if (apps.isError || !app) {
    return (
      <Centered>
        {t("appLoadError")}{" "}
        <Link href="/login" className="text-primary underline">
          {t("loginAgain")}
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
  const t = useTranslations("onboarding");
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
            {t("backToDashboard")}
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">{t("title", { app: appName })}</h1>
        <p className="text-sm text-muted-foreground">
          {t("subtitle")}
        </p>
      </header>

      <div className="flex flex-col gap-6">
        <Step n={1} title={t("step1")} done>
          <KeysStep appId={appId} />
        </Step>

        <Step n={2} title={t("step2")} done={step2Done}>
          <CredentialsStep appId={appId} />
        </Step>

        <Step n={3} title={t("step3")} done={step3Done}>
          <SnippetStep appId={appId} received={step3Done} lastEventAt={ingest.data?.last_event_at ?? null} />
        </Step>

        <Step n={4} title={t("step4")} done={pushSent}>
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
  const t = useTranslations("onboarding.keys");
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
    return <p className="text-sm text-muted-foreground">{t("ownerOnly")}</p>;
  }
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        {t.rich("useIssuedKey", { strong: (c) => <strong>{c}</strong> })}
        {activeSdk && <> (<code>{activeSdk.prefix}…</code>)</>}{t("noReshow")}
      </p>
      {rotated ? (
        <div>
          <Label>{t("newKeyOnce")}</Label>
          <code className="mt-1 block break-all rounded-md bg-muted p-3 text-xs">{rotated}</code>
        </div>
      ) : (
        <Button
          variant="outline"
          className="w-fit"
          disabled={!activeSdk || rotate.isPending}
          onClick={() => rotate.mutate()}
        >
          {t("rotate")}
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
  const t = useTranslations("onboarding.snippet");
  const [platform, setPlatform] = useState<Platform>("curl");
  // 상대 주소(/api, Safe Boot)는 브라우저 origin을 붙여 절대 주소로 — 서버 렌더에서는 origin이 없으므로 마운트 후 계산.
  const configured = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
  const [apiUrl, setApiUrl] = useState(() => resolveApiUrl(configured, undefined));
  useEffect(() => { setApiUrl(resolveApiUrl(configured, window.location.origin)); }, [configured]);
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
          ✓ {t("received")}{lastEventAt ? ` (${lastEventAt} UTC)` : ""}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          <span className="animate-pulse">●</span> {t("waiting")}
        </p>
      )}
    </div>
  );
}

/** 4단계 — 내 디바이스로 테스트 발송 (M-1 경로) */
function TestPushStep({ appId, onQueued }: { appId: string; onQueued: () => void }) {
  const t = useTranslations("onboarding.testPush");
  const [externalId, setExternalId] = useState("");
  const send = useMutation({
    mutationFn: () =>
      api.apps.testPush(appId, {
        external_id: externalId,
        title: t("pushTitle"),
        body: t("pushBody"),
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
        {t.rich("instruction", { code: (c) => <code>{c}</code> })}
      </p>
      <div className="flex gap-2">
        <Input
          placeholder="external_id"
          value={externalId}
          onChange={(e) => setExternalId(e.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" disabled={!externalId || send.isPending}>
          {t("send")}
        </Button>
      </div>
      {send.isSuccess && (
        <p className="text-primary">✓ {t("queued", { count: send.data.queued })}</p>
      )}
      {send.isError && (
        <p className="text-destructive">
          {t("failed")}
        </p>
      )}
    </form>
  );
}
