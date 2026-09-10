"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useAppId } from "../use-app-id";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function DataPage() {
  const t = useTranslations("data");
  const appId = useAppId();
  const [tab, setTab] = useState<"attributes" | "errors">("attributes");

  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href="/" className="underline">
            {t("backToDashboard")}
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">{t("title")}</h1>
      </header>

      <div className="mb-4 flex gap-2">
        <button
          className={`rounded-md px-3 py-1 text-sm ${tab === "attributes" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
          onClick={() => setTab("attributes")}
        >
          {t("tabAttributes")}
        </button>
        <button
          className={`rounded-md px-3 py-1 text-sm ${tab === "errors" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
          onClick={() => setTab("errors")}
        >
          {t("tabErrors")}
        </button>
      </div>

      {appId && (tab === "attributes" ? <Attributes appId={appId} /> : <Errors appId={appId} />)}
    </main>
  );
}

function Attributes({ appId }: { appId: string }) {
  const t = useTranslations("data");
  const qc = useQueryClient();
  const attrs = useQuery({
    queryKey: ["attributes", appId],
    queryFn: () => api.data.attributes(appId),
  });
  const del = useMutation({
    mutationFn: ({ key, force }: { key: string; force?: boolean }) =>
      api.data.deleteAttribute(appId, key, force),
    onSuccess: (r) => {
      if (r.deleted) qc.invalidateQueries({ queryKey: ["attributes", appId] });
    },
  });

  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">{t("attr.key")}</th>
              <th className="p-3">{t("attr.type")}</th>
              <th className="p-3">{t("attr.segments")}</th>
              <th className="p-3">{t("attr.lastSeen")}</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {attrs.data?.attributes.map((a) => (
              <tr key={a.key} className="border-b border-border/50">
                <td className="p-3 font-medium">{a.key}</td>
                <td className="p-3 text-xs">{a.type}</td>
                <td className="p-3 text-xs">{a.seg_ref_count}</td>
                <td className="p-3 text-xs text-muted-foreground">
                  {new Date(a.last_seen_at).toLocaleDateString("ko-KR")}
                </td>
                <td className="p-3">
                  <button
                    className="text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      const r = del.data;
                      const force = r && !r.deleted && r.referencing_segments;
                      del.mutate({ key: a.key, force: !!force });
                    }}
                  >
                    {t("attr.delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {del.data && !del.data.deleted && del.data.referencing_segments && (
          <div className="border-t border-border p-3 text-sm text-destructive">
            {t("attr.referenced", { segments: del.data.referencing_segments.map((s) => s.name).join(", ") })}
          </div>
        )}
        {attrs.data?.attributes.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {t("attr.empty")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Errors({ appId }: { appId: string }) {
  const t = useTranslations("data");
  const errors = useQuery({
    queryKey: ["ingestion-errors", appId],
    queryFn: () => api.data.ingestionErrors(appId),
  });

  return (
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="text-sm">{t("errors.title")}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">{t("errors.time")}</th>
              <th className="p-3">{t("errors.endpoint")}</th>
              <th className="p-3">{t("errors.reason")}</th>
              <th className="p-3">{t("errors.detail")}</th>
            </tr>
          </thead>
          <tbody>
            {errors.data?.errors.map((e, i) => (
              <tr key={i} className="border-b border-border/50">
                <td className="p-3 text-xs text-muted-foreground">{e.received_at}</td>
                <td className="p-3 text-xs">{e.endpoint}</td>
                <td className="p-3 text-xs text-destructive">{e.reason}</td>
                <td className="p-3 text-xs text-muted-foreground">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {errors.data?.errors.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">{t("errors.empty")}</p>
        )}
      </CardContent>
    </Card>
  );
}
