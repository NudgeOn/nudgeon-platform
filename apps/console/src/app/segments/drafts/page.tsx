"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { DraftGate } from "./DraftGate";

export default function SegmentDraftsPage() { return <DraftGate>{(appId, canWrite) => <Drafts appId={appId} canWrite={canWrite} />}</DraftGate>; }

function Drafts({ appId, canWrite }: { appId: string; canWrite: boolean }) {
  const t = useTranslations("segmentDrafts"), locale = useLocale();
  const drafts = useQuery({ queryKey: ["segment-drafts", appId], queryFn: () => api.segmentDrafts.list(appId) });
  return <main className="mx-auto max-w-4xl p-4 sm:p-8">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4"><div>
      <Link className="text-sm text-muted-foreground underline" href="/segments">{t("back")}</Link>
      <h1 className="mt-2 text-2xl font-bold">{t("title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("intro")}</p>
    </div><LocaleSwitcher /></header>
    {canWrite && <Link className="mb-4 inline-block rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground" href={`/segments/drafts/new?app_id=${encodeURIComponent(appId)}`}>{t("new")}</Link>}
    {drafts.isPending && <p role="status">{t("loading")}</p>}
    {drafts.isError && <p role="alert" className="text-destructive">{t("error")}</p>}
    {drafts.data?.drafts.length === 0 && <p className="rounded-md border border-border p-6 text-sm text-muted-foreground">{t("empty")}</p>}
    <div className="space-y-3">{drafts.data?.drafts.map((draft) => <Link className="block" key={draft.id} href={`/segments/drafts/${draft.id}?app_id=${encodeURIComponent(appId)}`}><Card className="hover:border-primary">
      <CardHeader><CardTitle className="flex flex-wrap items-start justify-between gap-2 text-base"><span className="break-words">{draft.name}</span><span className="text-xs text-muted-foreground">{draft.promoted_segment_id ? t("promoted") : t("draft")}</span></CardTitle></CardHeader>
      <CardContent className="text-sm text-muted-foreground">{t("revision", { revision: draft.revision })} · {new Date(draft.updated_at).toLocaleString(locale)}</CardContent>
    </Card></Link>)}</div>
  </main>;
}
