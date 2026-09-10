"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { ImportedEmailTemplate } from "./email-template-zip";
import { JourneyIcon } from "./journey-ui";
import "./journey-email-template-sheet.css";

interface Props {
  template: ImportedEmailTemplate;
  onCancel: () => void;
  onChooseAnother: () => void;
  onApply: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function JourneyEmailTemplateSheet({ template, onCancel, onChooseAnother, onApply }: Props) {
  const t = useTranslations("journeyEditor.emailSheet");
  const tz = useTranslations("journeyEditor"); // ZIP 경고 키(zip.*)는 email-template-zip.ts가 만든다
  const dialog = useRef<HTMLDialogElement>(null);
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [previewKey, setPreviewKey] = useState(0);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const scrollPosition = { left: window.scrollX, top: window.scrollY };
    const rootOverflow = document.documentElement.style.overflow;
    const bodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    element.showModal();
    window.scrollTo(scrollPosition);
    const frame = window.requestAnimationFrame(() => window.scrollTo(scrollPosition));
    return () => {
      window.cancelAnimationFrame(frame);
      if (element.open) element.close();
      document.documentElement.style.overflow = rootOverflow;
      document.body.style.overflow = bodyOverflow;
    };
  }, []);

  return (
    <dialog ref={dialog} className="j-template-sheet" aria-labelledby="j-template-sheet-title"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}>
      <header className="j-template-sheet-header">
        <h2 id="j-template-sheet-title" tabIndex={-1} autoFocus>{t("title")}</h2>
        <button type="button" className="j-template-icon-button" aria-label={t("close")} onClick={onCancel}>
          <JourneyIcon name="close" size={20} />
        </button>
      </header>

      <div className="j-template-sheet-body">
        <section className="j-template-file-summary" aria-label={t("fileInfo")}>
          <div className="j-template-file-name">
            <span className="j-template-file-icon"><JourneyIcon name="message" size={17} /></span>
            <strong>{template.archiveName}</strong>
            <small>{formatBytes(template.archiveSize)}</small>
            <span className="j-template-success"><JourneyIcon name="check" size={14} />{t("checked")}</span>
          </div>
          <button type="button" className="j-template-secondary-button" onClick={onChooseAnother}>{t("chooseAnother")}</button>
        </section>

        <section className="j-template-checks" aria-label={t("checks")}>
          <span><JourneyIcon name="check" size={15} />{t("entryChecked", { path: template.entryPath })}</span>
          <span><JourneyIcon name="check" size={15} />{t("noExternalScripts")}</span>
          <span title={template.imageCount > 0 ? t("imagesInlined", { count: template.imageCount }) : undefined}>
            <JourneyIcon name="check" size={15} />{t("imagePathsFixed")}
          </span>
        </section>

        <details className="j-template-file-details">
          <summary>{t("showFiles", { count: template.fileCount })}</summary>
          <ul>{template.files.map((path) => <li key={path}>{path}</li>)}</ul>
        </details>

        {template.warnings.length > 0 && (
          <div className="j-template-warning" role="status"><JourneyIcon name="info" size={16} />
            <div><strong>{t("warnings")}</strong>{template.warnings.map((warning) => <p key={JSON.stringify(warning)}>{tz(warning.key, warning.params)}</p>)}</div>
          </div>
        )}

        <section className="j-template-preview-section" aria-label={t("previewSection")}>
          <div className="j-template-preview-toolbar">
            <div className="j-template-viewport-switch" role="group" aria-label={t("viewport")}>
              <button type="button" aria-pressed={viewport === "desktop"}
                className={viewport === "desktop" ? "is-active" : undefined} onClick={() => setViewport("desktop")}>Desktop</button>
              <button type="button" aria-pressed={viewport === "mobile"}
                className={viewport === "mobile" ? "is-active" : undefined} onClick={() => setViewport("mobile")}>Mobile</button>
            </div>
            <button type="button" className="j-template-refresh" onClick={() => setPreviewKey((key) => key + 1)}>
              {t("refresh")}
            </button>
          </div>
          <div className={`j-template-preview-stage is-${viewport}`}>
            <iframe key={previewKey} title={t("iframeTitle", { name: template.archiveName })} sandbox="" srcDoc={template.previewHtml} />
          </div>
        </section>
      </div>

      <footer className="j-template-sheet-footer">
        <p>{t("footerHint")}</p>
        <div>
          <button type="button" className="j-button" onClick={onCancel}>{t("cancel")}</button>
          <button type="button" className="j-button j-button-primary" onClick={onApply}>{t("apply")}</button>
        </div>
      </footer>
    </dialog>
  );
}
