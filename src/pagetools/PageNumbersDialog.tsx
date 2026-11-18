/** Adds page numbers: position, format ("1", "1 / 10", "Page 1 of 10"…), first number, which pages. */
import { useState } from "react";
import type { PdfEngine } from "../engine/engine";
import type { DocInfo, EditState, StampPosition } from "../engine/types";
import { Modal } from "../components/Modal";
import { PageScopeField, usePageScope } from "../components/PageScope";
import { errorText } from "../errors";
import { useT, type Messages } from "../i18n";
import { loadJson, saveJson } from "./settings";
import { StampPreview } from "./StampPreview";

interface Props {
  engine: PdfEngine;
  doc: DocInfo;
  currentPage: number;
  onDone(state: EditState, pages: number): void;
  onClose(): void;
}

type Format = "n" | "n/total" | "page" | "dash";

interface Settings {
  position: string;
  format: string;
  size: number;
}

const KEY = "scamcrobat.pageNumbers";
const POSITIONS: StampPosition[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];
const FORMATS: Format[] = ["n", "n/total", "page", "dash"];
const SIZES = [8, 9, 10, 11, 12, 14, 16];

function formatNumber(format: Format, n: number, total: number, t: Messages): string {
  switch (format) {
    case "n/total":
      return `${n} / ${total}`;
    case "page":
      return t.pageNumbers.pageOf(n, total);
    case "dash":
      return `– ${n} –`;
    default:
      return String(n);
  }
}

export function PageNumbersDialog({ engine, doc, currentPage, onDone, onClose }: Props) {
  const t = useT();
  const p = t.pageNumbers;
  const [s, setS] = useState<Settings>(() => loadJson(KEY, { position: "bottom-center", format: "n", size: 10 }));
  const position = (POSITIONS.includes(s.position as StampPosition) ? s.position : "bottom-center") as StampPosition;
  const format = (FORMATS.includes(s.format as Format) ? s.format : "n") as Format;
  const size = SIZES.includes(s.size) ? s.size : 10;
  const [startText, setStartText] = useState("1");
  const scope = usePageScope(doc.pageCount, currentPage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Settings>) => setS((prev) => ({ ...prev, ...patch }));

  const start = /^\d{1,6}$/.test(startText.trim()) ? parseInt(startText, 10) : NaN;
  const pages = scope.pages ? [...scope.pages].sort((a, b) => a - b) : null;
  const canApply = !!pages?.length && Number.isFinite(start) && !busy;
  const total = pages ? start + pages.length - 1 : 0;
  const textFor = (k: number) => formatNumber(format, start + k, total, t);
  const previewIndex = Math.max(0, pages?.indexOf(currentPage) ?? 0);
  const previewPage = pages?.[previewIndex] ?? currentPage;

  async function apply() {
    if (!canApply || !pages) return;
    saveJson(KEY, { position, format, size });
    setBusy(true);
    setError(null);
    try {
      const state = await engine.stamp(doc.docId, {
        kind: "pageNumbers",
        texts: pages.map((page, k) => ({ page, text: textFor(k) })),
        size,
        color: [0, 0, 0],
        opacity: 1,
        rotation: 0,
        position,
        under: false,
      });
      onDone(state, pages.length);
    } catch (e) {
      setError(p.failed(errorText(e)));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={p.title}
      onClose={onClose}
      locked={busy}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </button>
          <button className="btn primary" onClick={apply} disabled={!canApply} data-autofocus>
            {p.apply}
          </button>
        </>
      }
    >
      {error && <div className="alert">{error}</div>}
      <div className="stamp-dialog">
        <div className="stamp-fields">
          <fieldset className="field">
            <legend>{p.position}</legend>
            <div className="position-grid">
              {POSITIONS.map((pos) => (
                <button
                  key={pos}
                  className={position === pos ? "active" : ""}
                  aria-pressed={position === pos}
                  onClick={() => set({ position: pos })}
                >
                  {p.positions[pos]}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="field-row">
            <fieldset className="field grow">
              <legend>{p.format}</legend>
              <select className="input wide" value={format} onChange={(e) => set({ format: e.target.value })}>
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {formatNumber(f, 1, Math.max(doc.pageCount, 2), t)}
                  </option>
                ))}
              </select>
            </fieldset>
            <fieldset className="field">
              <legend>{p.size}</legend>
              <select className="input" value={size} onChange={(e) => set({ size: Number(e.target.value) })}>
                {SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n} pt
                  </option>
                ))}
              </select>
            </fieldset>
          </div>

          <fieldset className="field">
            <legend>{p.start}</legend>
            <input
              className={Number.isFinite(start) ? "input num-input" : "input num-input invalid"}
              inputMode="numeric"
              value={startText}
              onChange={(e) => setStartText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void apply()}
            />
            <p className="hint">{p.startHint}</p>
          </fieldset>

          {doc.pageCount > 1 && <PageScopeField state={scope} pageCount={doc.pageCount} currentPage={currentPage} />}
        </div>

        <div className="stamp-side">
          <div className="stamp-side-title">{t.watermark.preview}</div>
          <StampPreview
            engine={engine}
            docId={doc.docId}
            page={previewPage}
            info={doc.pages[previewPage]}
            stamp={{
              kind: "pageNumbers",
              text: Number.isFinite(start) ? textFor(previewIndex) : "",
              size,
              color: [0, 0, 0],
              opacity: 1,
              rotation: 0,
              position,
              under: false,
            }}
          />
          <p className="hint">{t.watermark.undoNote}</p>
        </div>
      </div>
    </Modal>
  );
}
