"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ApiError,
  type InAppCampaign,
  type InAppCampaignInput,
} from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { useAppId } from "../../use-app-id";
import { Button } from "@/components/ui/button";
import { LocaleSwitcher } from "@/components/locale-switcher";
import "../workbench.css";
import "./campaigns.css";
import { ReviewRunLookup } from "./review-run-lookup";
const localDate = (value: string) => {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
export default function CampaignPage() {
  const t = useTranslations("inAppCampaigns"),
    app = useAppId(),
    qc = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api.auth.me(),
    retry: false,
  });
  const status = useQuery({
    queryKey: ["in-app-status", app],
    queryFn: () => api.inApp.status(app!),
    enabled: !!app,
  });
  const enabled = !!app && !!status.data?.enabled;
  const campaigns = useQuery({
    queryKey: ["in-app-campaigns", app],
    queryFn: () => api.inAppCampaigns.list(app!),
    enabled,
  });
  const revisions = useQuery({
    queryKey: ["in-app-revisions", app],
    queryFn: () => api.inApp.list(app!),
    enabled,
  });
  const reviews = useQuery({
    queryKey: ["in-app-reviews", app],
    queryFn: () => api.inAppCampaigns.reviews(app!),
    enabled,
  });
  const runs = useQuery({
    queryKey: ["in-app-runs", app],
    queryFn: () => api.inApp.runs(app!),
    enabled,
    refetchInterval: 3000,
  });
  const [selected, setSelected] = useState<InAppCampaign | null>(null),
    [name, setName] = useState(""),
    [revision, setRevision] = useState("");
  const [platforms, setPlatforms] = useState<("ios" | "android")[]>([
      "ios",
      "android",
    ]),
    [trigger, setTrigger] = useState<"launch" | "foreground" | "screen" | "event">(
      "launch",
    ),
    [triggerName, setTriggerName] = useState("");
  const [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [timeZone, setTimeZone] = useState("UTC"),
    [cooldown, setCooldown] = useState(3600),
    [daily, setDaily] = useState(1),
    [total, setTotal] = useState(3),
    [priority, setPriority] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [run, setRun] = useState(""),
    [checks, setChecks] = useState([false, false, false]);
  const canWrite = me.data?.permissions?.includes("journeys:write") ?? false,
    canPublish = me.data?.permissions?.includes("in_app:publish") ?? false;
  const report = useQuery({
    queryKey: ["in-app-report", app, selected?.id],
    queryFn: () => api.inAppCampaigns.report(app!, selected!.id),
    enabled: enabled && !!selected,
    refetchInterval: 10000,
  });
  useEffect(() => {
    setSelected(null);
    setName("");
    setRevision("");
    setRun("");
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setChecks([false, false, false]);
    setError("");
    setNotice("");
    setStart(localDate(new Date().toISOString()));
    setEnd(localDate(new Date(Date.now() + 7 * 86400000).toISOString()));
  }, [app]);
  function edit(c: InAppCampaign) {
    setSelected(c);
    setName(c.name);
    setRevision(c.revision_id);
    setPlatforms(c.config.platforms);
    setTrigger(c.config.trigger.type);
    setTriggerName("name" in c.config.trigger ? c.config.trigger.name : "");
    setStart(localDate(c.config.starts_at));
    setEnd(localDate(c.config.ends_at));
    setCooldown(c.config.cooldown_seconds);
    setDaily(c.config.max_per_day);
    setTotal(c.config.max_total);
    setPriority(c.config.priority);
    setTimeZone(c.config.time_zone ?? "UTC");
    setError("");
    setNotice("");
  }
  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["in-app-campaigns", app] }),
      qc.invalidateQueries({ queryKey: ["in-app-reviews", app] }),
      qc.invalidateQueries({ queryKey: ["in-app-report", app] }),
    ]);
  }
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await refresh();
    } catch (e) {
      const message =
        e instanceof ApiError
          ? String((e.body as { message?: string })?.message ?? e.message)
          : e instanceof Error
            ? e.message
            : String(e);
      setError(t("operationFailed", { reason: message }));
    } finally {
      setBusy(false);
    }
  }
  const readonly = !canWrite || busy || selected?.state === "published";
  const hasEdits =
    !!selected &&
    (name !== selected.name ||
      revision !== selected.revision_id ||
      JSON.stringify(platforms) !== JSON.stringify(selected.config.platforms) ||
      trigger !== selected.config.trigger.type ||
      ((trigger === "screen" || trigger === "event") &&
        triggerName !==
          ("name" in selected.config.trigger
            ? selected.config.trigger.name
            : "")) ||
      start !== localDate(selected.config.starts_at) ||
      end !== localDate(selected.config.ends_at) ||
      cooldown !== selected.config.cooldown_seconds ||
      daily !== selected.config.max_per_day ||
      total !== selected.config.max_total ||
      priority !== selected.config.priority ||
      timeZone !== (selected.config.time_zone ?? "UTC"));
  const completed = (runs.data?.runs ?? []).filter(
    (r) => r.state === "completed",
  );
  const reviewPlatforms = (reviews.data?.reviews ?? [])
    .filter((r) => r.revision_id === revision && r.passed)
    .map((r) => r.platform);
  return (
    <main className="ia-workbench ic-page">
      <header className="ia-header">
        <div>
          <Link href="/in-app" className="ia-back">
            ← {t("studio")}
          </Link>
          <p className="ia-eyebrow">NUDGEON / CAMPAIGNS</p>
          <h1>{t("title")}</h1>
          <p className="ia-subtitle">{t("subtitle")}</p>
        </div>
        <LocaleSwitcher />
      </header>
      <div className="ia-flow">
        <span>
          01 <b>{t("review")}</b>
        </span>
        <i>→</i>
        <span>
          02 <b>{t("conditions")}</b>
        </span>
        <i>→</i>
        <span>
          03 <b>{t("publish")}</b>
        </span>
        <small>{t("publicOnly")}</small>
      </div>
      {!status.data?.campaigns_enabled && (
        <aside className="ia-notice">{t("disabled")}</aside>
      )}
      {(campaigns.isError ||
        revisions.isError ||
        reviews.isError ||
        runs.isError ||
        me.isError ||
        status.isError) && (
        <p role="alert" className="ia-error">
          {t("loadError")}
        </p>
      )}
      {error && (
        <p role="alert" className="ia-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="ic-success">
          {notice}
        </p>
      )}
      <div className="ic-grid">
        <section className="ic-card">
          <div className="ic-heading">
            <h2>{t("campaigns")}</h2>
            <Button
              variant="outline"
              disabled={!canWrite || busy}
              onClick={() => {
                setSelected(null);
                setName("");
                setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
                setNotice("");
                setError("");
              }}
            >
              {t("new")}
            </Button>
          </div>
          {!campaigns.data?.campaigns.length && (
            <p className="ic-muted">{t("empty")}</p>
          )}
          <div className="ic-list">
            {campaigns.data?.campaigns.map((c) => (
              <button
                key={c.id}
                className={selected?.id === c.id ? "is-selected" : ""}
                onClick={() => edit(c)}
              >
                <strong>{c.name}</strong>
                <span>
                  {t(c.state)} · v{c.version}
                </span>
                <small>
                  {c.config.platforms.join(" / ")} · {t(c.config.trigger.type)}
                </small>
              </button>
            ))}
          </div>
          <p className="ic-muted">{t("frequencyNote")}</p>
        </section>
        <section className="ic-card">
          <h2>{selected ? t("edit") : t("create")}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const input: InAppCampaignInput = {
                  name,
                  revision_id: revision,
                  config: {
                    platforms,
                    trigger:
                      (trigger === "foreground" || trigger === "launch")
                        ? { type: trigger }
                        : { type: trigger, name: triggerName },
                    starts_at: new Date(start).toISOString(),
                    ends_at: new Date(end).toISOString(),
                    time_zone: timeZone,
                    cooldown_seconds: cooldown,
                    max_per_day: daily,
                    max_total: total,
                    priority,
                  },
                };
                const saved = selected
                  ? await api.inAppCampaigns.update(app!, selected.id, {
                      ...input,
                      expected_version: selected.version,
                    })
                  : await api.inAppCampaigns.create(app!, input);
                edit(saved);
                setNotice(t("saved"));
              });
            }}
          >
            <fieldset disabled={readonly || !enabled} className="ic-fields">
              <label>
                {t("name")}
                <input
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                {t("revision")}
                <select
                  required
                  value={revision}
                  onChange={(e) => setRevision(e.target.value)}
                >
                  <option value="">{t("selectRevision")}</option>
                  {revisions.data?.revisions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} · {r.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="ic-muted">
                {t("reviewed")}:{" "}
                {reviewPlatforms.length
                  ? reviewPlatforms.join(" / ")
                  : t("none")}
              </p>
              <section className="ic-audience" aria-labelledby="campaign-audience-title">
                <h3 id="campaign-audience-title">{t("audience")}</h3>
                <strong>{t("audienceAll")}</strong>
                <p>{t("audienceAllHelp")}</p>
                <p className="ic-muted">{t("audienceConditions")}</p>
              </section>
              <div className="ic-inline">
                {(["ios", "android"] as const).map((p) => (
                  <label key={p}>
                    <input
                      type="checkbox"
                      checked={platforms.includes(p)}
                      onChange={(e) =>
                        setPlatforms((old) =>
                          e.target.checked
                            ? [...old, p]
                            : old.filter((v) => v !== p),
                        )
                      }
                    />
                    {p === "ios" ? "iOS" : "Android"}
                  </label>
                ))}
              </div>
              <label>
                {t("trigger")}
                <select
                  value={trigger}
                  onChange={(e) => setTrigger(e.target.value as typeof trigger)}
                >
                  <option value="launch">{t("launch")}</option>
                  <option value="foreground">{t("foreground")}</option>
                  <option value="screen">{t("screen")}</option>
                  <option value="event">{t("event")}</option>
                </select>
              </label>
              {trigger === "launch" && <p className="ic-muted">{t("launchHint")}</p>}
              {(trigger === "screen" || trigger === "event") && (
                <label>
                  {t("triggerName")}
                  <input
                    required
                    maxLength={100}
                    value={triggerName}
                    onChange={(e) => setTriggerName(e.target.value)}
                  />
                </label>
              )}
              <div className="ic-pair">
                <label>
                  {t("start")}
                  <input
                    type="datetime-local"
                    required
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                </label>
                <label>
                  {t("end")}
                  <input
                    type="datetime-local"
                    required
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </label>
              </div>
              <label>
                {t("timeZone")}
                <input list="campaign-time-zones" required maxLength={64} value={timeZone} onChange={(e) => setTimeZone(e.target.value)} />
                <datalist id="campaign-time-zones">
                  {["Asia/Seoul", "UTC", "Asia/Tokyo", "America/New_York", "America/Los_Angeles", "Europe/London"].map(zone => <option key={zone} value={zone} />)}
                </datalist>
              </label>
              <p className="ic-muted">{t("timeZoneHelp", { zone: timeZone })}</p>
              <div className="ic-pair">
                <label>
                  {t("cooldown")}
                  <input
                    type="number"
                    min={60}
                    max={31536000}
                    required
                    value={cooldown}
                    onChange={(e) => setCooldown(Number(e.target.value))}
                  />
                </label>
                <label>
                  {t("daily")}
                  <input
                    type="number"
                    min={1}
                    max={10}
                    required
                    value={daily}
                    onChange={(e) => setDaily(Number(e.target.value))}
                  />
                </label>
                <label>
                  {t("total")}
                  <input
                    type="number"
                    min={1}
                    max={100}
                    required
                    value={total}
                    onChange={(e) => setTotal(Number(e.target.value))}
                  />
                </label>
                <label>
                  {t("priority")}
                  <input
                    type="number"
                    min={0}
                    max={100}
                    required
                    value={priority}
                    onChange={(e) => setPriority(Number(e.target.value))}
                  />
                </label>
              </div>
              <Button type="submit" disabled={!platforms.length || !revision}>
                {t("save")}
              </Button>
            </fieldset>
          </form>
          {selected && (
            <div className="ic-publish">
              <p>
                {t("savedVersion", { version: selected.version })} ·{" "}
                {t(selected.state)}
              </p>
              <p className="ic-muted">{t("publishNote")}</p>
              {selected.state === "published" ? (
                <Button
                  disabled={!canPublish || busy}
                  variant="outline"
                  onClick={() =>
                    void perform(async () => {
                      edit(
                        await api.inAppCampaigns.pause(
                          app!,
                          selected.id,
                          selected.version,
                        ),
                      );
                      setNotice(t("pausedNotice"));
                    })
                  }
                >
                  {t("pause")}
                </Button>
              ) : (
                <Button
                  disabled={
                    !canPublish ||
                    busy ||
                    hasEdits ||
                    !status.data?.campaigns_enabled
                  }
                  onClick={() =>
                    void perform(async () => {
                      edit(
                        await api.inAppCampaigns.publish(
                          app!,
                          selected.id,
                          selected.version,
                        ),
                      );
                      setNotice(t("publishedNotice"));
                    })
                  }
                >
                  {t("publish")}
                </Button>
              )}
            </div>
          )}
        </section>
        <aside className="ic-side">
          <section className="ic-card">
            <h2>{t("review")}</h2>
            <p className="ic-muted">{t("reviewHelp")}</p>
            <ReviewRunLookup key={app} runs={runs.data?.runs ?? []} selected={run}
              loading={runs.isFetching} failed={runs.isError} disabled={!enabled || !canPublish || busy}
              onSelect={id => { setRun(id); setChecks([false, false, false]); }} />
            <label className="ic-label">
              {t("testRun")}
              <select
                value={run}
                disabled={!canPublish || busy}
                onChange={(e) => {
                  setRun(e.target.value);
                  setChecks([false, false, false]);
                }}
              >
                <option value="">{t("selectRun")}</option>
                {completed.map((r) => (
                  <option value={r.id} key={r.id}>
                    {r.name} · {r.platform} · {r.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            {(["layoutCheck", "closeCheck", "actionsCheck"] as const).map(
              (key, i) => (
                <label className="ic-check" key={key}>
                  <input
                    type="checkbox"
                    disabled={!canPublish || busy || !run}
                    checked={checks[i]}
                    onChange={(e) =>
                      setChecks((old) =>
                        old.map((v, n) => (n === i ? e.target.checked : v)),
                      )
                    }
                  />
                  {t(key)}
                </label>
              ),
            )}
            <div className="ic-actions">
              <Button
                disabled={!canPublish || busy || !run || !checks.every(Boolean)}
                onClick={() =>
                  void perform(async () => {
                    await api.inAppCampaigns.review(app!, {
                      run_id: run,
                      passed: true,
                      layout_checked: checks[0]!,
                      close_checked: checks[1]!,
                      actions_checked: checks[2]!,
                    });
                    setNotice(t("reviewSaved"));
                  })
                }
              >
                {t("approve")}
              </Button>
              <Button
                variant="outline"
                disabled={!canPublish || busy || !run}
                onClick={() =>
                  void perform(async () => {
                    await api.inAppCampaigns.review(app!, {
                      run_id: run,
                      passed: false,
                      layout_checked: false,
                      close_checked: false,
                      actions_checked: false,
                    });
                    setNotice(t("reviewRejected"));
                  })
                }
              >
                {t("reject")}
              </Button>
            </div>
          </section>
          <section className="ic-card">
            <h2>{t("results")}</h2>
            {!selected ? (
              <p className="ic-muted">{t("selectCampaign")}</p>
            ) : (
              <>
                <div className="ic-metrics">
                  {(["impression", "action", "dismiss"] as const).map(
                    (kind) => (
                      <div key={kind}>
                        <strong>
                          {report.data?.events.find((e) => e.kind === kind)
                            ?.count ?? 0}
                        </strong>
                        <span>{t(kind)}</span>
                      </div>
                    ),
                  )}
                </div>
                <p className="ic-muted">{t("metricsNote")}</p>
                {report.isError && <p role="alert">{t("loadError")}</p>}
                <h3>{t("interruptions")}</h3>
                <p className="ic-muted">{t("interruptionsHelp")}</p>
                {report.data?.interruptions?.length ? <ul>{report.data.interruptions.map((item, index) => (
                  <li key={`${item.id}-${index}`}><span>{t.has(`reasons.${item.reason}`) ? t(`reasons.${item.reason}`) : item.reason}</span><small>{new Date(item.created_at).toLocaleString()}</small></li>
                ))}</ul> : <p className="ic-muted">{t("noInterruptions")}</p>}
                <h3>{t("failures")}</h3>
                {report.data?.failures.length ? (
                  <ul>
                    {report.data.failures.map((f) => (
                      <li key={f.id}>
                        <code>{f.detail}</code>
                        <small>{new Date(f.created_at).toLocaleString()}</small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="ic-muted">{t("noFailures")}</p>
                )}
              </>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
