"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { JourneyDefinition } from "@onda/journey-model";
import { useAppId } from "../../use-app-id";
import { api } from "@/lib/api";
import { JourneyEditor } from "../JourneyEditor";

export default function EditJourneyPage() {
  const appId = useAppId();
  const params = useParams<{ id: string }>();
  const journey = useQuery({
    queryKey: ["journey", appId, params.id],
    queryFn: () => api.journeys.get(appId!, params.id),
    enabled: !!appId,
  });

  if (!appId || journey.isPending) {
    return <main className="p-8 text-sm text-muted-foreground">불러오는 중…</main>;
  }
  if (journey.isError) {
    return <main className="p-8 text-sm text-destructive">저니를 찾을 수 없습니다.</main>;
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href="/journeys" className="underline">
            ← 캠페인 · 저니
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">
          {journey.data.name}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {journey.data.status !== "draft" && `(${journey.data.status})`}
          </span>
        </h1>
        {journey.data.status !== "draft" && journey.data.status !== "paused" && (
          <p className="mt-1 text-sm text-muted-foreground">
            활성 저니는 읽기 전용입니다 — 수정하려면 일시정지하세요.
          </p>
        )}
        {journey.data.status !== "draft" && (
          <Link href={`/journeys/${journey.data.id}/report`} className="mt-1 inline-block text-sm text-primary underline">
            📊 리포트 보기
          </Link>
        )}
      </header>
      <JourneyEditor
        appId={appId}
        journeyId={journey.data.id}
        initialName={journey.data.name}
        initialDef={journey.data.draft_definition as JourneyDefinition}
        status={journey.data.status}
      />
    </main>
  );
}
