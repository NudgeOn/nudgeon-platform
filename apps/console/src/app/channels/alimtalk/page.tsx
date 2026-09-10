"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ChannelConnector } from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppId } from "../../use-app-id";
import { ALIMTALK_CHANNEL } from "./channel";
import { reportSummary } from "./alimtalk-labels";
import { ConnectorSetup } from "./connector-setup";
import { SendersCard } from "./senders-card";
import { TemplatesCard } from "./templates-card";

/**
 * 알림톡 설정 — 벤더 선택 → 설정 입력 → 발신프로필 → 템플릿 순서.
 *
 * 벤더 목록도 크리덴셜 폼도 이 배포의 커넥터 매니페스트에서 온다. 콘솔에는 벤더별 분기가 없다 —
 * `deploy/connectors/`에 매니페스트를 놓는 것이 곧 그 벤더를 켜는 일이다.
 */
export default function AlimtalkChannelPage() {
  const t = useTranslations("alimtalk");
  const appId = useAppId();
  const [chosen, setChosen] = useState<string | null>(null);

  const catalog = useQuery({
    queryKey: ["connector-catalog", ALIMTALK_CHANNEL],
    queryFn: () => api.connectors.catalog(ALIMTALK_CHANNEL),
  });

  const wiring = useQuery({
    queryKey: ["channel-connector", appId, ALIMTALK_CHANNEL],
    queryFn: () => api.alimtalk.connector.get(appId!, ALIMTALK_CHANNEL),
    enabled: !!appId,
    // 미배선이면 404다. 오류가 아니라 "아직 고르지 않음"이므로 되풀이하지 않는다.
    retry: false,
  });

  const senders = useQuery({
    queryKey: ["alimtalk-senders", appId],
    queryFn: () => api.alimtalk.senders.list(appId!),
    enabled: !!appId,
  });

  const connectors = catalog.data?.connectors ?? [];
  // 미배선은 404로 온다 — 오류 상태이지만 표시할 것은 "아직 없음"이다.
  const wired: ChannelConnector | null = wiring.data ?? null;
  const selectedId = chosen ?? wired?.connector_id ?? connectors[0]?.id ?? "";
  const selected = connectors.find((c) => c.id === selectedId) ?? null;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href="/" className="underline">
            {t("backToDashboard")}
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("subtitle")}
        </p>
      </header>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">{t("vendor.title")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 p-4 pt-0 text-sm">
            {catalog.isPending ? (
              <p className="text-xs text-muted-foreground">{t("vendor.loading")}</p>
            ) : catalog.isError ? (
              <p className="text-xs text-destructive">{t("vendor.loadFailed")}</p>
            ) : connectors.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t.rich("vendor.none", { code: (c) => <code>{c}</code> })}
              </p>
            ) : (
              <>
                <select
                  aria-label={t("vendor.selectLabel")}
                  className="h-9 rounded-md border border-border bg-card px-2 text-sm"
                  value={selectedId}
                  onChange={(e) => setChosen(e.target.value)}
                >
                  {connectors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · v{c.version}
                    </option>
                  ))}
                </select>
                <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {connectors.map((c) => (
                    <li key={c.id}>
                      <span className="font-medium text-foreground">{c.name}</span> — {reportSummary(c.reports, t)}
                    </li>
                  ))}
                </ul>
                <WiringState wired={wired} pending={wiring.isPending} selectedId={selectedId} />
              </>
            )}
          </CardContent>
        </Card>

        {selected && (
          <ConnectorSetup
            key={selected.id}
            appId={appId}
            connector={selected}
            wired={wired}
            onSaved={() => {
              void wiring.refetch();
            }}
          />
        )}

        <SendersCard
          appId={appId}
          senders={senders.data?.senders ?? []}
          pending={senders.isPending}
          onChanged={() => {
            void senders.refetch();
          }}
        />

        <TemplatesCard appId={appId} senders={senders.data?.senders ?? []} />
      </div>
    </main>
  );
}

/** 지금 어느 벤더로 나가는지. 고른 것과 배선된 것이 다르면 아직 저장 전이라는 뜻이다. */
function WiringState({
  wired,
  pending,
  selectedId,
}: {
  wired: ChannelConnector | null;
  pending: boolean;
  selectedId: string;
}) {
  const t = useTranslations("alimtalk");
  if (pending) return <p className="text-xs text-muted-foreground">{t("wiring.checking")}</p>;
  if (!wired) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("wiring.none")}
      </p>
    );
  }
  return (
    <p className="text-xs">
      {t("wiring.current")} <code>{wired.connector_id}</code>{" "}
      <span className={wired.enabled ? "text-primary" : "text-destructive"}>
        ({wired.enabled ? t("wiring.enabled") : t("wiring.disabled")})
      </span>
      {wired.connector_id !== selectedId && (
        <span className="text-muted-foreground"> — {t("wiring.viewingOther")}</span>
      )}
    </p>
  );
}
