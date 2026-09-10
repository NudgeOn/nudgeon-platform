"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useAppId } from "../../use-app-id";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function UserDetailPage() {
  const t = useTranslations("userDetail");
  const appId = useAppId();
  const params = useParams<{ id: string }>();
  const detail = useQuery({
    queryKey: ["user-detail", appId, params.id],
    queryFn: () => api.users.detail(appId!, params.id),
    enabled: !!appId,
  });

  if (!appId || detail.isPending) {
    return <main className="p-8 text-sm text-muted-foreground">{t("loading")}</main>;
  }
  if (detail.isError) {
    return <main className="p-8 text-sm text-destructive">{t("notFound")}</main>;
  }
  const d = detail.data;
  const pushSub = (d.user.subscriptions as { push?: string })?.push ?? "unknown";

  return (
    <main className="mx-auto max-w-3xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href="/users" className="underline">
            {t("backToUsers")}
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">{d.user.external_id ?? t("anonymous")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("subscription", { push: pushSub === "opted_in" ? t("optedIn") : t("optedOut") })} · {d.user.status}
        </p>
      </header>

      {/* 디바이스 — "왜 안 받았나"의 1차 답 (U-7) */}
      <Card className="mb-4">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">{t("devices")}</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {d.devices.length === 0 && <p className="text-sm text-muted-foreground">{t("noDevices")}</p>}
          {d.devices.map((dev) => (
            <div key={dev.id} className="flex items-center gap-3 border-b border-border/50 py-2 text-sm last:border-0">
              <span className="font-medium">{dev.platform}</span>
              <span className={dev.token_status === "active" ? "text-primary" : "text-destructive"}>
                {t("token")} {t.has(`tokenStatus.${dev.token_status}`) ? t(`tokenStatus.${dev.token_status}`) : dev.token_status}
              </span>
              <span className="text-muted-foreground">{t("permission")} {t.has(`perm.${dev.os_permission}`) ? t(`perm.${dev.os_permission}`) : dev.os_permission}</span>
              {!dev.has_token && <span className="text-xs text-destructive">{t("noToken")}</span>}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* 속성 */}
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">{t("attributes")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-xs">
            {Object.entries({ ...d.user.std_attrs, ...d.user.custom_attrs }).map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-border/30 py-1">
                <span className="text-muted-foreground">{k}</span>
                <span>{JSON.stringify(v)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* 저니 */}
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">{t("journeys")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-xs">
            {d.journeys.length === 0 && <p className="text-muted-foreground">{t("noJourneys")}</p>}
            {d.journeys.map((j, i) => (
              <div key={i} className="border-b border-border/30 py-1">
                <span className="font-medium">{j.name}</span> · {j.status} · {t("node")} {j.current_node}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* 메시지 이력 — skip 사유 포함 (U-7) */}
      <Card className="mt-4">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">{t("messages")}</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {d.messages.length === 0 && <p className="text-sm text-muted-foreground">{t("noMessages")}</p>}
          {d.messages.map((m, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border/30 py-1 text-xs">
              <span className="text-muted-foreground">{m.sent_at}</span>
              <span>{m.channel}</span>
              <span className={m.status === "sent" ? "text-primary" : "text-destructive"}>{m.status}</span>
              {m.failure_class && <span className="text-muted-foreground">— {m.failure_class}</span>}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 활동 */}
      <Card className="mt-4">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">{t("activity")}</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0 text-xs">
          {d.events.map((e, i) => (
            <div key={i} className="flex justify-between border-b border-border/30 py-1">
              <span>{e.event_name}</span>
              <span className="text-muted-foreground">{e.ts}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </main>
  );
}
