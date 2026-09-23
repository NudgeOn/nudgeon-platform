"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@nudgeon/api-client";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LocaleSwitcher } from "@/components/locale-switcher";

export default function McpConnectionsPage() {
  const t = useTranslations("mcp"), locale = useLocale();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.auth.me(), retry: false });
  const status = useQuery({ queryKey: ["mcp-status"], queryFn: () => api.mcp.status(), enabled: !!me.data, retry: false });
  const connections = useQuery({ queryKey: ["mcp-connections"], queryFn: () => api.mcp.connections(), enabled: !!me.data && status.data?.enabled === true, retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ["mcp-connections"] });
  const revoke = useMutation({ mutationFn: (id: string) => api.mcp.revoke(id), onSuccess: refresh });
  const approve = useMutation({ mutationFn: ({ id, allowed }: { id: string; allowed: boolean }) => api.mcp.approveCustomerAccess(id, allowed), onSuccess: refresh });
  const admin = me.data?.role === "admin" || me.data?.role === "owner";
  const error = me.error ?? status.error ?? connections.error ?? revoke.error ?? approve.error;

  return <main className="mx-auto max-w-4xl p-4 sm:p-8">
    <header className="mb-6 flex items-start justify-between gap-4"><div>
      <Link className="text-sm text-muted-foreground underline" href="/settings">{t("back")}</Link>
      <h1 className="mt-2 text-2xl font-bold">{t("title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("intro")}</p>
    </div><LocaleSwitcher /></header>
    {error && <div role="alert" className="mb-4 rounded-md border border-destructive/30 p-4 text-sm text-destructive">
      <p>{error instanceof ApiError && error.status === 401 ? t("loginRequired") : t("error")}</p>
      {error instanceof ApiError && error.status === 401 && <Link className="underline" href="/login?return_to=%2Fsettings%2Fmcp">{t("login")}</Link>}
      <Button className="mt-2" variant="outline" onClick={() => { void me.refetch(); void status.refetch(); void connections.refetch(); }}>{t("retry")}</Button>
    </div>}
    {(me.isPending || (me.data && status.isPending)) && <p role="status">{t("loading")}</p>}
    {status.data && <Card className="mb-6"><CardHeader><CardTitle className="text-base">{t("endpoint")}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">{status.data.enabled ? t("connectHint") : t("disabled")}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start"><code className="min-w-0 flex-1 break-all rounded bg-muted p-3">{status.data.endpoint}</code>
          <Button variant="outline" disabled={!status.data.enabled} onClick={async () => {
            try { await navigator.clipboard.writeText(status.data!.endpoint); setCopied(true); setCopyError(false); }
            catch { setCopyError(true); }
          }}>{t("copy")}</Button></div>
        <p role="status">{copyError ? t("copyFailed") : copied ? t("copied") : ""}</p>
        <p className="text-muted-foreground">{t("limits")}</p>
      </CardContent></Card>}
    <h2 className="mb-2 text-lg font-semibold">{admin ? t("allConnections") : t("myConnections")}</h2>
    <p className="mb-4 text-sm text-muted-foreground">{t("roleHint")}</p>
    {connections.isFetching && <p role="status" className="text-sm">{t("loading")}</p>}
    {connections.data?.connections.length === 0 && <p className="rounded-md border border-border p-6 text-sm text-muted-foreground">{t("empty")}</p>}
    <div className="space-y-3">{connections.data?.connections.map((connection) => <Card key={connection.id}>
      <CardHeader className="p-4"><CardTitle className="flex flex-wrap justify-between gap-2 text-base">
        <span className="break-words">{connection.client_name} · {connection.app_name}</span>
        <span className="text-xs font-normal text-muted-foreground">{connection.revoked_at ? t("revoked") : t("active")}</span>
      </CardTitle></CardHeader>
      <CardContent className="space-y-3 p-4 pt-0 text-sm">
        {admin && <p className="break-all text-muted-foreground">{connection.member_email}</p>}
        <div className="flex flex-wrap gap-2">{connection.scopes.map((scope) => <span key={scope} className="rounded bg-muted px-2 py-1 text-xs">{scope === "mcp:drafts:write" ? t("scopeWrite") : scope === "mcp:customers:read" ? t("scopeCustomers") : t("scopeRead")}</span>)}</div>
        <p className="text-muted-foreground">{t("lastUsed")}: {connection.last_used_at ? new Date(connection.last_used_at).toLocaleString(locale) : t("never")}</p>
        <p>{connection.customer_access_approved ? t("customerApproved") : t("customerBlocked")}</p>
        {!connection.revoked_at && <div className="flex flex-wrap gap-2">
          {admin && <Button variant="outline" disabled={approve.isPending || revoke.isPending} onClick={() => approve.mutate({ id: connection.id, allowed: !connection.customer_access_approved })}>
            {connection.customer_access_approved ? t("blockCustomers") : t("approveCustomers")}
          </Button>}
          <Button variant="outline" className="text-destructive" disabled={revoke.isPending || approve.isPending} onClick={() => revoke.mutate(connection.id)}>{t("revoke")}</Button>
        </div>}
      </CardContent>
    </Card>)}</div>
  </main>;
}
