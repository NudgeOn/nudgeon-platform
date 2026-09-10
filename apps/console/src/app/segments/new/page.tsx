"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAppId } from "../../use-app-id";
import { SegmentBuilder } from "../SegmentBuilder";

export default function NewSegmentPage() {
  const t = useTranslations("segmentBuilder");
  const appId = useAppId();
  if (!appId) {
    return <main className="p-8 text-sm text-muted-foreground">{t("loading")}</main>;
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href="/segments" className="underline">
            {t("backToSegments")}
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">{t("newTitle")}</h1>
      </header>
      <SegmentBuilder appId={appId} />
    </main>
  );
}
