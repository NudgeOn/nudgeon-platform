"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import type { SegmentDSL } from "@nudgeon/segment-dsl";
import { useAppId } from "../../use-app-id";
import { api } from "@/lib/api";
import { SegmentBuilder } from "../SegmentBuilder";

export default function EditSegmentPage() {
  const t = useTranslations("segmentBuilder");
  const appId = useAppId();
  const params = useParams<{ id: string }>();
  const seg = useQuery({
    queryKey: ["segment", appId, params.id],
    queryFn: () => api.segments.get(appId!, params.id),
    enabled: !!appId,
  });

  if (!appId || seg.isPending) {
    return <main className="p-8 text-sm text-muted-foreground">{t("loading")}</main>;
  }
  if (seg.isError) {
    return <main className="p-8 text-sm text-destructive">{t("notFound")}</main>;
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href="/segments" className="underline">
            {t("backToSegments")}
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">{t("editTitle")}</h1>
        {seg.data.status === "broken" && seg.data.status_detail && (
          <p className="mt-1 text-sm text-destructive">broken: {seg.data.status_detail}</p>
        )}
      </header>
      <SegmentBuilder
        appId={appId}
        segmentId={seg.data.id}
        initialName={seg.data.name}
        initialDSL={seg.data.definition as SegmentDSL}
      />
    </main>
  );
}
