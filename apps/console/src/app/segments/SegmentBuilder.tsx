"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { Condition, SegmentDSL } from "@nudgeon/segment-dsl";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ATTR_OPS,
  EVENT_OPS,
  emptyDSL,
  newCondition,
  opNeedsValue,
} from "./builder-model";
import { useDebounced } from "./useDebounced";

interface Props {
  appId: string;
  segmentId?: string;
  initialName?: string;
  initialDSL?: SegmentDSL;
}

export function SegmentBuilder({ appId, segmentId, initialName, initialDSL }: Props) {
  const t = useTranslations("segmentBuilder");
  const router = useRouter();
  const [name, setName] = useState(initialName ?? "");
  const [dsl, setDsl] = useState<SegmentDSL>(initialDSL ?? emptyDSL());

  // 미리보기 — DSL 변경 500ms debounce 후 근사 카운트 (PRD-05 3.3)
  const debouncedDsl = useDebounced(dsl, 500);
  const preview = useQuery({
    queryKey: ["preview", appId, JSON.stringify(debouncedDsl)],
    queryFn: () => api.segments.preview(appId, { definition: debouncedDsl }),
    enabled: !!appId,
    retry: false,
  });

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      if (segmentId) {
        await api.segments.update(appId, segmentId, { name, definition: dsl });
      } else {
        await api.segments.create(appId, { name, definition: dsl });
      }
    },
    onSuccess: () => router.push("/segments"),
  });

  const update = (mut: (d: SegmentDSL) => void) => {
    const next = structuredClone(dsl);
    mut(next);
    setDsl(next);
  };

  const canSave = name.trim().length > 0 && !preview.isError;

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_280px]">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">{t("name")}</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="flex items-center gap-2 text-sm">
          <span>{t("groupJoin")}</span>
          <OpToggle
            value={dsl.operator}
            onChange={(op) => update((d) => (d.operator = op))}
          />
        </div>

        {dsl.groups.map((group, gi) => (
          <Card key={gi}>
            <CardHeader className="flex-row items-center justify-between p-4">
              <CardTitle className="flex items-center gap-2 text-sm">
                {t("group", { n: gi + 1 })}
                <OpToggle
                  value={group.operator}
                  onChange={(op) => update((d) => (d.groups[gi]!.operator = op))}
                />
              </CardTitle>
              {dsl.groups.length > 1 && (
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-xs text-destructive"
                  onClick={() => update((d) => d.groups.splice(gi, 1))}
                >
                  {t("removeGroup")}
                </Button>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-2 p-4 pt-0">
              {group.conditions.map((cond, ci) => (
                <ConditionRow
                  key={ci}
                  condition={cond}
                  onChange={(c) => update((d) => (d.groups[gi]!.conditions[ci] = c))}
                  onRemove={
                    group.conditions.length > 1
                      ? () => update((d) => d.groups[gi]!.conditions.splice(ci, 1))
                      : undefined
                  }
                />
              ))}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={() => update((d) => d.groups[gi]!.conditions.push(newCondition("attribute")))}
                >
                  {t("addAttribute")}
                </Button>
                <Button
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={() => update((d) => d.groups[gi]!.conditions.push(newCondition("event")))}
                >
                  {t("addEvent")}
                </Button>
                <Button
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={() => update((d) => d.groups[gi]!.conditions.push(newCondition("channel")))}
                >
                  {t("addChannel")}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}

        <Button
          variant="outline"
          className="w-fit"
          onClick={() =>
            update((d) => d.groups.push({ operator: "AND", conditions: [newCondition("attribute")] }))
          }
        >
          {t("addGroup")}
        </Button>
      </div>

      {/* 우측 고정 미리보기 패널 */}
      <aside className="flex h-fit flex-col gap-3 md:sticky md:top-8">
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">{t("preview.title")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {preview.isError ? (
              <p className="text-sm text-destructive">
                {t("preview.error")}
              </p>
            ) : preview.isFetching ? (
              <p className="text-2xl font-bold text-muted-foreground">…</p>
            ) : (
              <p className="text-2xl font-bold">
                {t("preview.approx", { count: preview.data?.approx_count ?? 0 })}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">{t("preview.note")}</p>
            {preview.data && preview.data.sample.length > 0 && (
              <div className="mt-3 border-t border-border pt-3">
                <p className="mb-1 text-xs font-medium">{t("preview.sample")}</p>
                {preview.data.sample.slice(0, 5).map((s) => (
                  <p key={s.user_id} className="truncate text-xs text-muted-foreground">
                    {s.external_id ?? s.user_id.slice(0, 8)} · {s.platforms.join("/") || "—"}
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Button disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? t("saving") : segmentId ? t("save") : t("create")}
        </Button>
        {save.isError && (
          <p className="text-xs text-destructive">
            {t("saveFailed")}
          </p>
        )}
      </aside>
    </div>
  );
}

function OpToggle({ value, onChange }: { value: "AND" | "OR"; onChange: (op: "AND" | "OR") => void }) {
  return (
    <div className="flex overflow-hidden rounded-md border border-border text-xs">
      {(["AND", "OR"] as const).map((op) => (
        <button
          key={op}
          className={`px-2 py-1 ${value === op ? "bg-primary text-primary-foreground" : "bg-transparent"}`}
          onClick={() => onChange(op)}
        >
          {op}
        </button>
      ))}
    </div>
  );
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: Condition;
  onChange: (c: Condition) => void;
  onRemove?: () => void;
}) {
  const t = useTranslations("segmentBuilder");
  const setField = (patch: Partial<Condition>) =>
    onChange({ ...condition, ...patch } as Condition);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
      {condition.type === "attribute" && (
        <>
          <Input
            className="h-8 w-32 text-xs"
            placeholder={t("condition.attributeKey")}
            value={condition.key}
            onChange={(e) => setField({ key: e.target.value })}
          />
          <Select
            value={condition.op}
            options={ATTR_OPS as readonly string[]}
            onChange={(op) => setField({ op: op as never })}
          />
          {opNeedsValue(condition.op) && (
            <Input
              className="h-8 w-32 text-xs"
              placeholder={t("condition.value")}
              value={valueToInput(condition.value)}
              onChange={(e) => setField({ value: inputToValue(condition.op, e.target.value) })}
            />
          )}
        </>
      )}
      {condition.type === "event" && (
        <>
          <Input
            className="h-8 w-32 text-xs"
            placeholder={t("condition.eventName")}
            value={condition.event}
            onChange={(e) => setField({ event: e.target.value })}
          />
          <Select
            value={condition.op}
            options={EVENT_OPS as readonly string[]}
            onChange={(op) => setField({ op: op as never })}
          />
          {condition.op.startsWith("count") && (
            <Input
              className="h-8 w-16 text-xs"
              type="number"
              value={String(condition.value ?? 1)}
              onChange={(e) => setField({ value: Number(e.target.value) })}
            />
          )}
          <span className="text-xs text-muted-foreground">{t("condition.recent")}</span>
          <Input
            className="h-8 w-14 text-xs"
            type="number"
            value={String(condition.window_days ?? 30)}
            onChange={(e) => setField({ window_days: Number(e.target.value) })}
          />
          <span className="text-xs text-muted-foreground">{t("condition.days")}</span>
        </>
      )}
      {condition.type === "channel" && (
        <span className="text-xs">{t("condition.pushReachable")}</span>
      )}
      {condition.type === "device" && (
        <span className="text-xs text-muted-foreground">{t("condition.device")}</span>
      )}
      <div className="ml-auto">
        {onRemove && (
          <button className="text-xs text-muted-foreground hover:text-destructive" onClick={onRemove}>
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      className="h-8 rounded-md border border-border bg-card px-2 text-xs"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function valueToInput(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  return String(v ?? "");
}

function inputToValue(op: string, raw: string): unknown {
  if (op === "in") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (op === "in_last_days" || op === "not_in_last_days") return Number(raw) || 0;
  return raw;
}
