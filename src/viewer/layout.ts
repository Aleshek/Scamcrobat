import type { PageInfo } from "../engine/types";

export const PAGE_GAP = 14;
export const PAGE_PAD = 20;

/** 100 % v UI = skutečná velikost na monitoru s 96 DPI (stejně jako Acrobat). */
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

/** Pevné kroky zoomu pro tlačítka +/− (v procentech). */
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

export interface Layout {
  scale: number;
  tops: number[];
  lefts: number[];
  widths: number[];
  heights: number[];
  contentWidth: number;
  contentHeight: number;
}

export function computeLayout(pages: PageInfo[], scale: number, viewportWidth: number): Layout {
  let maxW = 0;
  for (const p of pages) maxW = Math.max(maxW, p.width * scale);
  const contentWidth = Math.max(viewportWidth, Math.ceil(maxW + 2 * PAGE_PAD));
  const tops: number[] = [];
  const lefts: number[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  let y = PAGE_PAD;
  for (const p of pages) {
    const w = Math.round(p.width * scale);
    const h = Math.round(p.height * scale);
    tops.push(y);
    lefts.push(Math.round((contentWidth - w) / 2));
    widths.push(w);
    heights.push(h);
    y += h + PAGE_GAP;
  }
  const contentHeight = pages.length ? y - PAGE_GAP + PAGE_PAD : 0;
  return { scale, tops, lefts, widths, heights, contentWidth, contentHeight };
}

/** Index první stránky, jejíž spodní hrana je pod hodnotou y. */
export function pageAtY(layout: Layout, y: number): number {
  const { tops, heights } = layout;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] + heights[mid] + PAGE_GAP < y) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo);
}

export function visibleRange(layout: Layout, top: number, bottom: number): [number, number] {
  const n = layout.tops.length;
  if (!n) return [0, -1];
  const first = pageAtY(layout, top);
  let last = first;
  while (last + 1 < n && layout.tops[last + 1] < bottom) last++;
  return [first, last];
}

/** Měřítko, při kterém se stránky vejdou na šířku / celé do okna. */
export function fitScale(
  pages: PageInfo[],
  mode: "width" | "page",
  viewportWidth: number,
  viewportHeight: number,
  pageIndex: number,
) {
  if (!pages.length) return CSS_PX_PER_PT_AT_100;
  let maxW = 0;
  for (const p of pages) maxW = Math.max(maxW, p.width);
  const byWidth = (viewportWidth - 2 * PAGE_PAD) / maxW;
  if (mode === "width") return clampScale(byWidth);
  const p = pages[Math.min(pageIndex, pages.length - 1)];
  const byHeight = (viewportHeight - 2 * PAGE_PAD) / p.height;
  return clampScale(Math.min(byWidth, byHeight));
}
