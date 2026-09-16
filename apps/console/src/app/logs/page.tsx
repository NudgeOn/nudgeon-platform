"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError, type MessageLogEntry } from "@nudgeon/api-client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { guidanceKey, isRecordId, LOG_LIMIT, LOG_STATUSES, logStatus, matchesLogSearch, statusGroup } from "./log-model";
import "./logs.css";

export default function LogsPage() {
  return <Suspense><MessageLogs /></Suspense>;
}

function MessageLogs() {
  const t = useTranslations("messageLogs");
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const status = logStatus(params.get("status"));
  const journeyId = params.get("journey_id") ?? "";
  const testRunId = params.get("test_run_id") ?? "";
  const validFilters = (!journeyId || isRecordId(journeyId)) && (!testRunId || isRecordId(testRunId));
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.apps.list() });
  const appId = apps.data?.apps[0]?.id;
  const logs = useQuery({
    queryKey: ["message-log", appId, status, journeyId, testRunId],
    queryFn: () => api.messageLog.list(appId!, {
      status: status === "all" ? undefined : status,
      journey_id: journeyId || undefined, test_run_id: testRunId || undefined, limit: LOG_LIMIT,
    }),
    enabled: !!appId && validFilters,
    refetchInterval: autoRefresh ? 15000 : false,
  });
  const journeys = useQuery({ queryKey: ["journeys", appId], queryFn: () => api.journeys.list(appId!), enabled: !!appId });
  const error = apps.error ?? logs.error;
  const authenticated = !(error instanceof ApiError && error.status === 401);
  const forbidden = error instanceof ApiError && error.status === 403;
  const pending = apps.isPending || (!!appId && logs.isPending && validFilters);
  const rows = logs.data?.messages ?? [];
  const filtered = rows.filter((row) => matchesLogSearch(row, search));
  const hasFilters = status !== "all" || !!journeyId || !!testRunId || !!search;
  const stats = logs.isSuccess ? logs.data.recent_hour : undefined;
  const names = new Map(journeys.data?.journeys.map((journey) => [journey.id, journey.name]));
  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value); else next.delete(key);
    router.replace(`/logs${next.size ? `?${next}` : ""}`, { scroll: false });
  }
  function reset() { setSearch(""); router.replace("/logs", { scroll: false }); }

  return <div className="ml-root">
    <header className="ml-topbar"><Link href="/" className="ml-brand">NudgeOn</Link><span>{t("title")}</span><LocaleSwitcher /></header>
    <main className="ml-page">
      <header className="ml-heading"><div><p className="ml-eyebrow">{t("eyebrow")}</p><h1>{t("title")}</h1><p>{t("subtitle")}</p></div>
        <Link href="/onboarding" className="ml-button">{t("testPush")} <span aria-hidden="true">↗</span></Link></header>
      <section className="ml-metrics" aria-label={t("recentHour")}>
        <div className="ml-metric-context"><span className="ml-dot" /><strong>{t("recentHour")}</strong><p>{t("appWide")}</p></div>
        <Metric label={t("total")} value={stats?.total.toLocaleString(locale)} />
        <Metric label={t("failed")} value={stats?.failed.toLocaleString(locale)} danger={!!stats?.failed} />
        <Metric label={t("failureRate")} value={stats ? `${(stats.failure_rate * 100).toLocaleString(locale, { maximumFractionDigits: 1 })}%` : undefined} />
      </section>
      <p className="ml-explainer">{t("acceptanceNote")}</p>
      <section className="ml-log-section" aria-label={t("results")}>
        <div className="ml-toolbar">
          <div className="ml-tabs" role="group" aria-label={t("statusFilter")}>{LOG_STATUSES.map((item) =>
            <button key={item} type="button" aria-pressed={item === status} onClick={() => setFilter("status", item === "all" ? "" : item)}>{t(`status.${item}`)}</button>)}</div>
          <div className="ml-refresh"><label><input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />{t("autoRefresh")}</label>
            <button type="button" className="ml-button" disabled={!appId || !validFilters || logs.isFetching} onClick={() => void logs.refetch()}>{logs.isFetching ? t("refreshing") : t("refresh")}</button></div>
        </div>
        <div className="ml-filters">
          <label>{t("journey")}<select value={journeyId} disabled={!journeys.isSuccess} onChange={(e) => setFilter("journey_id", e.target.value)}>
            <option value="">{t("allJourneys")}</option>
            {journeyId && !names.has(journeyId) && <option value={journeyId}>{journeyId}</option>}
            {journeys.data?.journeys.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select></label>
          <label className="ml-search">{t("search")}<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchPlaceholder")} /></label>
        </div>
        {journeys.isError && <p className="ml-inline-note">{t("journeyError")} <button type="button" onClick={() => void journeys.refetch()}>{t("retry")}</button></p>}
        {testRunId && <div className="ml-run"><span>{t("testRun")}</span><code>{testRunId}</code><button type="button" onClick={() => setFilter("test_run_id", "")}>{t("clearRun")}</button></div>}
        {!validFilters ? <State title={t("invalidFilter")} body={t("invalidFilterBody")} action={<button className="ml-button" onClick={reset}>{t("reset")}</button>} error />
          : error ? <State error title={!authenticated ? t("loginTitle") : forbidden ? t("forbiddenTitle") : t("errorTitle")}
            body={!authenticated ? t("loginBody") : forbidden ? t("forbiddenBody") : t("errorBody")}
            action={!authenticated ? <Link className="ml-button" href="/login">{t("login")}</Link> : !forbidden ? <button className="ml-button" onClick={() => void (apps.isError ? apps.refetch() : logs.refetch())}>{t("retry")}</button> : undefined} />
          : pending ? <State title={t("loading")} body={t("loadingBody")} />
          : !appId ? <State title={t("noApp")} body={t("noAppBody")} action={<Link className="ml-button" href="/onboarding">{t("testPush")}</Link>} />
          : filtered.length === 0 ? <State title={hasFilters ? t("noMatch") : t("emptyTitle")}
            body={testRunId ? t("runWaiting") : hasFilters ? t("noMatchBody") : t("emptyBody")}
            action={hasFilters ? <button className="ml-button" onClick={reset}>{t("reset")}</button> : <Link className="ml-button" href="/onboarding">{t("testPush")}</Link>} />
          : <div className="ml-rows"><div className="ml-columns" aria-hidden="true"><span>{t("col.message")}</span><span>{t("col.status")}</span><span>{t("col.journey")}</span><span>{t("col.time")}</span></div>
            {filtered.map((row, index) => <LogRow key={`${row.message_id}-${index}`} row={row} journeyName={names.get(row.journey_id)} />)}</div>}
        {logs.isSuccess && <footer className="ml-footer"><span>{t("showing", { shown: filtered.length, count: rows.length, limit: LOG_LIMIT })}</span>
          <span>{t("updated", { time: new Date(logs.dataUpdatedAt).toLocaleTimeString(locale) })}</span></footer>}
      </section>
      <div className="ml-next"><div><strong>{t("nextTitle")}</strong><p>{t("nextBody")}</p></div><Link href="/journeys">{t("nextAction")} →</Link></div>
    </main>
  </div>;
}

function Metric({ label, value, danger }: { label: string; value?: string; danger?: boolean }) {
  return <div className="ml-metric"><span>{label}</span><strong className={danger ? "ml-danger" : undefined}>{value ?? "—"}</strong></div>;
}
function State({ title, body, action, error }: { title: string; body: string; action?: React.ReactNode; error?: boolean }) {
  return <div className="ml-state" role={error ? "alert" : "status"}><span aria-hidden="true">{error ? "!" : "◎"}</span><h2>{title}</h2><p>{body}</p>{action}</div>;
}
function LogRow({ row, journeyName }: { row: MessageLogEntry; journeyName?: string }) {
  const t = useTranslations("messageLogs");
  const isJourney = isRecordId(row.journey_id);
  const knownStatus = t.has(`status.${row.status}`);
  const test = row.campaign_ref.startsWith("test:");
  return <details className="ml-row">
    <summary><span className="ml-row-message"><span className="ml-channel">{row.channel.toUpperCase()}</span><strong>{row.message_id.slice(0, 8)}…</strong><span className="ml-row-reason">{row.failure_class || (test ? t("testMessage") : t("message"))}</span></span>
      <span className={`ml-status ml-status-${statusGroup(row.status)}`}>{knownStatus ? t(`status.${row.status}`) : row.status}</span>
      <span className="ml-row-journey">{isJourney ? journeyName ?? row.journey_id.slice(0, 8) : test ? t("testMessage") : t("noJourney")}</span>
      <span className="ml-time">{row.sent_at}<span aria-hidden="true">⌄</span></span>
    </summary>
    <div className="ml-detail"><div className="ml-guidance"><strong>{t("detailTitle")}</strong><p>{t(`guidance.${guidanceKey(row)}`)}</p>
      {row.failure_detail && <pre>{row.failure_detail}</pre>}
      <div className="ml-detail-links">{isRecordId(row.user_id) && <Link href={`/users/${row.user_id}`}>{t("inspectUser")} →</Link>}
        {isJourney && <Link href={`/journeys/${row.journey_id}/report`}>{t("inspectJourney")} →</Link>}
        <Link href="/settings">{t("inspectSettings")} →</Link></div></div>
      <dl><dt>{t("messageId")}</dt><dd><CopyId value={row.message_id} /></dd>
        <dt>{t("userId")}</dt><dd>{row.user_id}</dd><dt>{t("deviceId")}</dt><dd>{row.device_id}</dd>
        <dt>{t("reference")}</dt><dd>{row.campaign_ref || "—"}</dd>
        {row.failure_class && <><dt>{t("failureClass")}</dt><dd>{row.failure_class}</dd></>}
      </dl></div>
  </details>;
}
function CopyId({ value }: { value: string }) {
  const t = useTranslations("messageLogs");
  const [state, setState] = useState<"copy" | "copied" | "copyFailed">("copy");
  return <span className="ml-copy"><code>{value}</code><button type="button" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setState("copied"); } catch { setState("copyFailed"); }
  }}>{t(state)}</button><span className="sr-only" role="status">{state !== "copy" ? t(state) : ""}</span></span>;
}
