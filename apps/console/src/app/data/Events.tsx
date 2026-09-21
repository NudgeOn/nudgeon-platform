"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { STANDARD_EVENTS } from "@nudgeon/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function Events() {
  const t = useTranslations("eventCatalog");
  const [selected, setSelected] = useState<(typeof STANDARD_EVENTS)[number]>(STANDARD_EVENTS[0]);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const example = JSON.stringify({ event: selected.name, properties: selected.properties }, null, 2);

  async function copy() {
    try {
      await navigator.clipboard.writeText(example);
      setCopyState("copied");
    } catch { setCopyState("failed"); }
  }

  return <section aria-label={t("title")} className="space-y-5">
    <div>
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("intro")}</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {STANDARD_EVENTS.map((event) => <button key={event.name} type="button"
        aria-pressed={selected.name === event.name} aria-controls="event-details"
        onClick={() => { setSelected(event); setCopyState("idle"); }}
        className={`min-w-0 rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected.name === event.name ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted"}`}>
        <span className="block font-semibold">{t(`events.${event.name}.label`)}</span>
        <code className="mt-1 block break-all text-xs text-muted-foreground">{event.name}</code>
        <span className="mt-3 block text-sm leading-5 text-muted-foreground">{t(`events.${event.name}.description`)}</span>
      </button>)}
    </div>
    <Card id="event-details">
      <CardContent className="space-y-5 p-4 sm:p-6">
        <div>
          <h3 className="font-semibold">{t(`events.${selected.name}.label`)} <code className="ml-2 break-all text-xs text-muted-foreground">{selected.name}</code></h3>
          <p className="mt-2 text-sm text-muted-foreground">{t("propertyHelp")}</p>
        </div>
        <dl className="space-y-3">
          {Object.entries(selected.properties).map(([key, value]) => <div key={key} className="grid gap-1 sm:grid-cols-[160px_1fr]">
            <dt className="break-all font-mono text-sm">{key} <span className="text-xs text-muted-foreground">{typeof value === "number" ? t("number") : t("string")}</span></dt>
            <dd className="text-sm text-muted-foreground">{t(`properties.${key}`)}</dd>
          </div>)}
        </dl>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-medium">{t("example")}</h4>
          <Button type="button" variant="outline" onClick={() => void copy()}>{t("copy")}</Button>
        </div>
        <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs leading-6"><code>{example}</code></pre>
        <p role="status" className="text-sm">{copyState === "copied" ? t("copied") : copyState === "failed" ? t("copyFailed") : ""}</p>
        <p className="text-sm leading-6 text-muted-foreground">{t("integrationHelp")}</p>
        <p className="text-sm leading-6 text-muted-foreground">{t("customHelp")}</p>
      </CardContent>
    </Card>
  </section>;
}
