"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@onda/api-client";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { JourneyDefinition } from "@onda/journey-model";
import { api } from "@/lib/api";
import { JourneyAppGate } from "../JourneyAppGate";
import { JourneyEditor } from "../JourneyEditor";
import { JourneyState } from "../journey-ui";

export default function EditJourneyPage() {
  const params = useParams<{ id: string }>();
  return <JourneyAppGate>{(appId) => <JourneyDetailView appId={appId} id={params.id} />}</JourneyAppGate>;
}

function JourneyDetailView({ appId, id }: { appId: string; id: string }) {
  const journey = useQuery({
    queryKey: ["journey", appId, id],
    queryFn: () => api.journeys.get(appId, id),
  });

  if (journey.isPending) return <JourneyState title="저니를 불러오고 있어요" description="저장된 흐름과 메시지를 준비하고 있습니다." />;
  if (journey.isError) return <JourneyState error title={journey.error instanceof ApiError && journey.error.status === 401 ? "로그인이 필요합니다" : "저니를 불러오지 못했습니다"}
    description="로그인과 저니 상태를 확인해 주세요. 저장된 내용은 변경되지 않았습니다."
    action={<div className="j-topbar-actions">
      <Link href="/journeys" className="j-button">목록으로</Link>
      {journey.error instanceof ApiError && journey.error.status === 401 ? <Link href="/login" className="j-button j-button-primary">로그인</Link>
        : <button type="button" className="j-button j-button-primary" onClick={() => { void journey.refetch(); }}>다시 시도</button>}
    </div>} />;

  return <JourneyEditor key={`${appId}:${journey.data.id}`} appId={appId}
    journeyId={journey.data.id} initialName={journey.data.name}
    initialDef={journey.data.draft_definition as JourneyDefinition}
    capabilities={journey.data.capabilities} publishedABNodes={journey.data.published_ab_nodes}
    status={journey.data.status} />;
}
