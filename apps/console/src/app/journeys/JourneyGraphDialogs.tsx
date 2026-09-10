"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { JourneyNode } from "@nudgeon/journey-model";
import { GraphOperationError, nodeTitle, outgoingEdges, previewRemoval, type GraphDefinition, type RemovalPreview } from "./journey-graph";
import { JourneyIcon, useJourneyText } from "./journey-ui";

export function JourneyDialog({ title, description, children, onCancel }: {
  title: string; description: string; children: ReactNode; onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="j-activation-dialog j-graph-dialog" aria-label={title}
    onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <h2>{title}</h2><p>{description}</p>{children}
  </dialog>;
}

export function RemoveNodeDialog({ definition, nodeId, onCancel, onConfirm }: {
  definition: GraphDefinition; nodeId: string; onCancel: () => void;
  onConfirm: (preview: RemovalPreview) => void;
}) {
  const { t, nodeType, message, ports: localizedPorts } = useJourneyText();
  const title = (item: JourneyNode) => nodeTitle(item, nodeType);
  const node = definition.nodes.find((item) => item.id === nodeId)!;
  const ports = localizedPorts(node);
  const [keepPort, setKeepPort] = useState(ports.length === 1 ? ports[0]!.id : "");
  let preview: RemovalPreview | null = null;
  let error = "";
  if (keepPort) {
    try { preview = previewRemoval(definition, nodeId, keepPort); }
    catch (caught) { error = caught instanceof GraphOperationError ? message(caught) : t("dialogs.remove.checkPath"); }
  }
  return <JourneyDialog title={t("dialogs.remove.title")} description={t("dialogs.remove.description", { title: title(node) })} onCancel={onCancel}>
    {ports.length > 1 && <fieldset className="j-delete-paths"><legend>{t("dialogs.remove.keepPath")}</legend>
      {ports.map((port) => {
        const target = definition.edges.find((edge) => edge.source === nodeId && edge.source_port === port.id)?.target;
        const next = definition.nodes.find((item) => item.id === target);
        return <label key={port.id}><input type="radio" name="keep-path" value={port.id} checked={keepPort === port.id}
          onChange={() => setKeepPort(port.id)} /><span><strong>{port.label}</strong><small>{next ? title(next) : t("ui.journeyExit")}</small></span></label>;
      })}
    </fieldset>}
    {preview && <div className="j-delete-preview" aria-live="polite">
      <strong>{t("dialogs.remove.removedCount", { count: preview.removed.length })}</strong>
      <ul>{preview.removed.map((item) => <li key={item.id}><JourneyIcon name="trash" size={14} /><span>{title(item)}</span><small>{item.id.slice(-6)}</small></li>)}</ul>
      {preview.sharedKept.length > 0 && <div className="j-delete-kept"><JourneyIcon name="check" size={16} /><p>
        {t("dialogs.remove.sharedKept", { titles: preview.sharedKept.map((item) => `“${title(item)}”`).join(", ") })}
      </p></div>}
      <p>{t("dialogs.remove.note")}</p>
    </div>}
    {error && <p className="j-dialog-error" role="alert">{error}</p>}
    <div className="j-dialog-actions"><button type="button" autoFocus className="j-button" onClick={onCancel}>{t("dialogs.cancel")}</button>
      <button type="button" className="j-button j-button-danger" disabled={!preview} onClick={() => preview && onConfirm(preview)}>{t("dialogs.remove.confirm")}</button>
    </div>
  </JourneyDialog>;
}

export function ChoosePathDialog({ definition, nodeId, type, onCancel, onChoose }: {
  definition: GraphDefinition; nodeId: string | null; type: JourneyNode["type"];
  onCancel: () => void; onChoose: (edgeId: string) => void;
}) {
  const { t, nodeType, ports: localizedPorts } = useJourneyText();
  const node = definition.nodes.find((item) => item.id === nodeId);
  const edges = nodeId === null ? definition.edges.filter((edge) => edge.target === null) : outgoingEdges(definition, nodeId);
  return <JourneyDialog title={t("dialogs.path.title")} description={t("dialogs.path.description", { type: nodeType(type) })} onCancel={onCancel}>
    <div className="j-path-choices">{edges.map((edge) => {
      const source = node ?? definition.nodes.find((item) => item.id === edge.source)!;
      const port = localizedPorts(source).find((item) => item.id === edge.source_port);
      const target = definition.nodes.find((item) => item.id === edge.target);
      return <button key={edge.id} type="button" className="j-path-choice" onClick={() => onChoose(edge.id)}>
        <JourneyIcon name="branch" size={18} /><span><strong>{port?.label ?? t("ui.next")}</strong>
          <small>{nodeTitle(source, nodeType)} → {target ? nodeTitle(target, nodeType) : t("ui.journeyExit")}</small></span><JourneyIcon name="plus" size={16} />
      </button>;
    })}</div>
    <div className="j-dialog-actions"><button type="button" className="j-button" autoFocus onClick={onCancel}>{t("dialogs.cancel")}</button></div>
  </JourneyDialog>;
}

export function RenewExperimentDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const { t } = useJourneyText();
  return <JourneyDialog title={t("dialogs.renew.title")} description={t("dialogs.renew.description")} onCancel={onCancel}>
    <div className="j-experiment-explanation"><p>{t("dialogs.renew.body1")}</p>
      <p>{t("dialogs.renew.body2")}</p></div>
    <div className="j-dialog-actions"><button type="button" className="j-button" autoFocus onClick={onCancel}>{t("dialogs.cancel")}</button>
      <button type="button" className="j-button j-button-primary" onClick={onConfirm}>{t("dialogs.renew.confirm")}</button></div>
  </JourneyDialog>;
}
