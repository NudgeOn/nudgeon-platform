"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, type JourneyValidation } from "@nudgeon/api-client";
import { toGraphDefinition, type JourneyDefinition, type JourneyNode } from "@nudgeon/journey-model";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { JourneyCanvas } from "./JourneyCanvas";
import { JourneyInspector } from "./JourneyInspector";
import { ChoosePathDialog, RemoveNodeDialog, RenewExperimentDialog } from "./JourneyGraphDialogs";
import { checkDraft, createJourneyNode, emptyJourney, NODE_TOOLS } from "./journey-editor-model";
import { connectRoute, entryEdgeId, GraphOperationError, graphReadIssue, insertOnEdge, moveLinearNode,
  outgoingEdges, pathDurationRange, renewExperiment, type GraphDefinition, type JourneyCapabilities, type PublishedABNodes } from "./journey-graph";
import { createJourneyDraftSession, type JourneyDraftInput } from "./journey-persistence";
import { JourneyIcon, JourneyState, JourneyStatus, JourneyTopbar, useJourneyText } from "./journey-ui";

interface Props {
  appId: string;
  journeyId?: string;
  initialName?: string;
  initialDef?: JourneyDefinition;
  status?: string;
  capabilities?: JourneyCapabilities;
  publishedABNodes?: PublishedABNodes;
}

type Confirmation = { id: string } & JourneyValidation;
type Snapshot = { definition: GraphDefinition; selectedId: string; description: string };

type JourneyText = ReturnType<typeof useJourneyText>;

// 모듈이 던지는 오류는 메시지 키(GraphOperationError, checkDraft, persistence)일 수 있다 — 카탈로그에 있으면 번역한다.
function readableError(error: unknown, { t, message }: JourneyText): string {
  if (error instanceof ApiError) {
    const known = [400, 401, 403, 404, 409] as const;
    const status = known.find((code) => code === error.status);
    return t(status ? `editor.apiError.${status}` : "editor.apiError.default");
  }
  if (error instanceof GraphOperationError) return message(error);
  if (error instanceof Error && error.message) return t.has(error.message) ? t(error.message) : error.message;
  return t("editor.requestFailed");
}

export function JourneyEditor(props: Props) {
  const text = useJourneyText();
  const [loaded] = useState(() => {
    try {
      const graph = props.initialDef ? toGraphDefinition(props.initialDef) : emptyJourney();
      const issue = graphReadIssue(graph);
      return { graph, error: issue ? text.message(issue) : null };
    } catch (error) {
      return { graph: null, error: readableError(error, text) };
    }
  });
  if (!loaded.graph || loaded.error) return <JourneyState error title={text.t("editor.readErrorTitle")}
    description={loaded.error ?? text.t("editor.readErrorBody")}
    action={<Link href="/journeys" className="j-button">{text.t("detail.backToList")}</Link>} />;
  return <JourneyEditorContent {...props} initialGraph={loaded.graph} />;
}

function JourneyEditorContent({ appId, journeyId, initialName, initialGraph, status = "draft", capabilities, publishedABNodes = {} }: Props & { initialGraph: GraphDefinition }) {
  const text = useJourneyText();
  const { t, nodeType, nodeTypeDescription, message, duration: formatDuration, locale } = text;
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialName ?? "");
  const [definition, setDefinition] = useState(initialGraph);
  const [selectedId, setSelectedId] = useState(() => journeyId
    ? `node:${initialGraph.nodes.find((node) => node.type === "message")?.id ?? initialGraph.start_node_id}` : "entry");
  const [session] = useState(() => createJourneyDraftSession(api.journeys, appId, journeyId));
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [savedFingerprint, setSavedFingerprint] = useState(() => journeyId ? JSON.stringify({ name: initialName ?? "", definition: initialGraph }) : "");
  const [history, setHistory] = useState<Snapshot[]>([]);
  const lastEdit = useRef({ selection: "", time: 0 });
  const [graphFeedback, setGraphFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [renewId, setRenewId] = useState<string | null>(null);
  const [pathChoice, setPathChoice] = useState<{ nodeId: string | null; type: JourneyNode["type"] } | null>(null);
  const dirty = JSON.stringify({ name, definition }) !== savedFingerprint;
  const statusEditable = status === "draft" || status === "paused";
  const graphSupported = capabilities?.graph_v2 === true && definition.nodes.every((node) => capabilities.supported_node_types.includes(node.type));
  const canEdit = statusEditable && graphSupported;

  const segments = useQuery({ queryKey: ["segments", appId], queryFn: () => api.segments.list(appId) });
  const recordSaved = (id: string, input: JourneyDraftInput) => {
    setName(input.name);
    setSavedFingerprint(JSON.stringify(input));
    void queryClient.invalidateQueries({ queryKey: ["journeys", appId] });
    void queryClient.invalidateQueries({ queryKey: ["journey", appId, id] });
  };
  const save = useMutation({
    mutationFn: (input: JourneyDraftInput) => { checkDraft(input.name, input.definition); return session.save(input); },
    onSuccess: (id, input) => { recordSaved(id, input); if (!journeyId) router.replace(`/journeys/${id}`); },
  });
  const validate = useMutation({
    mutationFn: (input: JourneyDraftInput) => { checkDraft(input.name, input.definition); return session.validate(input); },
    onSuccess: (result, input) => {
      recordSaved(result.id, input);
      if (!result.issues.some((issue) => issue.level === "error")) setConfirmation(result);
    },
  });
  const activate = useMutation({
    // The server checks that this exact saved revision is the one we validated.
    mutationFn: (result: Confirmation) => api.journeys.activate(appId, result.id, { revision: result.revision }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["journeys", appId] }); router.push("/journeys"); },
    onError: (error) => { if (error instanceof ApiError && error.status === 409) setConfirmation(null); },
  });
  const pause = useMutation({
    mutationFn: () => api.journeys.pause(appId, journeyId!),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["journeys", appId] }),
        queryClient.invalidateQueries({ queryKey: ["journey", appId, journeyId] }),
      ]);
    },
  });
  const busy = save.isPending || validate.isPending || activate.isPending || pause.isPending;
  const editable = canEdit && !busy && !confirmation && !removeId && !renewId && !pathChoice;
  const validationIssues = validate.data?.issues ?? [];
  const requestError = save.error ?? validate.error ?? activate.error ?? pause.error;
  const messageCount = definition.nodes.filter((node) => node.type === "message").length;
  const duration = pathDurationRange(definition);
  const durationText = !duration ? t("editor.durationCheck") : duration.max === 0 ? t("editor.durationNone")
    : duration.min === duration.max ? formatDuration(duration.max)
      : `${duration.min === 0 ? t("editor.zeroSeconds") : formatDuration(duration.min)} ~ ${formatDuration(duration.max)}`;

  const clearFeedback = () => { save.reset(); validate.reset(); activate.reset(); pause.reset(); setGraphFeedback(null); };
  const commitDefinition = (next: GraphDefinition, description: string, nextSelection = selectedId, fieldEdit = false) => {
    if (!canEdit || busy || confirmation) return;
    clearFeedback();
    const now = Date.now();
    if (!fieldEdit || lastEdit.current.selection !== selectedId || now - lastEdit.current.time > 800) {
      setHistory((items) => [...items.slice(-29), { definition, selectedId, description }]);
    }
    lastEdit.current = { selection: fieldEdit ? selectedId : "", time: now };
    setDefinition(next);
    setSelectedId(nextSelection);
    if (!fieldEdit) setGraphFeedback({ message: description, error: false });
  };
  const updateDefinition = (mutator: (draft: GraphDefinition) => void) => {
    if (!editable) return;
    const next = structuredClone(definition);
    mutator(next);
    commitDefinition(next, t("editor.feedback.fieldEdit"), selectedId, true);
  };
  const applyOperation = (operation: () => GraphDefinition, description: string, nextSelection = selectedId) => {
    try { commitDefinition(operation(), description, nextSelection); }
    catch (error) { setGraphFeedback({ message: readableError(error, text), error: true }); }
  };
  const insertNode = (edgeId: string, type: JourneyNode["type"]) => {
    if (!canEdit || busy || confirmation || !capabilities?.supported_node_types.includes(type)) return;
    const node = createJourneyNode(type);
    setPathChoice(null);
    applyOperation(() => insertOnEdge(definition, edgeId, node), t("editor.feedback.inserted", { type: nodeType(type) }), `node:${node.id}`);
  };
  const paletteInsert = (type: JourneyNode["type"]) => {
    if (!editable) return;
    if (selectedId === "entry") { insertNode(entryEdgeId(definition), type); return; }
    const nodeId = selectedId === "exit" ? null : selectedId.slice(5);
    const edges = nodeId === null ? definition.edges.filter((edge) => edge.target === null) : outgoingEdges(definition, nodeId);
    if (edges.length === 1) insertNode(edges[0]!.id, type);
    else setPathChoice({ nodeId, type });
  };
  const undo = () => {
    if (!editable) return;
    const previous = history.at(-1);
    if (!previous) return;
    clearFeedback(); setDefinition(previous.definition); setSelectedId(previous.selectedId);
    setHistory((items) => items.slice(0, -1)); lastEdit.current = { selection: "", time: 0 };
    setGraphFeedback({ message: t("editor.feedback.undone", { description: previous.description }), error: false });
  };
  const currentInput = (): JourneyDraftInput => ({ name: name.trim(), definition });

  return <main className="j-editor">
    <h1 className="sr-only">{journeyId ? t("editor.editTitle") : t("editor.newTitle")}</h1>
    <JourneyTopbar current={<span className="j-editor-current">
      <label htmlFor="journey-name" className="sr-only">{t("editor.nameLabel")}</label>
      <input id="journey-name" className="j-topbar-name" value={name} maxLength={200} placeholder={t("editor.namePlaceholder")}
        disabled={!editable} onChange={(event) => { clearFeedback(); setName(event.target.value); }} />
      <JourneyStatus status={status} />
    </span>} actions={statusEditable ? <>
      <span className="j-save-state" role="status">{busy ? t("editor.state.busy") : dirty ? t("editor.state.dirty") : <><JourneyIcon name="check" size={14} />{t("editor.state.saved")}</>}</span>
      <button type="button" className="j-button j-undo-button" disabled={!editable || !history.length} onClick={undo}
        title={t("editor.undoTitle")}><JourneyIcon name="undo" size={16} /><span>{t("editor.undo")}</span></button>
      <button type="button" className="j-button" disabled={!editable || !name.trim()} onClick={() => { clearFeedback(); save.mutate(currentInput()); }}>
        {save.isPending ? t("editor.saving") : t("editor.saveDraft")}</button>
      <button type="button" className="j-button j-button-primary" disabled={!editable || !name.trim()} onClick={() => { clearFeedback(); validate.mutate(currentInput()); }}>
        {validate.isPending ? t("editor.validating") : t("editor.validateActivate")}<JourneyIcon name="arrow-right" size={16} /></button>
    </> : <><span className="j-readonly-label">{t("editor.readOnly")}</span>
      {journeyId && status === "active" && <button type="button" className="j-button" disabled={busy}
        onClick={() => { clearFeedback(); pause.mutate(); }}>{pause.isPending ? t("editor.pausing") : t("editor.pauseAndEdit")}</button>}
      {journeyId && <Link href={`/journeys/${journeyId}/report`} className="j-button"><JourneyIcon name="chart" size={16} />{t("editor.viewReport")}</Link>}
    </>} />

    {status === "paused" && <div className="j-feedback" role="status"><JourneyIcon name="info" size={18} /><span>
      {t("editor.pausedNote")}
    </span></div>}

    {!graphSupported && <div className="j-feedback" role="status"><JourneyIcon name="info" size={18} /><span>
      {t("editor.unsupportedNote")}
    </span></div>}
    {requestError && <div className="j-feedback j-feedback-error" role="alert"><JourneyIcon name="info" size={18} /><span>{readableError(requestError, text)}</span>
      {requestError instanceof ApiError && requestError.status === 401 && <Link href="/login">{t("gate.login")}</Link>}</div>}
    {graphFeedback && <div className={`j-feedback${graphFeedback.error ? " j-feedback-error" : " j-feedback-success"}`} role={graphFeedback.error ? "alert" : "status"}>
      <JourneyIcon name={graphFeedback.error ? "info" : "check"} size={17} /><span>{graphFeedback.message}</span>
      {!graphFeedback.error && history.length > 0 && <button type="button" disabled={!editable} onClick={undo}>{t("editor.undo")}</button>}
      <button type="button" className="j-feedback-dismiss" aria-label={t("editor.dismiss")} onClick={() => setGraphFeedback(null)}><JourneyIcon name="close" size={15} /></button>
    </div>}
    {validationIssues.length > 0 && <section className="j-validation" aria-label={t("editor.validationLabel")} role="alert"><strong>{t("editor.validationTitle")}</strong>
      <div>{validationIssues.map((issue, index) => <button type="button" key={`${issue.node_id ?? issue.node_index ?? "journey"}-${index}`}
        className={`j-validation-issue ${issue.level}`} onClick={() => {
          const node = issue.node_id ?? (issue.node_index != null ? definition.nodes[issue.node_index]?.id : undefined);
          setSelectedId(node ? `node:${node}` : "entry");
        }}><JourneyIcon name="info" size={15} />{issue.node_id && `${issue.node_id.slice(-6)} · `}{issue.message}</button>)}</div>
    </section>}

    <div className="j-editor-workspace"><aside className="j-palette" aria-label={t("editor.paletteLabel")}><div className="j-palette-main">
      <h2>{t("editor.addStep")}</h2><div className="j-palette-buttons">{NODE_TOOLS.map((tool) => <button key={tool.type} type="button"
        className="j-palette-add" disabled={!editable || !capabilities?.supported_node_types.includes(tool.type)} onClick={() => paletteInsert(tool.type)}>
        <span className={`j-icon-tile j-icon-${tool.type}`}><JourneyIcon name={tool.icon} /></span>
        <span>{nodeType(tool.type)}<small>{nodeTypeDescription(tool.type)}</small></span><JourneyIcon name="plus" size={16} />
      </button>)}</div>
      <p className="j-palette-hint">{t("editor.paletteHint1")}<br />{t("editor.paletteHint2")}</p>
      <button type="button" className="j-palette-setting" onClick={() => setSelectedId("entry")}><JourneyIcon name="users" size={17} />{t("editor.entrySettings")}<JourneyIcon name="arrow-right" size={14} /></button>
      <button type="button" className="j-palette-setting" onClick={() => setSelectedId("exit")}><JourneyIcon name="flag" size={17} />{t("editor.exitSettings")}<JourneyIcon name="arrow-right" size={14} /></button>
    </div><div className="j-flow-summary" aria-label={t("editor.summaryLabel")}>
      <div><span>{t("editor.summaryMessages")}</span><strong>{messageCount.toLocaleString(locale)}<small>{t("editor.countUnit")}</small></strong></div>
      <div className="j-duration-range"><span title={t("editor.summaryWaitTitle")}>{t("editor.summaryWait")}</span><strong className="j-duration-total">{durationText}</strong></div>
      <p><span />{t("editor.onePathPerCustomer")}</p>
    </div></aside>

    <JourneyCanvas definition={definition} selectedId={selectedId} supportedTypes={capabilities?.supported_node_types}
      segmentName={segments.data?.segments.find((segment) => segment.id === definition.entry.segment_id)?.name}
      editable={editable} onSelect={setSelectedId} onInsert={insertNode}
      onConnect={(source, port, target) => applyOperation(() => connectRoute(definition, source, port, target), t("editor.feedback.connected"))}
      onConnectionError={(issue) => setGraphFeedback({ message: message(issue), error: true })} />
    <JourneyInspector key={selectedId} definition={definition} selectedId={selectedId} publishedABNodes={publishedABNodes}
      segments={segments.data?.segments ?? []} segmentsPending={segments.isPending} segmentsError={segments.isError}
      onRetrySegments={() => { void segments.refetch(); }} editable={editable} onUpdate={updateDefinition}
      onMove={(id, offset) => applyOperation(() => moveLinearNode(definition, id, offset), t("editor.feedback.moved"))}
      onRemove={setRemoveId} onRenewExperiment={setRenewId}
      onConnect={(source, port, target) => applyOperation(() => connectRoute(definition, source, port, target), t("editor.feedback.connected"))} />
    </div>

    {pathChoice && <ChoosePathDialog definition={definition} nodeId={pathChoice.nodeId} type={pathChoice.type}
      onCancel={() => setPathChoice(null)} onChoose={(edgeId) => insertNode(edgeId, pathChoice.type)} />}
    {removeId && <RemoveNodeDialog definition={definition} nodeId={removeId} onCancel={() => setRemoveId(null)} onConfirm={(preview) => {
      setRemoveId(null); commitDefinition(preview.definition, t("editor.feedback.removed", { count: preview.removed.length }), "entry");
    }} />}
    {renewId && <RenewExperimentDialog onCancel={() => setRenewId(null)} onConfirm={() => {
      const next = renewExperiment(definition, renewId);
      const replacement = next.nodes.find((node, index) => node.id !== definition.nodes[index]?.id)!;
      setRenewId(null); commitDefinition(next, t("editor.feedback.renewed"), `node:${replacement.id}`);
    }} />}
    {confirmation && <ActivationDialog confirmation={confirmation} name={name} entryType={definition.entry.type}
      pending={activate.isPending} error={activate.error ? readableError(activate.error, text) : undefined}
      onCancel={() => { if (!activate.isPending) { setConfirmation(null); activate.reset(); } }}
      onConfirm={() => activate.mutate(confirmation)} />}
  </main>;
}

function ActivationDialog({ confirmation, name, entryType, pending, error, onCancel, onConfirm }: {
  confirmation: Confirmation;
  name: string;
  entryType: JourneyDefinition["entry"]["type"];
  pending: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t, locale } = useJourneyText();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return (
    <dialog ref={dialog} className="j-activation-dialog" aria-labelledby="activation-title" aria-describedby="activation-description"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <span className="j-dialog-icon"><JourneyIcon name="check" size={26} /></span>
      <h2 id="activation-title">{t("editor.activation.title")}</h2>
      <p className="j-dialog-name">{name}</p>
      <div className="j-activation-audience">
        <span>{entryType === "trigger" ? t("editor.activation.entryMode") : t("editor.activation.estimatedAudience")}</span>
        <strong>{entryType === "trigger" ? t("editor.activation.onEvent") : confirmation.estimated_count != null
          ? t("editor.activation.approxCount", { count: confirmation.estimated_count.toLocaleString(locale) }) : t("editor.activation.unknownCount")}</strong>
      </div>
      <p id="activation-description">{t("editor.activation.description")}</p>
      {confirmation.issues.filter((issue) => issue.level === "warning").map((issue, index) => (
        <p key={index} className="j-dialog-warning">{issue.message}</p>
      ))}
      {error && <p className="j-dialog-error" role="alert">{error}</p>}
      <div className="j-dialog-actions">
        <button type="button" className="j-button" autoFocus disabled={pending} onClick={onCancel}>{t("editor.activation.back")}</button>
        <button type="button" className="j-button j-button-primary" disabled={pending} onClick={onConfirm}>
          {pending ? t("editor.activation.activating") : t("editor.activation.confirm")}
        </button>
      </div>
    </dialog>
  );
}
