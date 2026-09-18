"use client";
import Link from "next/link";
import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ApiError,
  type InAppFile,
  type InAppManifest,
  type InAppRevision,
  type InAppRun,
} from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { useAppId } from "../use-app-id";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LocaleSwitcher } from "@/components/locale-switcher";
import {
  bytesToBase64,
  decode,
  encode,
  defaultManifest,
  exampleFiles,
  launchExampleFiles,
  launchManifest,
  packageFiles,
} from "./source";
import { InAppPreview } from "./preview";
import "./workbench.css";

export default function InAppPage() {
  const t = useTranslations("inApp"),
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
    retry: false,
  });
  const enabled = !!app && !!status.data?.enabled;
  const list = useQuery({
    queryKey: ["in-app-revisions", app],
    queryFn: () => api.inApp.list(app!),
    enabled,
  });
  const devices = useQuery({
    queryKey: ["in-app-devices", app],
    queryFn: () => api.inApp.devices(app!),
    enabled,
    refetchInterval: 3000,
  });
  const runs = useQuery({
    queryKey: ["in-app-runs", app],
    queryFn: () => api.inApp.runs(app!),
    enabled,
    refetchInterval: 3000,
  });
  const [files, setFiles] = useState<InAppFile[]>([]),
    [selected, setSelected] = useState("index.html"),
    [name, setName] = useState(""),
    [manifest, setManifest] = useState<InAppManifest>(defaultManifest);
  const [actions, setActions] = useState(
    JSON.stringify(defaultManifest.actions, null, 2),
  );
  const [revision, setRevision] = useState<InAppRevision | null>(null),
    [dirty, setDirty] = useState(false),
    [preview, setPreview] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [logs, setLogs] = useState<string[]>([]),
    [device, setDevice] = useState(""),
    [pairing, setPairing] = useState<{
      token: string;
      confirmation_code: string;
      expires_at: string;
    } | null>(null),
    [runId, setRunId] = useState(""),
    [failuresOnly, setFailuresOnly] = useState(false);
  const events = useQuery({
    queryKey: ["in-app-events", app, runId],
    queryFn: () => api.inApp.events(app!, runId),
    enabled: enabled && !!runId,
    refetchInterval: 3000,
  });
  const canWrite = me.data?.permissions?.includes("journeys:write") ?? false;
  const log = useCallback(
    (value: string) => setLogs((old) => [...old.slice(-99), value]),
    [],
  );
  function edited() {
    setDirty(true);
    setPreview("");
    setLogs([]);
  }
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? String((e.body as { message?: string })?.message ?? e.message)
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["in-app-revisions", app] }),
      qc.invalidateQueries({ queryKey: ["in-app-devices", app] }),
      qc.invalidateQueries({ queryKey: ["in-app-runs", app] }),
    ]);
  }
  async function openRevision(r: InAppRevision) {
    const data = await api.inApp.get(app!, r.id);
    setFiles(data.files);
    setSelected("index.html");
    setName(r.name);
    setManifest(data.manifest);
    setActions(JSON.stringify(data.manifest.actions, null, 2));
    setRevision(r);
    setDirty(false);
    setLogs([]);
    setPreview((await api.inApp.preview(app!, r.id)).url);
  }
  async function save() {
    const m = { ...manifest, actions: JSON.parse(actions) };
    const r = await api.inApp.create(app!, {
      name: name || t("untitled"),
      archive_base64: await packageFiles(
        files
          .filter((f) => f.path !== "nudgeon.json")
          .concat({ path: "nudgeon.json", base64: encode(JSON.stringify(m)) }),
      ),
      manifest: m,
    });
    await refresh();
    await openRevision(r);
  }
  async function upload(file: File) {
    if (file.size > 10 * 1024 * 1024) throw new Error(t("sizeError"));
    const base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    const zip = file.name.toLowerCase().endsWith(".zip");
    const r = await api.inApp.create(app!, {
      name: file.name.replace(/\.(zip|html)$/i, ""),
      ...(zip
        ? { archive_base64: base64 }
        : { files: [{ path: "index.html", base64 }] }),
    });
    await refresh();
    await openRevision(r);
  }
  async function test(old?: InAppRun) {
    const revision_id = old?.revision_id ?? revision?.id,
      device_id = old?.device_id ?? device;
    if (!revision_id || !device_id) return;
    const run = await api.inApp.run(app!, {
      revision_id,
      device_id,
      request_key: crypto.randomUUID(),
      ...(old ? { retry_of: old.id } : {}),
    });
    setRunId(run.id);
    await refresh();
  }
  const current = files.find((f) => f.path === selected),
    textFile = /\.(html|css|js|json)$/i.test(selected);
  const activeDevices =
    devices.data?.devices.filter((d) => d.state === "active") ?? [];
  const shownRuns = (runs.data?.runs ?? []).filter(
    (r) =>
      !failuresOnly || ["failed", "expired", "cancelled"].includes(r.state),
  );
  return (
    <main className="ia-workbench">
      <header className="ia-header">
        <div>
          <Link href="/" className="ia-back">
            ← {t("dashboard")}
          </Link>
          <p className="ia-eyebrow">NUDGEON / IN-APP STUDIO</p>
          <h1>{t("title")}</h1>
          <p className="ia-subtitle">{t("subtitle")}</p>
        </div>
        <div className="ia-toolbar"><Link href="/in-app/campaigns">{t("campaigns")} →</Link><LocaleSwitcher /></div>
      </header>
      <div className="ia-flow">
        <span>
          01 <b>{t("upload")}</b>
        </span>
        <i>→</i>
        <span>
          02 <b>{t("preview")}</b>
        </span>
        <i>→</i>
        <span>
          03 <b>{t("deviceTest")}</b>
        </span>
        <small>{t("testOnly")}</small>
      </div>
      {(status.isError ||
        me.isError ||
        list.isError ||
        devices.isError ||
        runs.isError) && (
        <p role="alert" className="ia-error">
          {t("loadError")} <Link href="/login">{t("login")}</Link>
        </p>
      )}
      {!enabled && status.isSuccess && (
        <aside className="ia-notice">
          {t("disabled")}{" "}
          <code>
            IN_APP_ENABLED=true · CONTENT_PUBLIC_ORIGIN · IN_APP_ASSET_DIR
          </code>
        </aside>
      )}
      {error && (
        <p role="alert" className="ia-error">
          {error}
        </p>
      )}
      <section className="ia-toolbar">
        <Input
          aria-label={t("name")}
          placeholder={t("name")}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            edited();
          }}
          disabled={!canWrite}
        />
        <span className={`ia-status ${dirty ? "is-dirty" : ""}`}>
          {dirty
            ? t("unsaved")
            : revision
              ? `${t("saved")} · ${revision.id.slice(0, 8)}`
              : t("new")}
        </span>
        <Button
          variant="outline"
          disabled={!enabled || !canWrite || busy}
          onClick={() => {
            setFiles(exampleFiles());
            setName(t("exampleName"));
            setSelected("index.html");
            setManifest(defaultManifest);
            setActions(JSON.stringify(defaultManifest.actions, null, 2));
            setRevision(null);
            edited();
          }}
        >
          {t("example")}
        </Button>
        <Button variant="outline" disabled={!enabled || !canWrite || busy}
          onClick={() => {
            setFiles(launchExampleFiles()); setName(t("launchExample")); setSelected("index.html");
            setManifest(launchManifest); setActions("{}"); setRevision(null); edited();
          }}>
          {t("launchExample")}
        </Button>
        <label className="ia-upload">
          {t("upload")}
          <input
            aria-label={t("upload")}
            type="file"
            accept=".zip,.html"
            disabled={!enabled || !canWrite || busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void perform(() => upload(file));
              e.target.value = "";
            }}
          />
        </label>
        <Button
          disabled={!enabled || !canWrite || busy || !files.length}
          onClick={() => void perform(save)}
        >
          {busy ? t("working") : t("save")}
        </Button>
      </section>
      <div className="ia-grid">
        <section className="ia-panel ia-source">
          <div className="ia-panel-heading">
            <h2>{t("source")}</h2>
            <span>
              {files.length} {t("files")}
            </span>
          </div>
          <div className="ia-files">
            {files.map((f) => (
              <button
                key={f.path}
                aria-pressed={selected === f.path}
                onClick={() => setSelected(f.path)}
              >
                {f.path}
              </button>
            ))}
          </div>
          {current ? (
            textFile ? (
              <textarea
                aria-label={t("code")}
                spellCheck={false}
                className="ia-editor"
                value={decode(current.base64)}
                readOnly={selected === "nudgeon.json"}
                disabled={!canWrite || busy}
                onChange={(e) => {
                  const base64 = encode(e.target.value);
                  setFiles((old) =>
                    old.map((f) =>
                      f.path === selected ? { ...f, base64 } : f,
                    ),
                  );
                  edited();
                }}
              />
            ) : (
              <p className="ia-empty">
                {selected}
                <br />
                {t("binary")}
              </p>
            )
          ) : (
            <div className="ia-empty">
              <div className="ia-empty-icon">〈 / 〉</div>
              <h3>{t("emptyTitle")}</h3>
              <p>{t("emptyBody")}</p>
            </div>
          )}
          <label className="ia-add">
            + {t("addFiles")}
            <input
              aria-label={t("addFiles")}
              type="file"
              multiple
              accept=".html,.css,.js,.json,.png,.jpg,.jpeg,.webp,.gif,.woff2"
              disabled={!canWrite || busy}
              onChange={(e) => {
                const chosen = Array.from(e.target.files ?? []);
                void perform(async () => {
                  const additions = await Promise.all(
                    chosen.map(async (f) => {
                      if (f.size > 8 * 1024 * 1024) throw Error(t("sizeError"));
                      return {
                        path: f.name,
                        base64: bytesToBase64(
                          new Uint8Array(await f.arrayBuffer()),
                        ),
                      };
                    }),
                  );
                  setFiles((old) => [
                    ...old.filter(
                      (f) => !additions.some((a) => a.path === f.path),
                    ),
                    ...additions,
                  ]);
                  edited();
                });
                e.target.value = "";
              }}
            />
          </label>
          <p className="ia-help">
            {selected === "nudgeon.json" ? t("manifestHelp") : t("sourceHelp")}
          </p>
        </section>
        <section className="ia-panel ia-preview">
          <div className="ia-panel-heading">
            <h2>{t("preview")}</h2>
            <span>HTML / CSS / JS</span>
          </div>
          {preview ? (
            <InAppPreview
              key={preview}
              url={preview}
              manifest={manifest}
              onLog={log}
              title={t("previewFrame")}
            />
          ) : (
            <div className="ia-preview-empty">
              <span>✦</span>
              <p>{dirty ? t("saveFirst") : t("previewEmpty")}</p>
            </div>
          )}
          <p className="ia-help">{t("previewHelp")}</p>
          <Button
            variant="outline"
            disabled={!revision || dirty || busy}
            onClick={() =>
              void perform(async () => {
                setLogs([]);
                setPreview((await api.inApp.preview(app!, revision!.id)).url);
              })
            }
          >
            {t("rerunPreview")}
          </Button>
        </section>
        <aside className="ia-panel ia-settings">
          <div className="ia-panel-heading">
            <h2>{t("settings")}</h2>
            <span>01 / HTML</span>
          </div>
          <label>
            {t("display")}
            <select
              value={manifest.display.type}
              disabled={!canWrite}
              onChange={(e) => {
                setManifest({
                  ...manifest,
                  display: {
                    ...manifest.display,
                    type: e.target.value as InAppManifest["display"]["type"],
                  },
                });
                edited();
              }}
            >
              {["modal", "fullscreen", "bottom", "transparent"].map((v) => (
                <option value={v} key={v}>
                  {t(`displayTypes.${v}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("backdrop")}{" "}
            <span>{Math.round(manifest.display.backdrop_opacity * 100)}%</span>
            <input
              type="range"
              min="0"
              max="0.7"
              step="0.05"
              disabled={!canWrite}
              value={manifest.display.backdrop_opacity}
              onChange={(e) => {
                setManifest({
                  ...manifest,
                  display: {
                    ...manifest.display,
                    backdrop_opacity: Number(e.target.value),
                  },
                });
                edited();
              }}
            />
          </label>
          <label>
            {t("actions")}
            <textarea
              aria-label={t("actions")}
              className="ia-actions"
              spellCheck={false}
              value={actions}
              disabled={!canWrite}
              onChange={(e) => {
                setActions(e.target.value);
                edited();
              }}
            />
          </label>
          <p className="ia-help">{t("actionsHelp")}</p>
          <div className="ia-divider" />
          <h3>{t("versions")}</h3>
          <select
            aria-label={t("versions")}
            value={revision?.id ?? ""}
            disabled={busy}
            onChange={(e) => {
              const r = list.data?.revisions.find(
                (r) => r.id === e.target.value,
              );
              if (r && (!dirty || confirm(t("discard"))))
                void perform(() => openRevision(r));
            }}
          >
            <option value="">{t("chooseVersion")}</option>
            {list.data?.revisions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.id.slice(0, 8)}
              </option>
            ))}
          </select>
          {revision && (
            <p className="ia-hash">
              SHA-256
              <br />
              {revision.artifact_sha256}
            </p>
          )}
        </aside>
      </div>
      <section className="ia-panel ia-test">
        <div className="ia-panel-heading">
          <div>
            <h2>{t("deviceTest")}</h2>
            <p className="ia-help">{t("deviceHelp")}</p>
          </div>
          <Button
            variant="outline"
            disabled={!enabled || !canWrite || busy}
            onClick={() =>
              void perform(async () => {
                setPairing(await api.inApp.pair(app!));
                await refresh();
              })
            }
          >
            {t("connect")}
          </Button>
        </div>
        {pairing && (
          <div className="ia-pair">
            <p>
              {t("pairHelp")} <b>{pairing.confirmation_code}</b>
            </p>
            <code>{pairing.token}</code>
            <p className="ia-help">
              {t("expires")} {new Date(pairing.expires_at).toLocaleTimeString()}
            </p>
            <Button
              variant="outline"
              onClick={() =>
                void perform(async () => {
                  await navigator.clipboard.writeText(pairing.token);
                  log(t("copied"));
                })
              }
            >
              {t("copyToken")}
            </Button>
          </div>
        )}
        {devices.data?.devices
          .filter((d) => d.state === "claimed")
          .map((d) => (
            <div className="ia-device" key={d.id}>
              <span>
                {d.label} · {d.platform} · <b>{d.confirmation_code}</b>
              </span>
              <Button
                disabled={!canWrite || busy}
                onClick={() =>
                  void perform(async () => {
                    await api.inApp.confirm(app!, d.id);
                    setDevice(d.id);
                    setPairing(null);
                    await refresh();
                  })
                }
              >
                {t("confirmDevice")}
              </Button>
              <Button
                variant="outline"
                disabled={!canWrite || busy}
                onClick={() =>
                  void perform(async () => {
                    await api.inApp.revoke(app!, d.id);
                    await refresh();
                  })
                }
              >
                {t("disconnect")}
              </Button>
            </div>
          ))}
        <div className="ia-device">
          <select
            aria-label={t("device")}
            value={device}
            onChange={(e) => setDevice(e.target.value)}
          >
            <option value="">{t("chooseDevice")}</option>
            {activeDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label} · {d.platform}
              </option>
            ))}
          </select>
          <Button
            disabled={
              !canWrite ||
              busy ||
              dirty ||
              !revision ||
              !activeDevices.some((d) => d.id === device)
            }
            onClick={() => void perform(() => test())}
          >
            {t("runDevice")}
          </Button>
          {device && (
            <Button
              variant="outline"
              disabled={!canWrite || busy}
              onClick={() =>
                void perform(async () => {
                  await api.inApp.revoke(app!, device);
                  setDevice("");
                  await refresh();
                })
              }
            >
              {t("disconnect")}
            </Button>
          )}
        </div>
        <p className="ia-help">{t("realActions")}</p>
      </section>
      <div className="ia-results">
        <section className="ia-panel">
          <div className="ia-panel-heading">
            <h2>{t("previewLogs")}</h2>
            <span>{logs.length}</span>
          </div>
          <div className="ia-log" role="log">
            {logs.length ? (
              logs.map((l, i) => (
                <p key={i}>
                  <span>{String(i + 1).padStart(2, "0")}</span>
                  {l}
                </p>
              ))
            ) : (
              <p>{t("noLogs")}</p>
            )}
          </div>
        </section>
        <section className="ia-panel">
          <div className="ia-panel-heading">
            <h2>{t("history")}</h2>
            <label>
              <input
                type="checkbox"
                checked={failuresOnly}
                onChange={(e) => setFailuresOnly(e.target.checked)}
              />{" "}
              {t("failuresOnly")}
            </label>
          </div>
          {!shownRuns.length && <p className="ia-empty">{t("noRuns")}</p>}
          {shownRuns.map((r) => (
            <div className="ia-run" key={r.id}>
              <button className="ia-run-detail" onClick={() => setRunId(r.id)}>
                <b>
                  {r.name} · {r.label}
                </b>
                <span>
                  {r.revision_id.slice(0, 8)} · {t(`states.${r.state}`)}{" "}
                  {r.error_code}
                </span>
              </button>
              {["queued", "preparing", "presented"].includes(r.state) ? (
                <Button
                  variant="outline"
                  disabled={!canWrite || busy}
                  onClick={() =>
                    void perform(async () => {
                      await api.inApp.cancel(app!, r.id);
                      await refresh();
                    })
                  }
                >
                  {t("cancel")}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={
                    !canWrite ||
                    busy ||
                    !activeDevices.some((d) => d.id === r.device_id)
                  }
                  onClick={() => void perform(() => test(r))}
                >
                  {t("retry")}
                </Button>
              )}
            </div>
          ))}
          {runId && (
            <div className="ia-log">
              <p>
                {t("runEvents")} · {runId.slice(0, 8)}
              </p>
              {events.data?.events.map((e) => (
                <p key={e.event_id}>
                  {e.kind} {e.detail}
                </p>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
