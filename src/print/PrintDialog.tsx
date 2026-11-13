import { useRef, useState } from "react";
import type { PdfEngine } from "../engine/engine";
import type { DocInfo } from "../engine/types";
import { Modal } from "../components/Modal";
import { PageScopeField, usePageScope } from "../components/PageScope";
import { errorText } from "../errors";
import { useT } from "../i18n";
import { printDocument } from "./print";

interface Props {
  engine: PdfEngine;
  doc: DocInfo;
  currentPage: number;
  onClose(): void;
}

const QUALITY_KEY = "scamcrobat.printQuality";
type Quality = "standard" | "high";
const DPI: Record<Quality, number> = { standard: 150, high: 300 };

function readQuality(): Quality {
  try {
    return localStorage.getItem(QUALITY_KEY) === "high" ? "high" : "standard";
  } catch {
    return "standard";
  }
}

type Phase = { kind: "setup" } | { kind: "running"; done: number; total: number } | { kind: "failed"; message: string };

export function PrintDialog({ engine, doc, currentPage, onClose }: Props) {
  const t = useT();
  const scope = usePageScope(doc.pageCount, currentPage);
  const [quality, setQuality] = useState<Quality>(readQuality);
  const [phase, setPhase] = useState<Phase>({ kind: "setup" });
  const cancelled = useRef(false);

  const chooseQuality = (q: Quality) => {
    setQuality(q);
    try {
      localStorage.setItem(QUALITY_KEY, q);
    } catch {
      /* not critical */
    }
  };

  async function run() {
    const pages = scope.pages;
    if (!pages?.length) return;
    cancelled.current = false;
    setPhase({ kind: "running", done: 0, total: pages.length });
    try {
      await printDocument(engine, doc, {
        pages,
        dpi: DPI[quality],
        onProgress: (done, total) => setPhase({ kind: "running", done, total }),
        cancelled: () => cancelled.current,
      });
      onClose();
    } catch (e) {
      setPhase({ kind: "failed", message: errorText(e) });
    }
  }

  if (phase.kind === "running") {
    return (
      <Modal title={t.print.title} onClose={() => (cancelled.current = true)} locked>
        <p>{t.print.preparing(Math.min(phase.done + 1, phase.total), phase.total)}</p>
        <div className="progress">
          <div className="progress-bar" style={{ width: `${(phase.done / phase.total) * 100}%` }} />
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => (cancelled.current = true)}>
            {t.common.stop}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={t.print.title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button className="btn primary" disabled={!scope.pages?.length} onClick={run} data-autofocus>
            {t.print.print}
          </button>
        </>
      }
    >
      {phase.kind === "failed" && <div className="alert">{t.print.failed(phase.message)}</div>}

      {doc.pageCount > 1 && <PageScopeField state={scope} pageCount={doc.pageCount} currentPage={currentPage} />}

      <fieldset className="field">
        <legend>{t.print.quality}</legend>
        <div className="segmented">
          {(["standard", "high"] as const).map((q) => (
            <button key={q} className={quality === q ? "active" : ""} onClick={() => chooseQuality(q)} aria-pressed={quality === q}>
              {q === "standard" ? t.print.standard : t.print.high}
              <small>{q === "standard" ? t.print.standardHint : t.print.highHint}</small>
            </button>
          ))}
        </div>
        <p className="hint">{t.print.hint}</p>
      </fieldset>
    </Modal>
  );
}
