"use client";
import { useEffect, useRef, useState } from "react";
import type { InAppManifest } from "@nudgeon/api-client";
export function InAppPreview({
  url,
  manifest,
  onLog,
  title,
}: {
  url: string;
  manifest: InAppManifest;
  onLog: (value: string) => void;
  title: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null),
    log = useRef(onLog);
  log.current = onLog;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let port: MessagePort | undefined;
    const execution_id = crypto.randomUUID(),
      nonce = crypto.randomUUID();
    let count = 0;
    setReady(false);
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== "nudgeon:hello" ||
        port
      )
        return;
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (e) => {
        if (++count > 200) return;
        const m = e.data;
        if (
          !m ||
          m.protocol !== 1 ||
          m.execution_id !== execution_id ||
          m.nonce !== nonce ||
          typeof m.request_id !== "string"
        )
          return;
        let ok = true,
          detail = m.method;
        if (m.method === "ready") {
          setReady(true);
          detail = "content_ready";
        } else if (m.method === "performAction") {
          const id = m.payload?.action_id,
            action = typeof id === "string" ? manifest.actions[id] : undefined;
          ok = !!action;
          detail = action
            ? `${id} → ${JSON.stringify(action)} (preview only)`
            : "ACTION_NOT_ALLOWED";
        } else if (m.method === "hideToday")
          detail = "hide_today → 오늘 하루 안 보기 (미리보기: 실제 숨김은 적용되지 않음)";
        else if (m.method === "dismiss") detail = "dismiss (preview only)";
        else if (m.method === "log")
          detail = String(m.payload?.code ?? "JS_ERROR").slice(0, 100);
        else {
          ok = false;
          detail = "UNKNOWN_METHOD";
        }
        log.current(detail);
        port?.postMessage({
          request_id: m.request_id,
          ok,
          ...(!ok
            ? { error: { code: detail } }
            : { result: { preview: true } }),
        });
      };
      port.start();
      event.source?.postMessage(
        { type: "nudgeon:init", execution_id, nonce },
        { targetOrigin: "*", transfer: [channel.port2] },
      );
    };
    window.addEventListener("message", receive);
    const timeout = setTimeout(() => {
      if (!port) log.current("PREVIEW_CONNECTION_TIMEOUT");
    }, 10000);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      port?.close();
    };
  }, [url, manifest]);
  return (
    <div className="ia-phone">
      <div className="ia-phone-bar">
        <span>9:41</span>
        <span>••• ▰</span>
      </div>
      <div className="ia-app-background">
        <b>My app</b>
        <div />
        <div />
        <div />
      </div>
      <div
        className="ia-backdrop"
        style={{
          background: `rgba(0,0,0,${manifest.display.backdrop_opacity})`,
        }}
      />
      <iframe
        style={
          manifest.display.type === "bottom"
            ? { top: "auto", bottom: 16, height: "65%" }
            : manifest.display.type === "modal"
              ? { top: "12%", height: "80%" }
              : undefined
        }
        ref={frame}
        title={title}
        src={url}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
      <div className="ia-phone-state">{ready ? "Preview" : "Loading…"}</div>
    </div>
  );
}
