"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@onda/api-client";
import Link from "next/link";
import type { ReactNode } from "react";
import { api } from "@/lib/api";
import { JourneyState } from "./journey-ui";

/** Unlike useAppId, distinguish loading, authorization failures, and an empty app list. */
export function JourneyAppGate({ children }: { children: (appId: string) => ReactNode }) {
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.apps.list() });
  if (apps.isPending) return <JourneyState title="워크스페이스를 불러오고 있어요" description="저니를 편집할 앱을 확인하고 있습니다." />;
  if (apps.isError) {
    const unauthorized = apps.error instanceof ApiError && apps.error.status === 401;
    return <JourneyState error title={unauthorized ? "로그인이 필요합니다" : "앱을 불러오지 못했습니다"}
      description={unauthorized ? "로그인한 뒤 저니를 다시 열어 주세요." : "연결 상태를 확인하고 다시 시도해 주세요."}
      action={unauthorized ? <Link className="j-button j-button-primary" href="/login">로그인</Link>
        : <button type="button" className="j-button" onClick={() => { void apps.refetch(); }}>다시 시도</button>} />;
  }
  const appId = apps.data.apps[0]?.id;
  if (!appId) return <JourneyState title="먼저 앱을 연결해 주세요" description="앱 설정을 마치면 고객의 저니를 만들 수 있습니다."
    action={<Link className="j-button j-button-primary" href="/onboarding">앱 연결하기</Link>} />;
  return children(appId);
}
