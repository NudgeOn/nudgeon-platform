"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { outputPorts, type JourneyNode } from "@nudgeon/journey-model";
import { NODE_TOOLS } from "./journey-editor-model";
import { nodeTitle, outgoingEdges, previewRemoval, type GraphDefinition, type RemovalPreview } from "./journey-graph";
import { JourneyIcon } from "./journey-ui";

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
  const node = definition.nodes.find((item) => item.id === nodeId)!;
  const ports = outputPorts(node);
  const [keepPort, setKeepPort] = useState(ports.length === 1 ? ports[0]!.id : "");
  let preview: RemovalPreview | null = null;
  let error = "";
  if (keepPort) {
    try { preview = previewRemoval(definition, nodeId, keepPort); }
    catch (caught) { error = caught instanceof Error ? caught.message : "삭제할 경로를 확인해 주세요."; }
  }
  return <JourneyDialog title="단계 삭제 미리보기" description={`“${nodeTitle(node)}” 삭제 후의 흐름을 확인하세요.`} onCancel={onCancel}>
    {ports.length > 1 && <fieldset className="j-delete-paths"><legend>삭제 후 보존할 경로</legend>
      {ports.map((port) => {
        const target = definition.edges.find((edge) => edge.source === nodeId && edge.source_port === port.id)?.target;
        const next = definition.nodes.find((item) => item.id === target);
        return <label key={port.id}><input type="radio" name="keep-path" value={port.id} checked={keepPort === port.id}
          onChange={() => setKeepPort(port.id)} /><span><strong>{port.label}</strong><small>{next ? nodeTitle(next) : "저니 종료"}</small></span></label>;
      })}
    </fieldset>}
    {preview && <div className="j-delete-preview" aria-live="polite">
      <strong>삭제되는 단계 {preview.removed.length}개</strong>
      <ul>{preview.removed.map((item) => <li key={item.id}><JourneyIcon name="trash" size={14} /><span>{nodeTitle(item)}</span><small>{item.id.slice(-6)}</small></li>)}</ul>
      {preview.sharedKept.length > 0 && <div className="j-delete-kept"><JourneyIcon name="check" size={16} /><p>
        공통 단계 {preview.sharedKept.map((item) => `“${nodeTitle(item)}”`).join(", ")}와 그 이후 흐름은 유지됩니다.
      </p></div>}
      <p>선택하지 않은 경로 중 더 이상 도달할 수 없는 단계만 함께 삭제됩니다. 삭제 후 되돌릴 수 있습니다.</p>
    </div>}
    {error && <p className="j-dialog-error" role="alert">{error}</p>}
    <div className="j-dialog-actions"><button type="button" autoFocus className="j-button" onClick={onCancel}>취소</button>
      <button type="button" className="j-button j-button-danger" disabled={!preview} onClick={() => preview && onConfirm(preview)}>확인 후 삭제</button>
    </div>
  </JourneyDialog>;
}

export function ChoosePathDialog({ definition, nodeId, type, onCancel, onChoose }: {
  definition: GraphDefinition; nodeId: string | null; type: JourneyNode["type"];
  onCancel: () => void; onChoose: (edgeId: string) => void;
}) {
  const node = definition.nodes.find((item) => item.id === nodeId);
  const edges = nodeId === null ? definition.edges.filter((edge) => edge.target === null) : outgoingEdges(definition, nodeId);
  return <JourneyDialog title="어느 경로에 추가할까요?" description={`${NODE_TOOLS.find((tool) => tool.type === type)!.label} 단계를 추가할 위치를 선택하세요.`} onCancel={onCancel}>
    <div className="j-path-choices">{edges.map((edge) => {
      const source = node ?? definition.nodes.find((item) => item.id === edge.source)!;
      const port = outputPorts(source).find((item) => item.id === edge.source_port);
      const target = definition.nodes.find((item) => item.id === edge.target);
      return <button key={edge.id} type="button" className="j-path-choice" onClick={() => onChoose(edge.id)}>
        <JourneyIcon name="branch" size={18} /><span><strong>{port?.label ?? "다음"}</strong>
          <small>{nodeTitle(source)} → {target ? nodeTitle(target) : "저니 종료"}</small></span><JourneyIcon name="plus" size={16} />
      </button>;
    })}</div>
    <div className="j-dialog-actions"><button type="button" className="j-button" autoFocus onClick={onCancel}>취소</button></div>
  </JourneyDialog>;
}

export function RenewExperimentDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return <JourneyDialog title="새 A/B 실험으로 시작할까요?" description="이 분기에 새 실험 ID를 발급합니다." onCancel={onCancel}>
    <div className="j-experiment-explanation"><p>새로 활성화한 버전의 고객은 비율에 따라 다시 배정됩니다. 이후 경로 개수와 비율을 수정할 수 있습니다.</p>
      <p>이미 진행 중인 고객은 기존 버전·기존 배정을 유지합니다. 현재의 연결과 메시지는 그대로 복사됩니다.</p></div>
    <div className="j-dialog-actions"><button type="button" className="j-button" autoFocus onClick={onCancel}>취소</button>
      <button type="button" className="j-button j-button-primary" onClick={onConfirm}>새 실험 만들기</button></div>
  </JourneyDialog>;
}
