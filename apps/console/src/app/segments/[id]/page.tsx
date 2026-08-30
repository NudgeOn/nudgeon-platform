"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { SegmentDSL } from "@onda/segment-dsl";
import { useAppId } from "../../use-app-id";
import { api } from "@/lib/api";
import { SegmentBuilder } from "../SegmentBuilder";

export default function EditSegmentPage() {
  const appId = useAppId();
  const params = useParams<{ id: string }>();
  const seg = useQuery({
    queryKey: ["segment", appId, params.id],
    queryFn: () => api.segments.get(appId!, params.id),
    enabled: !!appId,
  });

  if (!appId || seg.isPending) {
    return <main className="p-8 text-sm text-muted-foreground">불러오는 중…</main>;
  }
  if (seg.isError) {
    return <main className="p-8 text-sm text-destructive">세그먼트를 찾을 수 없습니다.</main>;
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href="/segments" className="underline">
            ← 세그먼트
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">세그먼트 편집</h1>
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
