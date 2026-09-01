"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { ApiError, type Member, type MemberRole } from "@onda/api-client";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ROLES: MemberRole[] = ["owner", "admin", "editor", "viewer"];

/** 팀 멤버 관리 (R-16). team:read 조회 / team:write 생성·역할변경·삭제 / member:reset_2fa 리셋. */
export default function TeamPage() {
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
    setErr(e instanceof ApiError ? e.message : "요청에 실패했습니다");

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

  if (me.isPending) return <Shell><p className="text-sm text-muted-foreground">불러오는 중…</p></Shell>;
  if (!canRead) return <Shell><p className="text-sm text-destructive">팀 관리 권한이 없습니다.</p></Shell>;

  return (
    <Shell>
      {err && <p className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{err}</p>}

      {canWrite && <InviteCard onDone={() => { setErr(null); refresh(); }} onError={onErr} />}

      <Card>
        <CardHeader className="p-4">
          <CardTitle className="text-sm">멤버 ({members.data?.members.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="p-3">이메일</th>
                  <th className="p-3">이름</th>
                  <th className="p-3">역할</th>
                  <th className="p-3">2FA</th>
                  <th className="p-3">상태</th>
                  <th className="p-3 text-right">작업</th>
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
                        {m.totp_enabled ? "사용" : "미사용"}
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
                            onClick={() => { if (confirm(`${m.email}의 2FA를 리셋할까요? (해당 멤버 세션도 폐기됩니다)`)) resetTotp.mutate(m.id); }}>
                            2FA 리셋
                          </Button>
                        )}
                        {canWrite && m.status === "active" && (
                          <Button variant="outline" className="h-8 px-2 text-xs text-destructive"
                            disabled={remove.isPending}
                            onClick={() => { if (confirm(`${m.email}을(를) 제거할까요? (세션 폐기·재로그인 차단)`)) remove.mutate(m.id); }}>
                            제거
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {members.isPending && <p className="p-4 text-sm text-muted-foreground">멤버 불러오는 중…</p>}
        </CardContent>
      </Card>

      <p className="mt-4 text-xs text-muted-foreground">
        · 최소 1명의 Owner는 강등·삭제할 수 없습니다. · Owner 역할 지정/관리는 Owner만 가능합니다.
        · 역할 변경·제거 시 해당 멤버의 세션은 즉시 폐기됩니다.
      </p>
    </Shell>
  );
}

function InviteCard({ onDone, onError }: { onDone: () => void; onError: (e: unknown) => void }) {
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
      <CardHeader className="p-4"><CardTitle className="text-sm">멤버 추가</CardTitle></CardHeader>
      <CardContent className="p-4 pt-0">
        <form className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-email">이메일</Label>
            <Input id="m-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-56" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-name">이름</Label>
            <Input id="m-name" required value={name} onChange={(e) => setName(e.target.value)} className="w-40" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-role">역할</Label>
            <select id="m-role" className="h-9 rounded-md border border-border bg-card px-2 text-sm"
              value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-pw">초기 비밀번호</Label>
            <Input id="m-pw" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="w-48" />
          </div>
          <Button type="submit" disabled={create.isPending}>{create.isPending ? "추가 중…" : "추가"}</Button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">셀프호스팅: 관리자가 초기 비밀번호를 지정합니다(이메일 초대 링크는 후속).</p>
      </CardContent>
    </Card>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground"><Link href="/" className="underline">← 대시보드</Link></p>
        <h1 className="mt-2 text-2xl font-bold">팀 관리</h1>
      </header>
      {children}
    </main>
  );
}
