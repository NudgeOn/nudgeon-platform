"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@nudgeon/api-client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { JourneyAppGate } from "../JourneyAppGate";
import { JourneyEditor } from "../JourneyEditor";
import { JourneyState } from "../journey-ui";

export default function NewJourneyPage() {
  return <JourneyAppGate>{(appId) => <NewJourneyView key={appId} appId={appId} />}</JourneyAppGate>;
}

function NewJourneyView({ appId }: { appId: string }) {
  const t = useTranslations("journeyEditor");
  const server = useQuery({ queryKey: ["journeys", appId], queryFn: () => api.journeys.list(appId) });
  if (server.isPending) return <JourneyState title={t("new.preparingTitle")} description={t("new.preparingBody")} />;
  if (server.isError) {
    const login = server.error instanceof ApiError && server.error.status === 401;
    return <JourneyState error title={login ? t("gate.loginTitle") : t("new.errorTitle")}
      description={login ? t("new.loginBody") : t("new.errorBody")}
      action={login ? <Link href="/login" className="j-button j-button-primary">{t("gate.login")}</Link>
        : <button type="button" className="j-button" onClick={() => { void server.refetch(); }}>{t("gate.retry")}</button>} />;
  }
  if (!server.data.capabilities?.graph_v2) return <JourneyState title={t("new.unsupportedTitle")}
    description={t("new.unsupportedBody")}
    action={<Link href="/journeys" className="j-button">{t("new.backToList")}</Link>} />;
  return <JourneyEditor appId={appId} capabilities={server.data.capabilities} />;
}
