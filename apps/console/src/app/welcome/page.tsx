"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { ApiError } from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { SecurityCard } from "@/components/security-card";
import { Button } from "@/components/ui/button";

export default function WelcomePage() {
  const t = useTranslations("welcome");
  const router = useRouter();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.auth.me(), retry: false });
  const status = useQuery({ queryKey: ["totp-status"], queryFn: () => api.auth.totpStatus(), enabled: !!me.data });
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace("/login?setup=complete");
    if (me.error instanceof ApiError && me.error.status === 403) router.replace("/settings?enroll=required");
  }, [me.error, router]);
  if (!me.data) return <main className="mx-auto max-w-xl p-6"><p>{me.isError ? t("error") : t("loading")}</p>
    {me.isError && <Button className="mt-4" onClick={() => me.refetch()}>{t("retry")}</Button>}</main>;
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-6">
      <header>
        <p className="text-xs font-semibold tracking-widest text-primary">{t("step")}</p>
        <h1 className="mt-3 text-2xl font-bold">{t("title")}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t("body")}</p>
      </header>
      <SecurityCard onComplete={() => router.push("/")} />
      <div className="flex flex-col gap-3">
        <Button variant={status.data?.enabled ? "primary" : "outline"} onClick={() => router.push("/")}>
          {status.data?.enabled ? t("dashboard") : t("skip")}
        </Button>
        <p className="text-center text-xs text-muted-foreground">{t("next")}</p>
      </div>
    </main>
  );
}
