"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, type TestPushInput } from "@nudgeon/api-client";
import Link from "next/link";
import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function TestPushStep({ appId }: { appId: string }) {
  const t = useTranslations("onboarding.testPush");
  const locale = useLocale();
  const cache = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const [externalId, setExternalId] = useState("");
  const [customer, setCustomer] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [request, setRequest] = useState<{ key: string; input: TestPushInput } | null>(null);
  const targets = useQuery({ queryKey: ["test-push-targets", appId, customer],
    queryFn: () => api.apps.testPushTargets(appId, customer), enabled: !!customer });
  const history = useQuery({ queryKey: ["test-push-runs", appId], queryFn: () => api.apps.testPushRuns(appId),
    refetchInterval: (q) => q.state.data?.runs.some((r) => r.pending_count > 0) ? 5000 : false });
  const send = useMutation({ mutationFn: (r: NonNullable<typeof request>) => api.apps.testPush(appId, r.input, r.key), retry: false,
    onSuccess: () => { dialog.current?.close(); void cache.invalidateQueries({ queryKey: ["test-push-runs", appId] }); } });
  const selected = targets.data?.devices.find((d) => d.device_id === deviceId);
  const locked = !!request;
  const error = send.error ?? targets.error;
  const errorText = error instanceof ApiError && error.status === 403 ? t("permissionDenied")
    : error instanceof ApiError && error.status === 401 ? t("loginRequired")
    : error instanceof ApiError && error.status === 400 ? t("failed") : t("requestFailed");

  return <div className="flex min-w-0 flex-col gap-4 text-sm">
    <p className="text-muted-foreground">{t.rich("instruction", { code: (c) => <code>{c}</code> })}</p>
    <form className="flex flex-col gap-2" onSubmit={(e) => {
      e.preventDefault(); if (locked || !externalId.trim()) return;
      setDeviceId(""); setCustomer(externalId.trim());
      if (customer === externalId.trim()) void targets.refetch();
    }}>
      <Label htmlFor="test-customer-id">{t("externalId")}</Label>
      <div className="flex flex-wrap gap-2"><Input id="test-customer-id" placeholder="external_id" maxLength={256}
        disabled={locked} value={externalId} onChange={(e) => { setExternalId(e.target.value); setDeviceId(""); setCustomer(""); }} className="max-w-xs" />
        <Button type="submit" variant="outline" disabled={locked || !externalId.trim() || targets.isFetching}>{targets.isFetching ? t("searching") : t("findDevices")}</Button></div>
    </form>
    {customer && targets.isSuccess && <fieldset className="flex min-w-0 flex-col gap-2" disabled={locked}>
      <legend className="mb-2 font-medium">{t("chooseDevice")}</legend>
      {!targets.data.devices.length && <p role="status" className="text-muted-foreground">{t("noDevices")}</p>}
      {targets.data.devices.map((d) => <label key={d.device_id} className={`flex min-w-0 gap-3 rounded-md border p-3 ${deviceId === d.device_id ? "border-primary bg-muted" : "border-border"}`}>
        <input type="radio" name="test-device" value={d.device_id} checked={deviceId === d.device_id} disabled={!d.eligible}
          onChange={() => setDeviceId(d.device_id)} className="mt-1 shrink-0" />
        <span className="min-w-0"><strong>{d.platform === "ios" ? "iOS · APNs" : "Android · FCM"}</strong>
          <code className="mt-1 block break-all text-xs">{d.device_id}</code>
          <span className="mt-1 block text-xs text-muted-foreground">{d.last_active_at ? t("lastSeen", { time: new Date(d.last_active_at).toLocaleString(locale) }) : t("lastSeenUnknown")}</span>
          <span className="mt-1 block text-xs">{d.eligible ? t("eligible") : [!d.has_token || d.token_status !== "active" ? t("tokenIssue") : "",
            d.os_permission !== "granted" ? t("permissionIssue") : "", !d.channel_verified ? t("channelIssue") : ""].filter(Boolean).join(" · ")}</span>
        </span>
      </label>)}
    </fieldset>}
    {!locked && <Button className="w-fit" disabled={!selected?.eligible} onClick={() => dialog.current?.showModal()}>{t("review")}</Button>}
    <dialog ref={dialog} aria-labelledby="test-review-title" className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border border-border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/40">
      <h3 id="test-review-title" className="text-lg font-semibold">{t("reviewTitle")}</h3>
      <p className="mt-3 break-all">{t("externalId")}: {customer}</p>
      <p className="mt-2 break-all text-xs">{selected?.platform.toUpperCase()} · {deviceId}</p>
      <div className="my-4 rounded-lg bg-muted p-4"><strong>{t("pushTitle")}</strong><p>{t("pushBody")}</p></div>
      <p className="text-muted-foreground">{t("reviewNote")}</p>
      <div className="mt-5 flex flex-wrap gap-2"><Button disabled={send.isPending} onClick={() => {
        if (request || !selected?.eligible) return;
        const next = { key: crypto.randomUUID(), input: { external_id: customer, device_id: deviceId, title: t("pushTitle"), body: t("pushBody") } };
        setRequest(next); dialog.current?.close(); send.mutate(next);
      }}>{t("confirmSend")}</Button><Button variant="outline" onClick={() => dialog.current?.close()}>{t("cancel")}</Button></div>
    </dialog>
    {send.isPending && <p role="status">{t("sending")}</p>}
    {send.isSuccess && <div className="rounded-md border border-border bg-muted p-4" role="status">
      <p className="font-medium">{t("accepted")}</p><p className="mt-2 text-muted-foreground">{t("queueNote")}</p>
      <Link className="mt-3 inline-block text-primary underline" href={`/logs?test_run_id=${send.data.test_run_id}`}>{t("viewLogs")} →</Link>
    </div>}
    {error && <div role="alert"><p className="text-destructive">{errorText}</p>
      {send.isError && request && <><p className="my-2 text-muted-foreground">{t("retryNote")}</p><Button variant="outline" onClick={() => send.mutate(request)}>{t("retrySame")}</Button></>}
      {error instanceof ApiError && error.status === 401 && <Link href="/login" className="ml-2 text-primary underline">{t("login")}</Link>}
    </div>}
    {locked && !send.isPending && <Button variant="ghost" className="w-fit" onClick={() => { setRequest(null); send.reset(); setDeviceId(""); void targets.refetch(); }}>{t("newTest")}</Button>}
    <section className="min-w-0 border-t border-border pt-4" aria-label={t("history")}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{t("history")}</h3>
        <Button variant="ghost" disabled={history.isFetching} onClick={() => void history.refetch()}>{t("refresh")}</Button></div>
      <p className="mb-3 text-xs text-muted-foreground">{t("historyNote")}</p>
      {history.isPending && <p role="status">{t("searching")}</p>}
      {history.isError && <p role="alert" className="text-destructive">{t("historyError")}</p>}
      {history.isSuccess && !history.data.runs.length && <p className="text-muted-foreground">{t("historyEmpty")}</p>}
      <ul className="flex flex-col gap-3">{history.data?.runs.map((r) => <li key={r.test_run_id} className="rounded-md border border-border p-3">
        <p>{new Date(r.accepted_at).toLocaleString(locale)} · {t("acceptedCount", { count: r.messages.length })}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("publishedCount", { count: r.queued_count, total: r.messages.length })}</p>
        {r.removed_count > 0 && <p className="mt-1 text-xs text-muted-foreground">{t("removedCount", { count: r.removed_count })}</p>}
        <code className="mt-1 block break-all text-xs">{r.test_run_id}</code>
        <div className="mt-2 flex flex-wrap gap-4"><Link className="text-primary underline" href={`/logs?test_run_id=${r.test_run_id}`}>{t("viewLogs")}</Link>
          <Link className="text-primary underline" href={`/logs?test_run_id=${r.test_run_id}&status=failed`}>{t("viewFailures")}</Link></div>
      </li>)}</ul>
    </section>
  </div>;
}
