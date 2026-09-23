"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, type SegmentDraft } from "@nudgeon/api-client";
import type { SegmentDSL } from "@nudgeon/segment-dsl";
import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { SegmentBuilder } from "../../SegmentBuilder";
import { DraftGate } from "../DraftGate";

export default function SegmentDraftPage() {
  const { id } = useParams<{ id: string }>();
  return <DraftGate>{(appId, canWrite) => <DraftDetail key={`${appId}:${id}`} appId={appId} id={id} canWrite={canWrite} />}</DraftGate>;
}

function DraftDetail({ appId, id, canWrite }: { appId: string; id: string; canWrite: boolean }) {
  const t = useTranslations("segmentDrafts");
  const draft = useQuery({ queryKey: ["segment-draft", appId, id], queryFn: () => api.segmentDrafts.get(appId, id), enabled: id !== "new" });
  if (id !== "new" && draft.isPending) return <main className="p-8" role="status">{t("loading")}</main>;
  if (draft.isError || (id === "new" && !canWrite)) return <main className="p-8" role="alert">{t("error")}</main>;
  return <Editor appId={appId} initial={draft.data} canWrite={canWrite} />;
}

function Editor({ appId, initial, canWrite }: { appId: string; initial?: SegmentDraft; canWrite: boolean }) {
  const t = useTranslations("segmentDrafts");
  const qc = useQueryClient(), router = useRouter();
  const [draft, setDraft] = useState(initial), [dirty, setDirty] = useState(false), [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const createId = useRef<string | null>(null), copyId = useRef<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["segment-drafts", appId] });
  const preview = useMutation({ mutationFn: () => api.segmentDrafts.preview(appId, draft!.id) });
  const promote = useMutation({ mutationFn: () => api.segmentDrafts.promote(appId, draft!.id, draft!.revision), onSuccess: async (result) => {
    setDraft((d) => d ? { ...d, promoted_segment_id: result.segment_id } : d);
    await refresh();
    void qc.invalidateQueries({ queryKey: ["segments", appId] });
  } });
  const copy = useMutation({ mutationFn: () => {
    copyId.current ??= crypto.randomUUID();
    return api.segmentDrafts.create(appId, { name: `${draft!.name} (${t("copySuffix")})`, definition: draft!.definition, request_id: copyId.current });
  }, onSuccess: async (created) => { await refresh(); router.push(`/segments/drafts/${created.id}?app_id=${encodeURIComponent(appId)}`); } });
  const error = saveError ?? promote.error ?? preview.error ?? copy.error;
  const conflict = error instanceof ApiError && (error.status === 409 || error.status === 412);
  const busy = saving || promote.isPending || copy.isPending;
  const promoted = !!draft?.promoted_segment_id;

  async function save(input: { name: string; definition: SegmentDSL }) {
    setSaving(true); setSaveError(null);
    try {
      createId.current ??= crypto.randomUUID();
      const result = draft ? await api.segmentDrafts.update(appId, draft.id, { ...input, expected_revision: draft.revision })
        : await api.segmentDrafts.create(appId, { ...input, request_id: createId.current });
      setDraft(result); preview.reset(); await refresh();
      if (!draft) router.replace(`/segments/drafts/${result.id}?app_id=${encodeURIComponent(appId)}`);
    } catch (cause) { setSaveError(cause); throw cause; }
    finally { setSaving(false); }
  }

  return <main className="mx-auto max-w-5xl p-4 sm:p-8">
    <header className="mb-6"><Link className="text-sm text-muted-foreground underline" href={`/segments/drafts?app_id=${encodeURIComponent(appId)}`}>{t("backToDrafts")}</Link>
      <h1 className="mt-2 text-2xl font-bold">{draft ? t("edit") : t("new")}</h1><p className="mt-2 text-sm text-muted-foreground">{t("intro")}</p>
    </header>
    {error && <div role="alert" className="mb-4 rounded-md border border-destructive/30 p-4 text-sm text-destructive"><p>{conflict ? t("conflict") : t("error")}</p>
      {conflict && <Button className="mt-2" variant="outline" onClick={() => window.location.reload()}>{t("reload")}</Button>}</div>}
    <div className="mb-5 space-y-3 rounded-md border border-border p-4 text-sm">
      {draft && <p>{t("revision", { revision: draft.revision })} · {promoted ? t("promoted") : t("draft")}</p>}
      {promoted ? <><p>{t("locked")}</p><Link className="block text-primary underline" href={`/segments/${draft!.promoted_segment_id}?app_id=${encodeURIComponent(appId)}`}>{t("openSegment")}</Link>
        {canWrite && <Button variant="outline" disabled={busy} onClick={() => copy.mutate()}>{t("duplicate")}</Button>}</>
        : <><p>{t("reviewHint")}</p><div className="flex flex-wrap gap-2">
          {draft && <Button variant="outline" disabled={dirty || busy || preview.isPending} onClick={() => preview.mutate()}>{t("preview")}</Button>}
          {draft && canWrite && <Button disabled={dirty || busy} onClick={() => promote.mutate()}>{promote.isPending ? t("loading") : t("promote")}</Button>}
        </div>{dirty && <p>{t("saveFirst")}</p>}
          {preview.data && <p role="status">{t("count", { count: preview.data.approx_count })}</p>}
        </>}
    </div>
    <SegmentBuilder appId={appId} initialName={initial?.name} initialDSL={initial?.definition as SegmentDSL | undefined}
      onSave={save} onDirtyChange={setDirty} readOnly={!canWrite || promoted || promote.isPending || copy.isPending} saveLabel={t("save")} />
  </main>;
}
