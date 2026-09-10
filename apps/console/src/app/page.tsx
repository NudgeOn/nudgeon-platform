"use client";

import { useQuery, useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { api } from "@/lib/api";
import { useAppId } from "./use-app-id";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function DashboardPage() {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.auth.me(), retry: false });
  const appId = useAppId();
  const dashboard = useQuery({
    queryKey: ["dashboard", appId],
    queryFn: () => api.analytics.dashboard(appId!),
    enabled: !!appId,
  });
  const usage = useQuery({
    queryKey: ["usage", appId],
    queryFn: () => api.analytics.usage(appId!),
    enabled: !!appId,
  });
  const uninstalls = useQuery({
    queryKey: ["uninstalls", appId],
    queryFn: () => api.analytics.uninstalls(appId!, 30),
    enabled: !!appId,
  });
  const logout = useMutation({
    mutationFn: () => api.auth.logout(),
    onSuccess: () => router.push("/login"),
  });
  const sweep = useMutation({
    mutationFn: () => api.analytics.uninstallSweep(appId!),
    onSuccess: () => uninstalls.refetch(),
  });

  useEffect(() => {
    if (me.isError) router.push("/login");
  }, [me.isError, router]);

  if (me.isPending || me.isError) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">
            {me.data.name} ({me.data.email}) · {me.data.role}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LocaleSwitcher />
          <Button variant="outline" onClick={() => logout.mutate()}>
            {t("logout")}
          </Button>
        </div>
      </header>

      {/* today metrics (PRD-07) */}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label={t("stat.sentToday")} value={dashboard.data?.today.sent ?? 0} />
        <Stat label={t("stat.failedToday")} value={dashboard.data?.today.failed ?? 0} accent={(dashboard.data?.today.failed ?? 0) > 0} />
        <Stat label={t("stat.skippedToday")} value={dashboard.data?.today.skipped ?? 0} />
        <Stat label={t("stat.activeJourneys")} value={dashboard.data?.active_journeys ?? 0} />
      </div>
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3">
        <Stat label={t("stat.dau")} value={usage.data?.dau_today ?? 0} />
        <Stat label={t("stat.mau")} value={usage.data?.mau_30d ?? 0} />
        <Stat
          label={t("stat.uninstalls", { rate: ((uninstalls.data?.uninstall_rate ?? 0) * 100).toFixed(2) })}
          value={uninstalls.data?.uninstalls ?? 0}
          accent={(uninstalls.data?.uninstalls ?? 0) > 0}
        />
        <Stat
          label={t("stat.sends30d")}
          value={usage.data?.sends_30d.reduce((a, b) => a + b.sent, 0) ?? 0}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("getStarted")}</CardTitle>
          <CardDescription>
            {t("getStartedDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 [&>button]:shrink-0 [&>button]:whitespace-nowrap">
          <Button onClick={() => router.push("/onboarding")}>{t("openOnboarding")}</Button>
          <Button variant="outline" onClick={() => router.push("/segments")}>
            {t("nav.segments")}
          </Button>
          <Button variant="outline" onClick={() => router.push("/journeys")}>
            {t("nav.journeys")}
          </Button>
          <Button variant="outline" onClick={() => router.push("/logs")}>
            {t("nav.logs")}
          </Button>
          <Button variant="outline" onClick={() => router.push("/users")}>
            {t("nav.users")}
          </Button>
          <Button variant="outline" onClick={() => router.push("/data")}>
            {t("nav.data")}
          </Button>
          <Button variant="outline" onClick={() => router.push("/settings")}>
            {t("nav.settings")}
          </Button>
          {me.data.permissions?.includes("journeys:read") && (
            <>
              <Button variant="outline" onClick={() => router.push("/email-templates")}>
                {t("nav.emailTemplates")}
              </Button>
              <Button variant="outline" onClick={() => router.push("/channels/alimtalk")}>
                {t("nav.alimtalk")}
              </Button>
            </>
          )}
          {me.data.permissions?.includes("journeys:activate") && (
            <Button variant="outline" disabled={sweep.isPending} onClick={() => sweep.mutate()}>
              {sweep.isPending ? t("nav.sweeping") : t("nav.sweep")}
            </Button>
          )}
          {me.data.permissions?.includes("team:read") && (
            <>
              <Button variant="outline" onClick={() => router.push("/team")}>
                {t("nav.team")}
              </Button>
              <Button variant="outline" onClick={() => router.push("/audit")}>
                {t("nav.audit")}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`mt-1 text-2xl font-bold ${accent ? "text-destructive" : ""}`}>
          {value.toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}
