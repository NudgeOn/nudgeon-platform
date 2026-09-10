"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useAppId } from "../use-app-id";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function SegmentsPage() {
  const t = useTranslations("segments");
  const locale = useLocale();
  const appId = useAppId();
  const segments = useQuery({
    queryKey: ["segments", appId],
    queryFn: () => api.segments.list(appId!),
    enabled: !!appId,
  });

  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href="/" className="underline">
              {t("backToDashboard")}
            </Link>
          </p>
          <h1 className="mt-2 text-2xl font-bold">{t("title")}</h1>
        </div>
        <Link href="/segments/new">
          <Button>{t("new")}</Button>
        </Link>
      </header>

      {segments.isPending && <p className="text-sm text-muted-foreground">{t("loading")}</p>}
      {segments.data?.segments.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {t("empty")}
          </CardContent>
        </Card>
      )}
      <div className="flex flex-col gap-3">
        {segments.data?.segments.map((s) => (
          <Link key={s.id} href={`/segments/${s.id}`}>
            <Card className="transition-colors hover:border-primary">
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  <span>{s.name}</span>
                  {s.status === "broken" && (
                    <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                      broken
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {s.last_count != null ? t("approxCount", { count: s.last_count.toLocaleString(locale) }) : t("notEvaluated")} · {t("updated")}{" "}
                {new Date(s.updated_at).toLocaleDateString(locale)}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </main>
  );
}
