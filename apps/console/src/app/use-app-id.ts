"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** 현재 테넌트의 첫 앱 id. MVP는 앱 선택 UI 없이 기본 앱 사용 (IA는 v1.5). */
export function useAppId(): string | undefined {
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.apps.list() });
  return apps.data?.apps[0]?.id;
}
