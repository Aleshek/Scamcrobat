import type { PageInfo, PageMode } from "../engine/types";

export const PAGE_GAP = 14;
export const PAGE_PAD = 20;
/** Gap between the two pages of a spread */
export const SPREAD_GAP = 6;

/** 100 % in the UI = real size on a 96 DPI screen (same as Acrobat). */
export const CSS_PX_PER_PT_AT_100 = 96 / 72;
export const MIN_SCALE = 0.1 * CSS_PX_PER_PT_AT_100;
export const MAX_SCALE = 8 * CSS_PX_PER_PT_AT_100;

export function clampScale(s: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

export function scaleToPercent(scale: number) {
  return Math.round((scale / CSS_PX_PER_PT_AT_100) * 100);
}

export function percentToScale(percent: number) {
  return clampScale((percent / 100) * CSS_PX_PER_PT_AT_100);
}

/** Fixed zoom steps for the +/− buttons (in percent). */
const ZOOM_STEPS = [10, 25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500, 650, 800];

export function nextZoomStep(scale: number, dir: 1 | -1) {
  const pct = (scale / CSS_PX_PER_PT_AT_100) * 100;
  if (dir > 0) {
    const step = ZOOM_STEPS.find((z) => z > pct + 0.5);
    return percentToScale(step ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  }
  const step = [...ZOOM_STEPS].reverse().find((z) => z < pct - 0.5);
  return percentToScale(step ?? ZOOM_STEPS[0]);
}

/** Rotation of the view (clockwise, 0/90/180/270): the file stays as it is. */
export const normalizeViewRotation = (deg: number) => ((((Math.round(deg / 90) * 90) % 360) + 360) % 360);

/** Pages as shown with the view rotated (width and height swapped at 90° and 270°). */
export function rotatePages(pages: PageInfo[], rotation: number): PageInfo[] {
  if (rotation % 180 === 0) return pages;
  return pages.map((p) => ({ ...p, width: p.height, height: p.width }));
}

/**
 * Rows of pages: one page per row, or two side by side – from the first page, or
 * after a cover page shown on its own (like an open book). [first, last] page indices.
 */
export function spreadRows(count: number, mode: PageMode): [number, number][] {
  const rows: [number, number][] = [];
  if (mode === "single") {
    for (let i = 0; i < count; i++) rows.push([i, i]);
    return rows;
  }
  let i = 0;
  if (mode === "cover" && count > 0) {
    rows.push([0, 0]);
    i = 1;
  }
  for (; i < count; i += 2) rows.push([i, Math.min(i + 1, count - 1)]);
  return rows;
}

/** First page of the row with page `index`. */
export function rowStart(index: number, mode: PageMode): number {
  if (mode === "single" || index <= 0) return Math.max(0, index);
  if (mode === "two") return index - (index % 2);
  return index - ((index - 1) % 2);
}

export interface Row {
  /** Top of the row and its height; in slides (full screen) the whole slide */
  top: number;
  height: number;
  first: number;
  last: number;
}

export interface Layout {
  scale: number;
  tops: number[];
  lefts: number[];
  widths: number[];
  heights: number[];
  rows: Row[];
  /** Row of each page */
  rowOf: number[];
  /** Space after each row */
  gap: number;
  contentWidth: number;
  contentHeight: number;
}

/**
 * Positions of the pages. `pages` are the sizes as shown (rotated view applied).
 * Side by side, the left page of a spread ends and the right one starts at the middle
 * (a cover page is a right page). `slide` (full screen) puts every row in the middle of
 * a slide of that height, so that exactly one is visible at a time.
 */
export function computeLayout(
  pages: PageInfo[],
  scale: number,
  viewportWidth: number,
  mode: PageMode = "single",
  slide = 0,
): Layout {
  let maxW = 0;
  for (const p of pages) maxW = Math.max(maxW, Math.round(p.width * scale));
  const twoUp = mode !== "single";
  const spanW = twoUp ? 2 * maxW + SPREAD_GAP : maxW;
  const contentWidth = Math.max(viewportWidth, Math.ceil(spanW + 2 * PAGE_PAD));
  const middle = Math.round(contentWidth / 2);
  const n = pages.length;
  const tops = new Array<number>(n);
  const lefts = new Array<number>(n);
  const widths = new Array<number>(n);
  const heights = new Array<number>(n);
  const rowOf = new Array<number>(n);
  const rows: Row[] = [];
  const gap = slide ? 0 : PAGE_GAP;
  let y = slide ? 0 : PAGE_PAD;
  for (const [first, last] of spreadRows(n, mode)) {
    let rowH = 0;
    for (let i = first; i <= last; i++) {
      widths[i] = Math.round(pages[i].width * scale);
      heights[i] = Math.round(pages[i].height * scale);
      rowH = Math.max(rowH, heights[i]);
    }
    const height = slide || rowH;
    const r = rows.length;
    for (let i = first; i <= last; i++) {
      tops[i] = y + Math.round((height - heights[i]) / 2);
      rowOf[i] = r;
      if (!twoUp) lefts[i] = Math.round((contentWidth - widths[i]) / 2);
      else if (i === first && !(mode === "cover" && i === 0)) lefts[i] = middle - Math.round(SPREAD_GAP / 2) - widths[i];
      else lefts[i] = middle + SPREAD_GAP - Math.round(SPREAD_GAP / 2);
    }
    rows.push({ top: y, height, first, last });
    y += height + gap;
  }
  const contentHeight = n ? (slide ? y : y - gap + PAGE_PAD) : 0;
  return { scale, tops, lefts, widths, heights, rows, rowOf, gap, contentWidth, contentHeight };
}

/** Index of the first row whose bottom edge (with the gap after it) is below y. */
function rowAtY(layout: Layout, y: number): number {
  const { rows, gap } = layout;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top + rows[mid].height + gap < y) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo);
}

/** The page at height y: the first page of the row there. */
export function pageAtY(layout: Layout, y: number): number {
  if (!layout.rows.length) return 0;
  return layout.rows[rowAtY(layout, y)].first;
}

export function visibleRange(layout: Layout, top: number, bottom: number): [number, number] {
  const { rows } = layout;
  if (!rows.length) return [0, -1];
  const first = rowAtY(layout, top);
  let last = first;
  while (last + 1 < rows.length && rows[last + 1].top < bottom) last++;
  return [rows[first].first, rows[last].last];
}

/**
 * Scale at which the pages fit the window width / fit entirely: the row of `pageIndex`,
 * or every row when it is -1 (full screen: no page may stick out of its slide).
 */
export function fitScale(
  pages: PageInfo[],
  mode: "width" | "page",
  viewportWidth: number,
  viewportHeight: number,
  pageIndex: number,
  pageMode: PageMode = "single",
) {
  if (!pages.length) return CSS_PX_PER_PT_AT_100;
  let maxW = 0;
  for (const p of pages) maxW = Math.max(maxW, p.width);
  const byWidth =
    pageMode === "single"
      ? (viewportWidth - 2 * PAGE_PAD) / maxW
      : (viewportWidth - 2 * PAGE_PAD - SPREAD_GAP - 1) / (2 * maxW); // (-1: both page widths are rounded)
  if (mode === "width") return clampScale(byWidth);
  const index = Math.min(pageIndex, pages.length - 1);
  const first = index < 0 ? 0 : rowStart(index, pageMode);
  const last =
    index < 0
      ? pages.length - 1
      : pageMode === "single" || (pageMode === "cover" && first === 0)
        ? first
        : Math.min(first + 1, pages.length - 1);
  let rowH = 0;
  for (let i = first; i <= last; i++) rowH = Math.max(rowH, pages[i].height);
  const byHeight = (viewportHeight - 2 * PAGE_PAD) / rowH;
  return clampScale(Math.min(byWidth, byHeight));
}

/**
 * A point in an element shown rotated by `rotation` (clockwise, about its top left
 * corner and moved back into its box) → coordinates in the element itself.
 * `rect` = the element's box on screen (its rotated size).
 */
export function unrotatePoint(rect: DOMRect, rotation: number, clientX: number, clientY: number): [number, number] {
  const u = clientX - rect.left;
  const v = clientY - rect.top;
  switch (rotation) {
    case 90:
      return [v, rect.width - u];
    case 180:
      return [rect.width - u, rect.height - v];
    case 270:
      return [rect.height - v, u];
    default:
      return [u, v];
  }
}

/** A movement on screen → the same movement in an element shown rotated by `rotation`. */
export function unrotateDelta(dx: number, dy: number, rotation: number): [number, number] {
  switch (rotation) {
    case 90:
      return [dy, -dx];
    case 180:
      return [-dx, -dy];
    case 270:
      return [-dy, dx];
    default:
      return [dx, dy];
  }
}

/** A point in an element → where it is shown when the element is rotated (`width`/`height` = rotated box). */
export function rotatePoint(x: number, y: number, rotation: number, width: number, height: number): [number, number] {
  switch (rotation) {
    case 90:
      return [width - y, x];
    case 180:
      return [width - x, height - y];
    case 270:
      return [y, height - x];
    default:
      return [x, y];
  }
}

/** CSS transform that rotates an element of the unrotated size into a box of `width` × `height` (rotated). */
export function rotationTransform(rotation: number, width: number, height: number): string | undefined {
  switch (rotation) {
    case 90:
      return `translate(${width}px, 0) rotate(90deg)`;
    case 180:
      return `translate(${width}px, ${height}px) rotate(180deg)`;
    case 270:
      return `translate(0, ${height}px) rotate(270deg)`;
    default:
      return undefined;
  }
}
