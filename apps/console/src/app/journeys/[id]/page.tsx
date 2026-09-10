"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@nudgeon/api-client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import type { JourneyDefinition } from "@nudgeon/journey-model";
import { api } from "@/lib/api";
import { JourneyAppGate } from "../JourneyAppGate";
import { JourneyEditor } from "../JourneyEditor";
import { JourneyState } from "../journey-ui";

export default function EditJourneyPage() {
  const params = useParams<{ id: string }>();
  return <JourneyAppGate>{(appId) => <JourneyDetailView appId={appId} id={params.id} />}</JourneyAppGate>;
}

function JourneyDetailView({ appId, id }: { appId: string; id: string }) {
  const t = useTranslations("journeyEditor");
  const journey = useQuery({
    queryKey: ["journey", appId, id],
    queryFn: () => api.journeys.get(appId, id),
  });

  if (journey.isPending) return <JourneyState title={t("detail.loadingTitle")} description={t("detail.loadingBody")} />;
  if (journey.isError) return <JourneyState error title={journey.error instanceof ApiError && journey.error.status === 401 ? t("gate.loginTitle") : t("detail.errorTitle")}
    description={t("detail.errorBody")}
    action={<div className="j-topbar-actions">
      <Link href="/journeys" className="j-button">{t("detail.backToList")}</Link>
      {journey.error instanceof ApiError && journey.error.status === 401 ? <Link href="/login" className="j-button j-button-primary">{t("gate.login")}</Link>
        : <button type="button" className="j-button j-button-primary" onClick={() => { void journey.refetch(); }}>{t("gate.retry")}</button>}
    </div>} />;

  return <JourneyEditor key={`${appId}:${journey.data.id}`} appId={appId}
    journeyId={journey.data.id} initialName={journey.data.name}
    initialDef={journey.data.draft_definition as JourneyDefinition}
    capabilities={journey.data.capabilities} publishedABNodes={journey.data.published_ab_nodes}
    status={journey.data.status} />;
}
