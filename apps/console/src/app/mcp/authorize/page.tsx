"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, type McpScope } from "@nudgeon/api-client";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LocaleSwitcher } from "@/components/locale-switcher";

export default function McpAuthorizePage() { return <Suspense><Authorize /></Suspense>; }

function Authorize() {
  const t = useTranslations("mcp");
  const search = useSearchParams();
  const requestId = search.get("request_id") ?? "";
  const returnTo = `/mcp/authorize?request_id=${encodeURIComponent(requestId)}`;
  const [appId, setAppId] = useState("");
  const [write, setWrite] = useState(false), [customers, setCustomers] = useState(false);
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.auth.me(), retry: false });
  const context = useQuery({ queryKey: ["mcp-authorization", requestId], queryFn: () => api.mcp.authorization(requestId), enabled: !!requestId && !!me.data, retry: false });
  const connections = useQuery({ queryKey: ["mcp-connections"], queryFn: () => api.mcp.connections(), enabled: !!me.data && !!context.data, retry: false });
  const selectedApp = appId || context.data?.apps[0]?.id || "";
  const approved = connections.data?.connections.filter((c) => c.member_id === me.data?.member_id && c.app_id === selectedApp && c.client_id === context.data?.client_id && c.customer_access_approved && !c.revoked_at) ?? [];
  const admin = me.data?.role === "admin" || me.data?.role === "owner";
  const allowCustomers = admin || approved.length > 0;
  const requested = context.data?.requested_scopes ?? [];
  const allowWrite = me.data?.permissions?.includes("segments:write") || me.data?.permissions?.includes("journeys:write");
  const authorize = useMutation({
    mutationFn: (approve: boolean) => {
      if (!approve) return api.mcp.authorize(requestId, { approve: false });
      const scopes: McpScope[] = ["mcp:read"];
      if (write && allowWrite && requested.includes("mcp:drafts:write")) scopes.push("mcp:drafts:write");
      if (customers && requested.includes("mcp:customers:read") && allowCustomers) scopes.push("mcp:customers:read");
      return api.mcp.authorize(requestId, { app_id: selectedApp, scopes, approve: true });
    },
    // The server validates the registered client's exact redirect URI. Never use a query parameter here.
    onSuccess: ({ redirect_uri }) => { window.location.assign(redirect_uri); },
  });
  const error = me.error ?? context.error ?? authorize.error;
  const enrollment = error instanceof ApiError && error.status === 403 && typeof error.body === "object" && error.body !== null && "code" in error.body && error.body.code === "enrollment_required";
  const expired = !!context.data && new Date(context.data.expires_at).getTime() <= Date.now();

  return <main className="mx-auto max-w-xl p-4 sm:p-8"><div className="mb-6 flex justify-end"><LocaleSwitcher /></div>
    <Card><CardHeader><CardTitle>{t("authorizeTitle")}</CardTitle></CardHeader><CardContent className="space-y-5 text-sm">
      {!requestId && <p role="alert" className="text-destructive">{t("invalidRequest")}</p>}
      {(me.isPending || (!!me.data && context.isPending && !!requestId)) && <p role="status">{t("loading")}</p>}
      {error && <div role="alert" className="space-y-2 text-destructive"><p>{error instanceof ApiError && error.status === 401 ? t("loginRequired") : enrollment ? t("enrollmentRequired") : t("authorizeError")}</p>
        {error instanceof ApiError && error.status === 401 && <Link className="underline" href={`/login?return_to=${encodeURIComponent(returnTo)}`}>{t("login")}</Link>}
        {enrollment && <Link className="underline" href={`/settings?enroll=required&return_to=${encodeURIComponent(returnTo)}`}>{t("enroll")}</Link>}
      </div>}
      {context.data && <>
        <p>{t("authorizeIntro", { client: context.data.client_name })}</p>
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-muted-foreground">{t("unverifiedClient")}</p>
          <dl className="space-y-2"><div><dt className="font-medium">{t("callbackOrigin")}</dt><dd className="break-all font-mono text-xs">{new URL(context.data.redirect_uri).origin}</dd></div>
            <div><dt className="font-medium">{t("clientId")}</dt><dd className="break-all font-mono text-xs">{context.data.client_id}</dd></div></dl>
        </div>
        <p className="break-all text-muted-foreground">{me.data?.email} · {me.data?.role}</p>
        <label className="flex flex-col gap-2 font-medium">{t("app")}
          <select className="min-w-0 rounded-md border border-border bg-card p-2" value={selectedApp} disabled={authorize.isPending} onChange={(e) => { setAppId(e.target.value); setCustomers(false); }}>
            {context.data.apps.map((app) => <option value={app.id} key={app.id}>{app.name}</option>)}
          </select>
        </label>
        <fieldset className="space-y-3" disabled={authorize.isPending}>
          <legend className="mb-3 font-semibold">{t("permissions")}</legend>
          <p>{t("scopeRead")} — {t("readHint")}</p>
          {requested.includes("mcp:drafts:write") && <label className="flex items-start gap-2"><input className="mt-1" type="checkbox" checked={write} disabled={!allowWrite} onChange={(e) => setWrite(e.target.checked)} /><span>{t("scopeWrite")}<span className="mt-1 block text-muted-foreground">{allowWrite ? t("writeHint") : t("viewerHint")}</span></span></label>}
          {requested.includes("mcp:customers:read") && <label className="flex items-start gap-2"><input className="mt-1" type="checkbox" checked={customers} disabled={!allowCustomers} onChange={(e) => setCustomers(e.target.checked)} /><span>{t("scopeCustomers")}<span className="mt-1 block text-muted-foreground">{admin ? t("customersAdminHint") : t("customersHint")}</span></span></label>}
        </fieldset>
        <p className="rounded-md bg-muted p-3 text-muted-foreground">{t("limits")}</p>
        {expired && <p role="alert" className="text-destructive">{t("expired")}</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={!selectedApp || expired || authorize.isPending} onClick={() => authorize.mutate(true)}>{authorize.isPending ? t("loading") : t("allow")}</Button>
          <Button variant="outline" disabled={authorize.isPending || expired} onClick={() => authorize.mutate(false)}>{t("deny")}</Button>
        </div>
      </>}
    </CardContent></Card>
  </main>;
}
