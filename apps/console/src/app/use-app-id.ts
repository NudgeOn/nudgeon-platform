"use client";

import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { api } from "@/lib/api";

const AppScope = createContext<string | undefined>(undefined);
export const AppIdProvider = AppScope.Provider;

/** Deep-linked editors retain their verified app scope; other screens keep the existing first-app default. */
export function useAppId(): string | undefined {
  const selected = useContext(AppScope);
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.apps.list(), enabled: !selected });
  return selected ?? apps.data?.apps[0]?.id;
}
