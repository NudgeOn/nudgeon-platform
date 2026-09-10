"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toGraphDefinition, type JourneyDefinition, type JourneyNode } from "@nudgeon/journey-model";
import { api } from "@/lib/api";
import { JourneyAppGate } from "../../JourneyAppGate";
import { JourneyCanvas } from "../../JourneyCanvas";
import { graphReadIssue } from "../../journey-graph";
import { JourneyIcon, useJourneyText } from "../../journey-ui";
import "./journey-report.css";

const ArrowLeft = ({ size }: { size: number }) => <JourneyIcon name="arrow-left" size={size} />;
const ArrowUpRight = ({ size }: { size: number }) => <JourneyIcon name="arrow-right" size={size} />;
const BarChart3 = ({ size }: { size: number }) => <JourneyIcon name="chart" size={size} />;
const ChevronDown = ({ size }: { size: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;
const RefreshCw = ({ size }: { size: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7" /></svg>;

export default function JourneyReportPage() {
  const { id } = useParams<{ id: string }>();
  return <JourneyAppGate>{appId => <JourneyReportView key={`${appId}:${id}`} appId={appId} id={id} />}</JourneyAppGate>;
}

function JourneyReportView({ appId, id }: { appId: string; id: string }) {
  const { t, locale, message, ports } = useJourneyText();
  const number = (n: number) => n.toLocaleString(locale);
  // 리포트 단계 종류 라벨 — 메시지는 채널별(푸시/이메일), 나머지는 report.type.*
  const typeLabel = (node: JourneyNode) => node.type === "message" ? (node.email ? t("report.type.email") : t("report.type.push")) : t(`report.type.${node.type}`);
  const label = (node: JourneyNode) => node.type === "message" ? (node.push?.title || node.email?.subject || t("report.type.message")) : t(`report.type.${node.type}`);
  const [selection, setSelection] = useState<{ journeyId: string; version: number }>();
  const [selectedId, setSelectedId] = useState("entry");
  const detail = useQuery({ queryKey: ["journey", appId, id], queryFn: () => api.journeys.get(appId!, id), enabled: !!appId });
  const version = selection?.journeyId === id ? selection.version : detail.data?.active_version ?? undefined;
  const report = useQuery({
    queryKey: ["journey-report", appId, id, version],
    queryFn: () => api.analytics.journeyReport(appId!, id, version ? { version } : undefined),
    enabled: !!appId && detail.isSuccess,
  });
  // 도달·오픈·클릭: SDK 이벤트 ∪ 공급자 콜백(message_lifecycle — 예: Resend 웹훅) 집계.
  const delivery = useQuery({
    queryKey: ["journey-delivery", appId, id],
    queryFn: () => api.analytics.deliveryReport(appId!, id),
    enabled: !!appId && detail.isSuccess,
  });
  const r = report.data;
  const rendered = useMemo(() => {
    if (!r?.definition) return { graph: null, error: null };
    try {
      const graph = toGraphDefinition(r.definition as JourneyDefinition);
      const issue = graphReadIssue(graph);
      return { graph: issue ? null : graph, error: issue ? message(issue) : null };
    } catch {
      return { graph: null, error: t("report.versionUnreadable") };
    }
  }, [r?.definition, message, t]);
  const graph = rendered.graph;
  const nodes = r?.nodes ?? [];
  const selectedNodeId = selectedId.startsWith("node:") ? selectedId.slice(5) : undefined;
  const selectedNode = graph?.nodes.find(node => node.id === selectedNodeId);
  const selectedMetrics = nodes.find(node => node.node_id === selectedNodeId);
  const nodeMetrics = Object.fromEntries(nodes.map(node => [node.node_id, `${t("report.arrived")} ${number(node.arrived)}${node.waiting ? ` · ${t("report.waiting")} ${number(node.waiting)}` : ""}`]));
  const edgeMetrics = Object.fromEntries((graph?.edges ?? []).map(edge => {
    const count = nodes.find(node => node.node_id === edge.source)?.paths.find(path => path.output_port === edge.source_port)?.executions ?? 0;
    return [edge.id, t("report.times", { count: number(count) })];
  }));

  if (detail.isError || report.isError) return <main className="journey-report jr-empty"><h1>{t("report.errorTitle")}</h1><p>{t("report.errorBody")}</p><button onClick={() => { void detail.refetch(); void report.refetch(); }}>{t("gate.retry")}</button><Link href={`/journeys/${id}`}>{t("report.backToEditor")}</Link></main>;
  if (!appId || detail.isPending || report.isPending || !r) return <main className="journey-report jr-empty" aria-busy="true">{t("report.loading")}</main>;

  const executions = Object.values(r.state_distribution).reduce((sum, count) => sum + count, 0);
  const sends = r.sends.filter(send => send.status === "sent").reduce((sum, send) => sum + send.count, 0);
  const pathTotal = selectedMetrics?.paths.reduce((sum, path) => sum + path.executions, 0) ?? 0;
  const assignedTotal = selectedMetrics?.paths.reduce((sum, path) => sum + path.unique_users, 0) ?? 0;

  return <main className="journey-report">
    <header className="jr-header">
      <div><Link className="jr-back" href={`/journeys/${id}`}><ArrowLeft size={15} /> {t("report.editorLink")}</Link><div className="jr-title"><span className="jr-mark"><BarChart3 size={22} /></span><div><p>JOURNEY INSIGHTS</p><h1>{r.name}</h1></div></div></div>
      <div className="jr-actions">
        <label className="jr-version"><span>{t("report.version")}</span><select aria-label={t("report.versionSelect")} value={r.version ?? ""} disabled={!r.versions.length} onChange={event => { setSelection({ journeyId: id, version: Number(event.target.value) }); setSelectedId("entry"); }}>
          {!r.versions.length && <option value="">{t("report.notActivated")}</option>}
          {r.versions.map(item => <option key={item.version} value={item.version}>v{item.version}{item.version === detail.data?.active_version ? ` · ${t("report.current")}` : ""}</option>)}
        </select><ChevronDown size={14} /></label>
        <button className="jr-refresh" aria-label={t("report.refresh")} disabled={report.isFetching} onClick={() => { void report.refetch(); }}><RefreshCw size={16} /></button>
      </div>
    </header>
    <section className="jr-overview" aria-label={t("report.overviewLabel")}>
      <Summary label={t("report.summary.executions")} value={number(executions)} suffix={t("report.unit.times")} note={t("report.summary.executionsNote")} />
      <Summary label={t("report.summary.waiting")} value={number(r.state_distribution.waiting ?? 0)} suffix={t("report.unit.times")} note={t("report.summary.waitingNote")} />
      <Summary label={t("report.summary.completed")} value={number(r.state_distribution.completed ?? 0)} suffix={t("report.unit.times")} note={t("report.summary.completedNote")} />
      <Summary label={t("report.summary.sends")} value={number(sends)} suffix={t("report.unit.count")} note={t("report.summary.sendsNote")} />
    </section>
    {r.instrumentation !== "available" && <div className="jr-notice" role="status">{r.instrumentation === "unpublished" ? t("report.unpublished") : t("report.legacyVersion")}</div>}
    {rendered.error && <div className="jr-notice" role="alert">{rendered.error}</div>}
    {graph && <section className="jr-workspace" aria-label={t("report.workspaceLabel")}>
      <div className="jr-canvas"><div className="jr-canvas-heading"><strong>{t("report.canvasTitle")}</strong><span>{t("report.canvasHint")}</span></div>
        <JourneyCanvas definition={graph} selectedId={selectedId} onSelect={setSelectedId} editable={false} nodeMetrics={r.instrumentation === "available" ? nodeMetrics : undefined} edgeMetrics={r.instrumentation === "available" ? edgeMetrics : undefined} />
      </div>
      <aside className="jr-insight">
        <p className="jr-eyebrow">STEP DETAILS</p>
        <h2>{selectedNode ? label(selectedNode) : t("report.exploreTitle")}</h2>
        {!selectedNode ? <p className="jr-hint">{t("report.exploreHint")}</p> : <>
          <p className="jr-hint">{typeLabel(selectedNode)} · v{r.version}</p>
          {r.instrumentation !== "available" ? <p className="jr-hint">{t("report.noNodeMetrics")}</p> : <>
            <div className="jr-node-totals"><div><span>{t("report.arrived")}</span><strong>{number(selectedMetrics?.arrived ?? 0)}<small>{t("report.unit.times")}</small></strong></div><div><span>{t("report.waitingNow")}</span><strong>{number(selectedMetrics?.waiting ?? 0)}<small>{t("report.unit.times")}</small></strong></div><div><span>{t("report.completed")}</span><strong>{number(selectedMetrics?.completed ?? 0)}<small>{t("report.unit.times")}</small></strong></div><div><span>{t("report.failed")}</span><strong>{number(selectedMetrics?.failed ?? 0)}<small>{t("report.unit.times")}</small></strong></div></div>
            {ports(selectedNode).map(port => {
              const metrics = selectedMetrics?.paths.find(path => path.output_port === port.id);
              const count = metrics?.executions ?? 0;
              const percent = selectedNode.type === "ab_split" ? (assignedTotal ? (metrics?.unique_users ?? 0) / assignedTotal * 100 : 0) : (pathTotal ? count / pathTotal * 100 : 0);
              return <div className="jr-path" key={port.id}><div><strong>{port.label}</strong><span>{t("report.times", { count: number(count) })}</span></div><div className="jr-bar"><span style={{ width: `${percent}%` }} /></div><p>{selectedNode.type === "ab_split" ? t("report.abPath", { users: number(metrics?.unique_users ?? 0), percent: percent.toFixed(1) }) : t("report.decidedPath", { percent: percent.toFixed(1) })}</p></div>;
            })}
            {selectedNode.type === "ab_split" && <p className="jr-footnote">{t("report.abFootnote")}</p>}
          </>}
        </>}
      </aside>
    </section>}
    <section className="jr-bottom">
      <div className="jr-panel"><div className="jr-panel-title"><h2>{t("report.states.title")}</h2><span>{t("report.states.subtitle")}</span></div>
        {!executions && <p className="jr-hint">{t("report.states.empty")}</p>}
        {Object.entries(r.state_distribution).map(([status, count]) => <div className="jr-row" key={status}><span><i className={`jr-dot jr-dot-${status}`} />{t.has(`report.state.${status}`) ? t(`report.state.${status}`) : status}</span><strong>{t("report.times", { count: number(count) })}</strong></div>)}
      </div>
      <div className="jr-panel"><div className="jr-panel-title"><h2>{t("report.sends.title")}</h2><Link href={`/journeys/${id}`}>{t("report.sends.viewJourney")} <ArrowUpRight size={13} /></Link></div>
        {!r.sends.length && <p className="jr-hint">{t("report.sends.empty")}</p>}
        {r.sends.map((send, index) => <div className="jr-row" key={`${send.node_index}-${send.status}-${index}`}><span>{graph?.nodes[send.node_index] ? label(graph.nodes[send.node_index]!) : t("report.stepN", { n: send.node_index + 1 })}<small>{t.has(`report.send.${send.status}`) ? t(`report.send.${send.status}`) : send.status}</small></span><strong>{t("report.countOf", { count: number(send.count) })}</strong></div>)}
        <p className="jr-footnote">{t("report.sends.footnote")}</p>
      </div>
      <div className="jr-panel"><div className="jr-panel-title"><h2>{t("report.delivery.title")}</h2><span>{t("report.delivery.subtitle")}</span></div>
        {delivery.isError && <p className="jr-hint">{t("report.delivery.error")}</p>}
        {delivery.isPending && <p className="jr-hint">{t("report.delivery.loading")}</p>}
        {delivery.data && <>
          <div className="jr-row"><span>{t("report.delivery.delivered")}<small>{t("report.delivery.deliveredNote")}</small></span><strong>{t("report.countOf", { count: number(delivery.data.delivered) })} · {(delivery.data.delivery_rate * 100).toFixed(1)}%</strong></div>
          <div className="jr-row"><span>{t("report.delivery.opened")}<small>{t("report.delivery.openedNote")}</small></span><strong>{t("report.countOf", { count: number(delivery.data.opened) })} · {(delivery.data.open_rate * 100).toFixed(1)}%</strong></div>
          <div className="jr-row"><span>{t("report.delivery.clicked")}<small>{t("report.delivery.clickedNote")}</small></span><strong>{t("report.countOf", { count: number(delivery.data.clicked) })}</strong></div>
          <div className="jr-row"><span>{t("report.delivery.bounced")}<small>{t("report.delivery.bouncedNote")}</small></span><strong>{t("report.countOf", { count: number(delivery.data.bounced) })}</strong></div>
          <p className="jr-footnote">{t("report.delivery.footnote")}</p>
        </>}
      </div>
    </section>
  </main>;
}

function Summary({ label, value, suffix, note }: { label: string; value: string; suffix: string; note: string }) {
  return <div className="jr-summary"><span>{label}</span><strong>{value}<small>{suffix}</small></strong><p>{note}</p></div>;
}
