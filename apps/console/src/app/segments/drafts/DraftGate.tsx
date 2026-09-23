"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@nudgeon/api-client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, type ReactNode } from "react";
import { api } from "@/lib/api";
import { AppIdProvider } from "../../use-app-id";

export function DraftGate({ children }: { children: (appId: string, canWrite: boolean) => ReactNode }) {
  return <Suspense><Inner>{children}</Inner></Suspense>;
}

function Inner({ children }: { children: (appId: string, canWrite: boolean) => ReactNode }) {
  const t = useTranslations("segmentDrafts");
  const search = useSearchParams(), pathname = usePathname();
  const requestedApp = search.get("app_id");
  const returnTo = `${pathname}${search.size ? `?${search}` : ""}`;
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.auth.me(), retry: false });
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.apps.list(), enabled: !!me.data, retry: false });
  const appId = requestedApp ? apps.data?.apps.find((a) => a.id === requestedApp)?.id : apps.data?.apps[0]?.id;
  if (me.isError || apps.isError) return <main className="p-8" role="alert"><p>{t("error")}</p>
    {me.error instanceof ApiError && me.error.status === 401 && <Link className="underline" href={`/login?return_to=${encodeURIComponent(returnTo)}`}>{t("login")}</Link>}</main>;
  if (me.isPending || apps.isPending) return <main className="p-8" role="status">{t("loading")}</main>;
  if (!appId) return <main className="p-8" role="alert">{t("appMissing")}</main>;
  return <AppIdProvider value={appId}>{children(appId, me.data.permissions?.includes("segments:write") ?? false)}</AppIdProvider>;
}
