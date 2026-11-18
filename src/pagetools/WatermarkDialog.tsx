/** Adds a text watermark to pages: text, size, color, opacity, rotation, over or behind the content. */
import { useState } from "react";
import type { PdfEngine } from "../engine/engine";
import type { DocInfo, EditState } from "../engine/types";
import { Modal } from "../components/Modal";
import { PageScopeField, usePageScope } from "../components/PageScope";
import { errorText } from "../errors";
import { useT } from "../i18n";
import { colorFromHex, loadJson, saveJson } from "./settings";
import { StampPreview } from "./StampPreview";

interface Props {
  engine: PdfEngine;
  doc: DocInfo;
  currentPage: number;
  onDone(state: EditState, pages: number): void;
  onClose(): void;
}

interface Settings {
  text: string;
  size: number;
  /** #rrggbb */
  color: string;
  /** Percent */
  opacity: number;
  /** Counterclockwise, degrees */
  rotation: number;
  under: boolean;
}

const KEY = "scamcrobat.watermark";
const SWATCHES = [
  { name: "gray", hex: "#808080" },
  { name: "red", hex: "#d32f2f" },
  { name: "blue", hex: "#1f5fbf" },
  { name: "black", hex: "#000000" },
];
const ROTATIONS = [0, 45, 90, -45];
const MIN_SIZE = 6;
const MAX_SIZE = 400;

export function WatermarkDialog({ engine, doc, currentPage, onDone, onClose }: Props) {
  const t = useT();
  const w = t.watermark;
  const [s, setS] = useState<Settings>(() =>
    loadJson(KEY, { text: w.defaultText, size: 72, color: "#808080", opacity: 30, rotation: 45, under: false }),
  );
  const [sizeText, setSizeText] = useState(String(s.size));
  const scope = usePageScope(doc.pageCount, currentPage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Settings>) => setS((prev) => ({ ...prev, ...patch }));

  const pages = scope.pages;
  const sizeOk = s.size >= MIN_SIZE && s.size <= MAX_SIZE;
  const canApply = !!s.text.trim() && sizeOk && !!pages?.length && !busy;
  const previewPage = pages?.includes(currentPage) ? currentPage : (pages?.[0] ?? currentPage);

  async function apply() {
    if (!canApply || !pages) return;
    saveJson(KEY, s);
    setBusy(true);
    setError(null);
    try {
      const state = await engine.stamp(doc.docId, {
        kind: "watermark",
        texts: pages.map((page) => ({ page, text: s.text })),
        size: s.size,
        color: colorFromHex(s.color),
        opacity: s.opacity / 100,
        rotation: s.rotation,
        position: "center",
        under: s.under,
      });
      onDone(state, pages.length);
    } catch (e) {
      setError(w.failed(errorText(e)));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={w.title}
      onClose={onClose}
      locked={busy}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </button>
          <button className="btn primary" onClick={apply} disabled={!canApply}>
            {w.apply}
          </button>
        </>
      }
    >
      {error && <div className="alert">{error}</div>}
      <div className="stamp-dialog">
        <div className="stamp-fields">
          <fieldset className="field">
            <legend>{w.text}</legend>
            <input
              className="input wide"
              value={s.text}
              maxLength={120}
              onChange={(e) => set({ text: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && void apply()}
              data-autofocus
            />
          </fieldset>

          <div className="field-row">
            <fieldset className="field">
              <legend>{w.size}</legend>
              <input
                className={sizeOk ? "input num-input" : "input num-input invalid"}
                type="number"
                min={MIN_SIZE}
                max={MAX_SIZE}
                value={sizeText}
                onChange={(e) => {
                  setSizeText(e.target.value);
                  const n = parseFloat(e.target.value);
                  set({ size: Number.isFinite(n) ? n : 0 });
                }}
              />
            </fieldset>
            <fieldset className="field grow">
              <legend>{w.opacity}</legend>
              <div className="range-row">
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={s.opacity}
                  onChange={(e) => set({ opacity: Number(e.target.value) })}
                  aria-label={w.opacity}
                />
                <span className="range-value wide">{s.opacity} %</span>
              </div>
            </fieldset>
          </div>
          <p className="hint field-hint">{w.sizeHint}</p>

          <fieldset className="field">
            <legend>{w.color}</legend>
            <div className="swatch-row">
              {SWATCHES.map((c) => (
                <button
                  key={c.name}
                  className={s.color === c.hex ? "ab-swatch active" : "ab-swatch"}
                  style={{ background: c.hex }}
                  title={w.colors[c.name]}
                  aria-label={w.colors[c.name]}
                  aria-pressed={s.color === c.hex}
                  onClick={() => set({ color: c.hex })}
                />
              ))}
              <input
                type="color"
                className="color-input"
                value={s.color}
                title={w.customColor}
                aria-label={w.customColor}
                onChange={(e) => set({ color: e.target.value })}
              />
            </div>
          </fieldset>

          <fieldset className="field">
            <legend>{w.rotation}</legend>
            <div className="segmented">
              {ROTATIONS.map((r) => (
                <button key={r} className={s.rotation === r ? "active" : ""} aria-pressed={s.rotation === r} onClick={() => set({ rotation: r })}>
                  {r}°
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="field">
            <legend>{w.layer}</legend>
            <label className="radio">
              <input type="radio" checked={!s.under} onChange={() => set({ under: false })} />
              {w.over}
            </label>
            <label className="radio">
              <input type="radio" checked={s.under} onChange={() => set({ under: true })} />
              {w.under}
            </label>
            {s.under && <p className="hint">{w.underHint}</p>}
          </fieldset>

          {doc.pageCount > 1 && <PageScopeField state={scope} pageCount={doc.pageCount} currentPage={currentPage} />}
        </div>

        <div className="stamp-side">
          <div className="stamp-side-title">{w.preview}</div>
          <StampPreview
            engine={engine}
            docId={doc.docId}
            page={previewPage}
            info={doc.pages[previewPage]}
            stamp={{
              kind: "watermark",
              text: s.text,
              size: sizeOk ? s.size : MIN_SIZE,
              color: colorFromHex(s.color),
              opacity: s.opacity / 100,
              rotation: s.rotation,
              position: "center",
              under: s.under,
            }}
          />
          <p className="hint">{w.undoNote}</p>
        </div>
      </div>
    </Modal>
  );
}
