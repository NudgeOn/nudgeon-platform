"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { outputPorts, toGraphDefinition, type JourneyDefinition, type JourneyNode } from "@onda/journey-model";
import { api } from "@/lib/api";
import { JourneyAppGate } from "../../JourneyAppGate";
import { JourneyCanvas } from "../../JourneyCanvas";
import { graphReadIssue } from "../../journey-graph";
import { JourneyIcon } from "../../journey-ui";
import "./journey-report.css";

const STATES: Record<string, string> = { active: "진행", waiting: "대기", claimed: "처리 중", completed: "완료", exited: "이탈", failed: "실패" };
const SENDS: Record<string, string> = { sent: "발송 접수", failed: "실패", duplicate: "중복 제외", skipped_quiet_hours: "조용시간 생략", skipped_cap: "빈도제한 생략", skipped_unreachable: "도달불가 생략" };
const TYPES: Record<string, string> = { message: "푸시 메시지", delay: "고정 대기", branch: "조건 분기", event_wait: "이벤트 대기", ab_split: "A/B 분기" };
const number = (n: number) => n.toLocaleString("ko-KR");
const label = (node: JourneyNode) => node.type === "message" ? (node.push?.title || node.email?.subject || TYPES.message) : TYPES[node.type];
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
  const [selection, setSelection] = useState<{ journeyId: string; version: number }>();
  const [selectedId, setSelectedId] = useState("entry");
  const detail = useQuery({ queryKey: ["journey", appId, id], queryFn: () => api.journeys.get(appId!, id), enabled: !!appId });
  const version = selection?.journeyId === id ? selection.version : detail.data?.active_version ?? undefined;
  const report = useQuery({
    queryKey: ["journey-report", appId, id, version],
    queryFn: () => api.analytics.journeyReport(appId!, id, version ? { version } : undefined),
    enabled: !!appId && detail.isSuccess,
  });
  const r = report.data;
  const rendered = useMemo(() => {
    if (!r?.definition) return { graph: null, error: null };
    try {
      const graph = toGraphDefinition(r.definition as JourneyDefinition);
      const error = graphReadIssue(graph);
      return { graph: error ? null : graph, error };
    } catch {
      return { graph: null, error: "이 버전의 연결 정보를 표시할 수 없습니다. 원본 정의와 실행 집계는 변경하지 않았습니다." };
    }
  }, [r?.definition]);
  const graph = rendered.graph;
  const nodes = r?.nodes ?? [];
  const selectedNodeId = selectedId.startsWith("node:") ? selectedId.slice(5) : undefined;
  const selectedNode = graph?.nodes.find(node => node.id === selectedNodeId);
  const selectedMetrics = nodes.find(node => node.node_id === selectedNodeId);
  const nodeMetrics = Object.fromEntries(nodes.map(node => [node.node_id, `도달 ${number(node.arrived)}${node.waiting ? ` · 대기 ${number(node.waiting)}` : ""}`]));
  const edgeMetrics = Object.fromEntries((graph?.edges ?? []).map(edge => {
    const count = nodes.find(node => node.node_id === edge.source)?.paths.find(path => path.output_port === edge.source_port)?.executions ?? 0;
    return [edge.id, `${number(count)}회`];
  }));

  if (detail.isError || report.isError) return <main className="journey-report jr-empty"><h1>리포트를 불러오지 못했습니다</h1><p>연결을 확인하고 다시 시도해 주세요.</p><button onClick={() => { void detail.refetch(); void report.refetch(); }}>다시 시도</button><Link href={`/journeys/${id}`}>편집기로 돌아가기</Link></main>;
  if (!appId || detail.isPending || report.isPending || !r) return <main className="journey-report jr-empty" aria-busy="true">저니 실행 결과를 불러오는 중…</main>;

  const executions = Object.values(r.state_distribution).reduce((sum, count) => sum + count, 0);
  const sends = r.sends.filter(send => send.status === "sent").reduce((sum, send) => sum + send.count, 0);
  const pathTotal = selectedMetrics?.paths.reduce((sum, path) => sum + path.executions, 0) ?? 0;
  const assignedTotal = selectedMetrics?.paths.reduce((sum, path) => sum + path.unique_users, 0) ?? 0;

  return <main className="journey-report">
    <header className="jr-header">
      <div><Link className="jr-back" href={`/journeys/${id}`}><ArrowLeft size={15} /> 저니 편집기</Link><div className="jr-title"><span className="jr-mark"><BarChart3 size={22} /></span><div><p>JOURNEY INSIGHTS</p><h1>{r.name}</h1></div></div></div>
      <div className="jr-actions">
        <label className="jr-version"><span>실행 버전</span><select aria-label="리포트 버전" value={r.version ?? ""} disabled={!r.versions.length} onChange={event => { setSelection({ journeyId: id, version: Number(event.target.value) }); setSelectedId("entry"); }}>
          {!r.versions.length && <option value="">활성화 전</option>}
          {r.versions.map(item => <option key={item.version} value={item.version}>v{item.version}{item.version === detail.data?.active_version ? " · 현재" : ""}</option>)}
        </select><ChevronDown size={14} /></label>
        <button className="jr-refresh" aria-label="리포트 새로고침" disabled={report.isFetching} onClick={() => { void report.refetch(); }}><RefreshCw size={16} /></button>
      </div>
    </header>
    <section className="jr-overview" aria-label="실행 요약">
      <Summary label="저니 실행" value={executions} suffix="회" note="재진입을 포함한 실행 수" />
      <Summary label="현재 대기" value={r.state_distribution.waiting ?? 0} suffix="회" note="고정·이벤트·발송 정책 대기" />
      <Summary label="완료" value={r.state_distribution.completed ?? 0} suffix="회" note="종료 단계에 도착한 실행" />
      <Summary label="발송 접수" value={sends} suffix="건" note="전송 서비스 접수 · 실제 도달과 다름" />
    </section>
    {r.instrumentation !== "available" && <div className="jr-notice" role="status">{r.instrumentation === "unpublished" ? "처음 활성화한 뒤 실행 결과를 확인할 수 있습니다." : "이 버전은 경로 계측 이전에 만들어졌습니다. 단계·경로 집계는 없으며, 기존 실행 및 발송 기록만 표시합니다."}</div>}
    {rendered.error && <div className="jr-notice" role="alert">{rendered.error}</div>}
    {graph && <section className="jr-workspace" aria-label="경로별 실행 결과">
      <div className="jr-canvas"><div className="jr-canvas-heading"><strong>고객이 지나간 경로</strong><span>단계를 선택하면 상세 결과를 볼 수 있어요</span></div>
        <JourneyCanvas definition={graph} selectedId={selectedId} onSelect={setSelectedId} editable={false} nodeMetrics={r.instrumentation === "available" ? nodeMetrics : undefined} edgeMetrics={r.instrumentation === "available" ? edgeMetrics : undefined} />
      </div>
      <aside className="jr-insight">
        <p className="jr-eyebrow">STEP DETAILS</p>
        <h2>{selectedNode ? label(selectedNode) : "흐름을 살펴보세요"}</h2>
        {!selectedNode ? <p className="jr-hint">조건별 통과 수, 이벤트 대기 결과, A/B 배정을 캔버스에서 선택해 확인하세요.</p> : <>
          <p className="jr-hint">{TYPES[selectedNode.type]} · v{r.version}</p>
          {r.instrumentation !== "available" ? <p className="jr-hint">이 버전의 단계 집계가 없습니다.</p> : <>
            <div className="jr-node-totals"><div><span>도달</span><strong>{number(selectedMetrics?.arrived ?? 0)}<small>회</small></strong></div><div><span>대기 중</span><strong>{number(selectedMetrics?.waiting ?? 0)}<small>회</small></strong></div><div><span>완료</span><strong>{number(selectedMetrics?.completed ?? 0)}<small>회</small></strong></div><div><span>실패</span><strong>{number(selectedMetrics?.failed ?? 0)}<small>회</small></strong></div></div>
            {outputPorts(selectedNode).map(port => {
              const metrics = selectedMetrics?.paths.find(path => path.output_port === port.id);
              const count = metrics?.executions ?? 0;
              const percent = selectedNode.type === "ab_split" ? (assignedTotal ? (metrics?.unique_users ?? 0) / assignedTotal * 100 : 0) : (pathTotal ? count / pathTotal * 100 : 0);
              return <div className="jr-path" key={port.id}><div><strong>{port.label}</strong><span>{number(count)}회</span></div><div className="jr-bar"><span style={{ width: `${percent}%` }} /></div><p>{selectedNode.type === "ab_split" ? `고유 고객 ${number(metrics?.unique_users ?? 0)}명 · 실제 배정 ${percent.toFixed(1)}%` : `결정 완료 경로 중 ${percent.toFixed(1)}%`}</p></div>;
            })}
            {selectedNode.type === "ab_split" && <p className="jr-footnote">설정 비율은 목표 비율입니다. 고객 수가 적으면 실제 배정 비율과 차이가 날 수 있으며, 같은 고객의 재진입은 배정을 유지합니다.</p>}
          </>}
        </>}
      </aside>
    </section>}
    <section className="jr-bottom">
      <div className="jr-panel"><div className="jr-panel-title"><h2>실행 상태</h2><span>실행 인스턴스 기준</span></div>
        {!executions && <p className="jr-hint">아직 진입한 고객이 없습니다.</p>}
        {Object.entries(r.state_distribution).map(([status, count]) => <div className="jr-row" key={status}><span><i className={`jr-dot jr-dot-${status}`} />{STATES[status] ?? status}</span><strong>{number(count)}회</strong></div>)}
      </div>
      <div className="jr-panel"><div className="jr-panel-title"><h2>발송 처리 결과</h2><Link href={`/journeys/${id}`}>저니 보기 <ArrowUpRight size={13} /></Link></div>
        {!r.sends.length && <p className="jr-hint">아직 발송 처리 기록이 없습니다.</p>}
        {r.sends.map((send, index) => <div className="jr-row" key={`${send.node_index}-${send.status}-${index}`}><span>{graph?.nodes[send.node_index] ? label(graph.nodes[send.node_index]!) : `단계 ${send.node_index + 1}`}<small>{SENDS[send.status] ?? send.status}</small></span><strong>{number(send.count)}건</strong></div>)}
        <p className="jr-footnote">발송은 디바이스 단위이며 일부 생략 기록은 고객 단위입니다. 고객 수나 실제 도달·열람 수로 해석하지 않습니다.</p>
      </div>
    </section>
  </main>;
}

function Summary({ label, value, suffix, note }: { label: string; value: number; suffix: string; note: string }) {
  return <div className="jr-summary"><span>{label}</span><strong>{number(value)}<small>{suffix}</small></strong><p>{note}</p></div>;
}
