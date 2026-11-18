/**
 * Crops pages to the box drawn on a page: the margins it cuts off (editable, in mm) are
 * applied to this page, all pages or a range – each page loses the same strips from its edges.
 */
import { useEffect, useMemo, useState } from "react";
import type { PdfEngine } from "../engine/engine";
import type { DocInfo, EditState, Margins, Rect } from "../engine/types";
import { Modal } from "../components/Modal";
import { PageScopeField, usePageScope } from "../components/PageScope";
import { errorText } from "../errors";
import { useT } from "../i18n";
import { MM_PER_PT, parseNumber } from "./settings";

interface Props {
  engine: PdfEngine;
  doc: DocInfo;
  /** The page the box was drawn on and the box (page coordinates) */
  page: number;
  rect: Rect;
  /** Rotation of the view: the fields are named after the sides as seen */
  rotation: number;
  /** The margins were edited: the box to show on the page */
  onPreview(rect: Rect): void;
  onDone(state: EditState, pages: number): void;
  onClose(): void;
}

const SIDES = ["top", "bottom", "left", "right"] as const;
type Side = (typeof SIDES)[number];
/** The side of the page seen at each side of the window, with the view rotated clockwise */
const SEEN: Record<number, Record<Side, Side>> = {
  0: { top: "top", bottom: "bottom", left: "left", right: "right" },
  90: { top: "left", bottom: "right", left: "bottom", right: "top" },
  180: { top: "bottom", bottom: "top", left: "right", right: "left" },
  270: { top: "right", bottom: "left", left: "top", right: "bottom" },
};
/** The smallest page a crop may leave (points), as in the engine */
const MIN_CROP = 18;

const mm = (pt: number) => String(Math.round(Math.max(0, pt) * MM_PER_PT * 10) / 10).replace(".", ",");

export function CropDialog({ engine, doc, page, rect, rotation, onPreview, onDone, onClose }: Props) {
  const t = useT();
  const c = t.crop;
  const info = doc.pages[page];
  const [text, setText] = useState<Record<Side, string>>(() => ({
    left: mm(rect[0] - info.x0),
    top: mm(rect[1] - info.y0),
    right: mm(info.x0 + info.width - rect[2]),
    bottom: mm(info.y0 + info.height - rect[3]),
  }));
  const scope = usePageScope(doc.pageCount, page, "current");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Margins in points; null when one is not a valid number */
  const margins = useMemo((): Margins | null => {
    const out = {} as Margins;
    for (const side of SIDES) {
      const v = parseNumber(text[side]);
      if (!Number.isFinite(v) || v < 0) return null;
      out[side] = v / MM_PER_PT;
    }
    return out;
  }, [text]);

  const width = margins ? info.width - margins.left - margins.right : 0;
  const height = margins ? info.height - margins.top - margins.bottom : 0;
  const fits = !!margins && width >= MIN_CROP && height >= MIN_CROP;
  const canApply = fits && !!scope.pages?.length && !busy;

  // The box on the page follows the numbers.
  useEffect(() => {
    if (!margins || !fits) return;
    onPreview([
      info.x0 + margins.left,
      info.y0 + margins.top,
      info.x0 + info.width - margins.right,
      info.y0 + info.height - margins.bottom,
    ]);
  }, [margins, fits, info, onPreview]);

  async function apply() {
    if (!canApply || !margins || !scope.pages) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await engine.crop(doc.docId, scope.pages, margins), scope.pages.length);
    } catch (e) {
      setError(c.failed(errorText(e)));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={c.title}
      onClose={onClose}
      locked={busy}
      side
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </button>
          <button className="btn primary" onClick={apply} disabled={!canApply} data-autofocus>
            {c.apply}
          </button>
        </>
      }
    >
      {error && <div className="alert">{error}</div>}
      <fieldset className="field">
        <legend>{c.margins}</legend>
        <div className="margin-grid">
          {SIDES.map((seen) => {
            const side = (SEEN[rotation] ?? SEEN[0])[seen];
            return (
              <label key={seen} className="margin-field">
                <span>{c[seen]}</span>
                <input
                  className={
                    Number.isFinite(parseNumber(text[side])) && parseNumber(text[side]) >= 0 ? "input" : "input invalid"
                  }
                  inputMode="decimal"
                  value={text[side]}
                  onChange={(e) => setText((prev) => ({ ...prev, [side]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && void apply()}
                />
              </label>
            );
          })}
        </div>
        {margins && (
          <p className={fits ? "hint" : "hint error"}>
            {fits
              ? rotation % 180
                ? c.result(mm(height), mm(width))
                : c.result(mm(width), mm(height))
              : t.errors.CROP_TOO_SMALL}
          </p>
        )}
      </fieldset>

      {doc.pageCount > 1 && (
        <PageScopeField
          state={scope}
          pageCount={doc.pageCount}
          currentPage={page}
          currentLabel={t.pageScope.thisPage}
        />
      )}

      <p className="hint">{c.note}</p>
    </Modal>
  );
}
