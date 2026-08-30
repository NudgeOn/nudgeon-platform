"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { JourneyDefinition, JourneyNode } from "@onda/journey-model";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  appId: string;
  journeyId?: string;
  initialName?: string;
  initialDef?: JourneyDefinition;
  status?: string;
}

function emptyDef(): JourneyDefinition {
  return {
    entry: { type: "blast" },
    nodes: [{ type: "message", push: { title: "", body: "" } }],
    exit: {},
    settings: { category: "marketing", reentry: "never" },
  };
}

/** 선형 저니 편집기 (PRD-05 3.4의 MVP — 캔버스 대신 노드 리스트, 선형 제약) */
export function JourneyEditor({ appId, journeyId, initialName, initialDef, status }: Props) {
  const router = useRouter();
  const [name, setName] = useState(initialName ?? "");
  const [def, setDef] = useState<JourneyDefinition>(initialDef ?? emptyDef());
  const [confirmModal, setConfirmModal] = useState<{ count: number | null } | null>(null);

  const segments = useQuery({
    queryKey: ["segments", appId],
    queryFn: () => api.segments.list(appId),
    enabled: !!appId,
  });

  const update = (mut: (d: JourneyDefinition) => void) => {
    const next = structuredClone(def);
    mut(next);
    setDef(next);
  };

  const isDraft = !status || status === "draft" || status === "paused";

  const save = useMutation({
    mutationFn: async (): Promise<string> => {
      if (journeyId) {
        await api.journeys.update(appId, journeyId, { name, definition: def });
        return journeyId;
      }
      const r = await api.journeys.create(appId, { name, definition: def });
      return r.id;
    },
  });

  const validateAndActivate = useMutation({
    mutationFn: async () => {
      const id = journeyId ?? (await save.mutateAsync());
      const v = await api.journeys.validate(appId, id);
      return { id, ...v };
    },
    onSuccess: (v) => {
      const hasError = v.issues.some((i) => i.level === "error");
      if (hasError) {
        setConfirmModal(null);
        return;
      }
      setConfirmModal({ count: v.estimated_count });
    },
  });

  const activate = useMutation({
    mutationFn: async () => {
      const id = journeyId ?? (await save.mutateAsync());
      return api.journeys.activate(appId, id);
    },
    onSuccess: () => router.push("/journeys"),
  });

  const validationIssues = validateAndActivate.data?.issues ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">저니 이름</Label>
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} disabled={!isDraft} />
      </div>

      {/* 진입 */}
      <Card>
        <CardHeader className="p-4">
          <CardTitle className="text-sm">진입 (Entry)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 p-4 pt-0">
          <div className="flex items-center gap-2 text-sm">
            <span>대상 세그먼트 (일괄 진입):</span>
            <select
              className="h-8 rounded-md border border-border bg-card px-2 text-sm"
              value={def.entry.segment_id ?? ""}
              disabled={!isDraft}
              onChange={(e) => update((d) => (d.entry = { type: "blast", segment_id: e.target.value || undefined }))}
            >
              <option value="">선택…</option>
              {segments.data?.segments
                .filter((s) => s.status === "active")
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span>카테고리:</span>
            <select
              className="h-8 rounded-md border border-border bg-card px-2 text-sm"
              value={def.settings.category}
              disabled={!isDraft}
              onChange={(e) =>
                update((d) => (d.settings.category = e.target.value as "marketing" | "transactional"))
              }
            >
              <option value="marketing">마케팅</option>
              <option value="transactional">거래성 (opt-out·야간·빈도 우회)</option>
            </select>
          </div>
        </CardContent>
      </Card>

      {/* 노드 체인 (선형) */}
      {def.nodes.map((node, i) => (
        <div key={i} className="flex flex-col items-center gap-1">
          <div className="text-muted-foreground">↓</div>
          <NodeCard
            node={node}
            index={i}
            editable={isDraft}
            onChange={(n) => update((d) => (d.nodes[i] = n))}
            onRemove={def.nodes.length > 1 ? () => update((d) => d.nodes.splice(i, 1)) : undefined}
          />
        </div>
      ))}

      {isDraft && (
        <div className="flex justify-center gap-2">
          <Button
            variant="outline"
            className="h-8 px-3 text-xs"
            onClick={() => update((d) => d.nodes.push({ type: "message", push: { title: "", body: "" } }))}
          >
            + 푸시 메시지
          </Button>
          <Button
            variant="outline"
            className="h-8 px-3 text-xs"
            onClick={() => update((d) => d.nodes.push({ type: "delay", duration_seconds: 86400 }))}
          >
            + 대기
          </Button>
        </div>
      )}

      {/* 검증 이슈 */}
      {validationIssues.length > 0 && (
        <div className="flex flex-col gap-1">
          {validationIssues.map((iss, idx) => (
            <p
              key={idx}
              className={`text-sm ${iss.level === "error" ? "text-destructive" : "text-muted-foreground"}`}
            >
              {iss.level === "error" ? "✕" : "⚠"} {iss.message}
            </p>
          ))}
        </div>
      )}

      {isDraft && (
        <div className="flex gap-2">
          <Button variant="outline" disabled={!name || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "저장 중…" : "임시 저장"}
          </Button>
          <Button
            disabled={!name || validateAndActivate.isPending}
            onClick={() => validateAndActivate.mutate()}
          >
            검증 후 활성화
          </Button>
        </div>
      )}

      {/* 활성화 확인 모달 */}
      {confirmModal && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40">
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle className="text-base">저니를 활성화할까요?</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm">
                예상 대상{" "}
                <strong>
                  {confirmModal.count != null ? `약 ${confirmModal.count.toLocaleString()}명` : "(카운트 없음)"}
                </strong>
                에게 발송이 시작됩니다.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setConfirmModal(null)}>
                  취소
                </Button>
                <Button disabled={activate.isPending} onClick={() => activate.mutate()}>
                  {activate.isPending ? "활성화 중…" : "활성화"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function NodeCard({
  node,
  index,
  editable,
  onChange,
  onRemove,
}: {
  node: JourneyNode;
  index: number;
  editable: boolean;
  onChange: (n: JourneyNode) => void;
  onRemove?: () => void;
}) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="flex-row items-center justify-between p-3">
        <CardTitle className="text-sm">
          {node.type === "message" ? "📩 푸시 메시지" : "⏱ 대기"} · {index + 1}
        </CardTitle>
        {editable && onRemove && (
          <button className="text-xs text-muted-foreground hover:text-destructive" onClick={onRemove}>
            ✕
          </button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-3 pt-0">
        {node.type === "message" ? (
          <>
            <Input
              className="h-8 text-sm"
              placeholder="제목 ({{first_name}} 변수 가능)"
              value={node.push.title}
              disabled={!editable}
              onChange={(e) => onChange({ ...node, push: { ...node.push, title: e.target.value } })}
            />
            <textarea
              className="h-16 rounded-md border border-border bg-card p-2 text-sm"
              placeholder="본문"
              value={node.push.body}
              disabled={!editable}
              onChange={(e) => onChange({ ...node, push: { ...node.push, body: e.target.value } })}
            />
          </>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <Input
              className="h-8 w-24 text-sm"
              type="number"
              value={String(Math.round(node.duration_seconds / 3600))}
              disabled={!editable}
              onChange={(e) => onChange({ ...node, duration_seconds: Number(e.target.value) * 3600 })}
            />
            <span>시간 대기</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
