"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@nudgeon/api-client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { JourneyState } from "./journey-ui";

/** Unlike useAppId, distinguish loading, authorization failures, and an empty app list. */
export function JourneyAppGate({ children }: { children: (appId: string) => ReactNode }) {
  const t = useTranslations("journeyEditor");
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.apps.list() });
  if (apps.isPending) return <JourneyState title={t("gate.loadingTitle")} description={t("gate.loadingBody")} />;
  if (apps.isError) {
    const unauthorized = apps.error instanceof ApiError && apps.error.status === 401;
    return <JourneyState error title={unauthorized ? t("gate.loginTitle") : t("gate.errorTitle")}
      description={unauthorized ? t("gate.loginBody") : t("gate.errorBody")}
      action={unauthorized ? <Link className="j-button j-button-primary" href="/login">{t("gate.login")}</Link>
        : <button type="button" className="j-button" onClick={() => { void apps.refetch(); }}>{t("gate.retry")}</button>} />;
  }
  const appId = apps.data.apps[0]?.id;
  if (!appId) return <JourneyState title={t("gate.noAppTitle")} description={t("gate.noAppBody")}
    action={<Link className="j-button j-button-primary" href="/onboarding">{t("gate.connectApp")}</Link>} />;
  return children(appId);
}
