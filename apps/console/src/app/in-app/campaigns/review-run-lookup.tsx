"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { InAppRun } from "@nudgeon/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ReviewRunLookup({ runs, selected, loading, failed, disabled, onSelect }: {
  runs: InAppRun[]; selected: string; loading: boolean; failed: boolean; disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations("inAppCampaigns");
  const [input, setInput] = useState(""), [result, setResult] = useState("");
  const current = runs.find(r => r.id === selected);
  function find() {
    onSelect("");
    const id = input.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) {
      setResult(t("lookupInvalid")); return;
    }
    const match = runs.find(r => r.id.toLowerCase() === id);
    if (!match) { setResult(t("lookupMissing")); return; }
    if (match.state !== "completed") { setResult(t("lookupIncomplete")); return; }
    onSelect(match.id); setResult(t("lookupFound"));
  }
  return <div className="ic-run-lookup">
    <label className="ic-label" htmlFor="review-run-lookup">{t("lookupTitle")}</label>
    <div className="ic-actions">
      <Input id="review-run-lookup" value={input} maxLength={64} placeholder={t("lookupPlaceholder")}
        disabled={disabled} onChange={e => { setInput(e.target.value); setResult(""); onSelect(""); }}
        onKeyDown={e => { if (e.key === "Enter" && !disabled && !loading && !failed) { e.preventDefault(); find(); } }} />
      <Button type="button" variant="outline" disabled={disabled || loading || failed || !input.trim()} onClick={find}>{t("lookupFind")}</Button>
    </div>
    <p className="ic-muted">{t("lookupScope")}</p>
    {result && <p role="status">{result}</p>}
    {current && <dl className="ic-run-context">
      <dt>{t("lookupRun")}</dt><dd>{current.id}</dd>
      <dt>{t("lookupRevision")}</dt><dd>{current.revision_id}</dd>
      <dt>OS</dt><dd>{current.platform}</dd>
      <dt>{t("lookupCreated")}</dt><dd>{new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(current.created_at))} KST</dd>
    </dl>}
  </div>;
}
