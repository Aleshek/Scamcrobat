/**
 * Where a watermark or page number goes on a page – shared by the engine (stamp.ts)
 * and the preview in the dialogs, so that the preview shows what will be written.
 */
import type { Rect, Stamp } from "./types";

type Matrix = [number, number, number, number, number, number];

/** Distance of page numbers from the edges of the page (half an inch, like headers and footers in Acrobat). */
export const STAMP_MARGIN = 36;
/** Cap height of Helvetica (em): the middle of a watermark is the middle of its capital letters. */
export const CAP_HEIGHT = 0.718;
/** A watermark takes at most this part of the page width and height. */
const WATERMARK_FIT = 0.9;

type Placement = Pick<Stamp, "kind" | "position" | "rotation" | "size">;

/**
 * Font size of the text on a page: a watermark that would not fit (rotated) is made
 * smaller on that page. `em` = width of the text at size 1.
 */
export function stampSize(stamp: Placement, bounds: Rect, em: number): number {
  if (stamp.kind !== "watermark" || em <= 0) return stamp.size;
  const a = (stamp.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(a));
  const sin = Math.abs(Math.sin(a));
  const w = em * cos + CAP_HEIGHT * sin;
  const h = em * sin + CAP_HEIGHT * cos;
  const pw = bounds[2] - bounds[0];
  const ph = bounds[3] - bounds[1];
  return Math.min(stamp.size, (WATERMARK_FIT * pw) / w, (WATERMARK_FIT * ph) / h);
}

/**
 * Text space (y up, origin at the start of the baseline, in points) → page space (as
 * shown, y down) for a text of the given width and size.
 */
export function stampMatrix(stamp: Placement, bounds: Rect, width: number, size: number): Matrix {
  const [x0, y0, x1, y1] = bounds;
  const { position } = stamp;
  if (position === "center") {
    // Rotated counterclockwise about the middle of the text, which sits in the middle of the page.
    const a = (stamp.rotation * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const hw = width / 2;
    const hh = (CAP_HEIGHT * size) / 2;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    return [cos, -sin, -sin, -cos, cx - hw * cos + hh * sin, cy + hw * sin + hh * cos];
  }
  const [vertical, horizontal] = position.split("-");
  const y = vertical === "top" ? y0 + STAMP_MARGIN + CAP_HEIGHT * size : y1 - STAMP_MARGIN;
  const x =
    horizontal === "left" ? x0 + STAMP_MARGIN : horizontal === "right" ? x1 - STAMP_MARGIN - width : (x0 + x1 - width) / 2;
  return [1, 0, 0, -1, x, y];
}
