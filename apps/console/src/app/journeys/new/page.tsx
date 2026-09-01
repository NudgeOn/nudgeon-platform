"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@onda/api-client";
import Link from "next/link";
import { api } from "@/lib/api";
import { JourneyAppGate } from "../JourneyAppGate";
import { JourneyEditor } from "../JourneyEditor";
import { JourneyState } from "../journey-ui";

export default function NewJourneyPage() {
  return <JourneyAppGate>{(appId) => <NewJourneyView key={appId} appId={appId} />}</JourneyAppGate>;
}

function NewJourneyView({ appId }: { appId: string }) {
  const server = useQuery({ queryKey: ["journeys", appId], queryFn: () => api.journeys.list(appId) });
  if (server.isPending) return <JourneyState title="편집기를 준비하고 있어요" description="이 서버에서 사용할 수 있는 저니 단계를 확인합니다." />;
  if (server.isError) {
    const login = server.error instanceof ApiError && server.error.status === 401;
    return <JourneyState error title={login ? "로그인이 필요합니다" : "편집기를 준비하지 못했습니다"}
      description={login ? "다시 로그인한 뒤 저니를 만들어 주세요." : "서버 지원 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요."}
      action={login ? <Link href="/login" className="j-button j-button-primary">로그인</Link>
        : <button type="button" className="j-button" onClick={() => { void server.refetch(); }}>다시 시도</button>} />;
  }
  if (!server.data.capabilities?.graph_v2) return <JourneyState title="그래프 저니 지원이 필요합니다"
    description="이 서버에서는 그래프 저니를 아직 만들 수 없습니다. API와 실행 서버의 지원 상태를 관리자에게 확인해 주세요."
    action={<Link href="/journeys" className="j-button">저니 목록으로</Link>} />;
  return <JourneyEditor appId={appId} capabilities={server.data.capabilities} />;
}
