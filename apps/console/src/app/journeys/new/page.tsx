"use client";

import Link from "next/link";
import { useAppId } from "../../use-app-id";
import { JourneyEditor } from "../JourneyEditor";

export default function NewJourneyPage() {
  const appId = useAppId();
  if (!appId) return <main className="p-8 text-sm text-muted-foreground">불러오는 중…</main>;
  return (
    <main className="mx-auto max-w-3xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href="/journeys" className="underline">
            ← 캠페인 · 저니
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">새 저니</h1>
      </header>
      <JourneyEditor appId={appId} />
    </main>
  );
}
