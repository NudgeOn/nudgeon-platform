"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useAppId } from "../use-app-id";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default function UsersPage() {
  const appId = useAppId();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const search = useQuery({
    queryKey: ["user-search", appId, query],
    queryFn: () => api.users.search(appId!, query),
    enabled: !!appId && query.length > 0,
  });

  return (
    <main className="mx-auto max-w-3xl p-8">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">
          <Link href="/" className="underline">
            ← 대시보드
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">유저 검색</h1>
      </header>

      <form
        className="mb-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(input.trim());
        }}
      >
        <Input
          placeholder="external_id 또는 email (완전 일치)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <Button type="submit">검색</Button>
      </form>

      {search.data && (
        <div className="flex flex-col gap-2">
          {search.data.users.length === 0 && (
            <p className="text-sm text-muted-foreground">일치하는 유저가 없습니다.</p>
          )}
          {search.data.users.map((u) => (
            <Link key={u.id} href={`/users/${u.id}`}>
              <Card className="transition-colors hover:border-primary">
                <CardContent className="flex items-center justify-between p-4 text-sm">
                  <div>
                    <div className="font-medium">{u.external_id ?? "(익명)"}</div>
                    <div className="text-xs text-muted-foreground">{u.email ?? u.id}</div>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {u.last_seen_at ? new Date(u.last_seen_at).toLocaleDateString("ko-KR") : "—"}
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
