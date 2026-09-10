"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { ApiError, type Member, type MemberRole } from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ROLES: MemberRole[] = ["owner", "admin", "editor", "viewer"];

/** 팀 멤버 관리 (R-16). team:read 조회 / team:write 생성·역할변경·삭제 / member:reset_2fa 리셋. */
export default function TeamPage() {
  const t = useTranslations("team");
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.auth.me(), retry: false });
  const perms = me.data?.permissions ?? [];
  const canRead = perms.includes("team:read");
  const canWrite = perms.includes("team:write");
  const canReset = perms.includes("member:reset_2fa");

  const members = useQuery({
    queryKey: ["members"],
    queryFn: () => api.members.list(),
    enabled: canRead,
  });

  const [err, setErr] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["members"] });
  const onErr = (e: unknown) =>
    setErr(e instanceof ApiError ? e.message : t("requestFailed"));

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: MemberRole }) => api.members.changeRole(id, role),
    onSuccess: () => { setErr(null); refresh(); },
    onError: onErr,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.members.remove(id),
    onSuccess: () => { setErr(null); refresh(); },
    onError: onErr,
  });
  const resetTotp = useMutation({
    mutationFn: (id: string) => api.members.resetTotp(id),
    onSuccess: () => setErr(null),
    onError: onErr,
  });

  if (me.isPending) return <Shell><p className="text-sm text-muted-foreground">{t("loading")}</p></Shell>;
  if (!canRead) return <Shell><p className="text-sm text-destructive">{t("noPermission")}</p></Shell>;

  return (
    <Shell>
      {err && <p className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{err}</p>}

      {canWrite && <InviteCard onDone={() => { setErr(null); refresh(); }} onError={onErr} />}

      <Card>
        <CardHeader className="p-4">
          <CardTitle className="text-sm">{t("members", { count: members.data?.members.length ?? 0 })}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="p-3">{t("col.email")}</th>
                  <th className="p-3">{t("col.name")}</th>
                  <th className="p-3">{t("col.role")}</th>
                  <th className="p-3">2FA</th>
                  <th className="p-3">{t("col.status")}</th>
                  <th className="p-3 text-right">{t("col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {members.data?.members.map((m: Member) => (
                  <tr key={m.id} className="border-b border-border/50">
                    <td className="p-3">{m.email}</td>
                    <td className="p-3">{m.name}</td>
                    <td className="p-3">
                      {canWrite ? (
                        <select
                          className="h-8 rounded-md border border-border bg-card px-2 text-sm"
                          value={m.role}
                          disabled={changeRole.isPending}
                          onChange={(e) => changeRole.mutate({ id: m.id, role: e.target.value as MemberRole })}
                        >
                          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      ) : (
                        <span>{m.role}</span>
                      )}
                    </td>
                    <td className="p-3">
                      <span className={m.totp_enabled ? "text-primary" : "text-muted-foreground"}>
                        {m.totp_enabled ? t("totpOn") : t("totpOff")}
                      </span>
                    </td>
                    <td className="p-3">
                      <span className={m.status === "active" ? "" : "text-muted-foreground"}>{m.status}</span>
                    </td>
                    <td className="p-3">
                      <div className="flex justify-end gap-2">
                        {canReset && m.totp_enabled && (
                          <Button variant="outline" className="h-8 px-2 text-xs"
                            disabled={resetTotp.isPending}
                            onClick={() => { if (confirm(t("confirmReset", { email: m.email }))) resetTotp.mutate(m.id); }}>
                            {t("reset2fa")}
                          </Button>
                        )}
                        {canWrite && m.status === "active" && (
                          <Button variant="outline" className="h-8 px-2 text-xs text-destructive"
                            disabled={remove.isPending}
                            onClick={() => { if (confirm(t("confirmRemove", { email: m.email }))) remove.mutate(m.id); }}>
                            {t("remove")}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {members.isPending && <p className="p-4 text-sm text-muted-foreground">{t("loadingMembers")}</p>}
        </CardContent>
      </Card>

      <p className="mt-4 text-xs text-muted-foreground">
        {t("rules")}
      </p>
    </Shell>
  );
}

function InviteCard({ onDone, onError }: { onDone: () => void; onError: (e: unknown) => void }) {
  const t = useTranslations("team");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<MemberRole>("viewer");
  const [password, setPassword] = useState("");
  const create = useMutation({
    mutationFn: () => api.members.create({ email, name, role, password }),
    onSuccess: () => { setEmail(""); setName(""); setPassword(""); setRole("viewer"); onDone(); },
    onError,
  });
  return (
    <Card className="mb-4">
      <CardHeader className="p-4"><CardTitle className="text-sm">{t("invite.title")}</CardTitle></CardHeader>
      <CardContent className="p-4 pt-0">
        <form className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-email">{t("col.email")}</Label>
            <Input id="m-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-56" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-name">{t("col.name")}</Label>
            <Input id="m-name" required value={name} onChange={(e) => setName(e.target.value)} className="w-40" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-role">{t("col.role")}</Label>
            <select id="m-role" className="h-9 rounded-md border border-border bg-card px-2 text-sm"
              value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-pw">{t("invite.password")}</Label>
            <Input id="m-pw" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="w-48" />
          </div>
          <Button type="submit" disabled={create.isPending}>{create.isPending ? t("invite.adding") : t("invite.add")}</Button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">{t("invite.note")}</p>
      </CardContent>
    </Card>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("team");
  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground"><Link href="/" className="underline">{t("backToDashboard")}</Link></p>
        <h1 className="mt-2 text-2xl font-bold">{t("title")}</h1>
      </header>
      {children}
    </main>
  );
}
