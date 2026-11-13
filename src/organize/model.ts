/**
 * Data model of the "Organize pages" mode: a list of pages (where each comes from, how it
 * is rotated) with undo/redo history. The real PDF is only built from it on confirmation.
 */
import type { DocInfo, PageRef } from "../engine/types";

export interface OrgSource {
  docId: number;
  name: string;
  path?: string;
  /** The organizer opened this document (inserted PDF) – it must close it when done. */
  owned: boolean;
}

export interface OrgPage {
  /** Stable key for React and selection */
  key: string;
  docId: number;
  page: number;
  /** Extra rotation compared to the original (cumulative, for a smooth animation) */
  rotate: number;
  width: number;
  height: number;
  label: string;
}

export function pagesFromDoc(info: DocInfo): OrgPage[] {
  return info.pages.map((p, i) => ({
    key: `${info.docId}:${i}`,
    docId: info.docId,
    page: i,
    rotate: 0,
    width: p.width,
    height: p.height,
    label: p.label,
  }));
}

export const toRefs = (pages: OrgPage[]): PageRef[] =>
  pages.map(({ docId, page, rotate }) => ({ docId, page, rotate }));

export const effectiveRotation = (deg: number) => (((deg % 360) + 360) % 360);

// ---------- Edits ----------

export function rotatePages(pages: OrgPage[], keys: Set<string>, delta: number): OrgPage[] {
  return pages.map((p) => (keys.has(p.key) ? { ...p, rotate: p.rotate + delta } : p));
}

export function deletePages(pages: OrgPage[], keys: Set<string>): OrgPage[] {
  return pages.filter((p) => !keys.has(p.key));
}

/** Moves the selected pages to position `index` (index in the original list, the gap before that page). */
export function movePages(pages: OrgPage[], keys: Set<string>, index: number): OrgPage[] {
  const moving = pages.filter((p) => keys.has(p.key));
  const before = pages.slice(0, index).filter((p) => !keys.has(p.key));
  const after = pages.slice(index).filter((p) => !keys.has(p.key));
  return [...before, ...moving, ...after];
}

export function insertPages(pages: OrgPage[], added: OrgPage[], index: number): OrgPage[] {
  return [...pages.slice(0, index), ...added, ...pages.slice(index)];
}

export function samePages(a: OrgPage[], b: OrgPage[]) {
  return (
    a.length === b.length &&
    a.every((p, i) => p.key === b[i].key && effectiveRotation(p.rotate) === effectiveRotation(b[i].rotate))
  );
}

// ---------- History (undo / redo) ----------

export interface History {
  past: OrgPage[][];
  present: OrgPage[];
  future: OrgPage[][];
}

export type HistoryAction =
  | { type: "set"; pages: OrgPage[] }
  | { type: "undo" }
  | { type: "redo" };

const HISTORY_LIMIT = 100;

export function historyReducer(state: History, action: HistoryAction): History {
  switch (action.type) {
    case "set":
      if (samePages(state.present, action.pages)) {
        // Same content (e.g. only a different cumulative rotation) – no new history step.
        return action.pages === state.present ? state : { ...state, present: action.pages };
      }
      return {
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: action.pages,
        future: [],
      };
    case "undo": {
      if (!state.past.length) return state;
      return {
        past: state.past.slice(0, -1),
        present: state.past[state.past.length - 1],
        future: [state.present, ...state.future],
      };
    }
    case "redo": {
      if (!state.future.length) return state;
      return {
        past: [...state.past, state.present],
        present: state.future[0],
        future: state.future.slice(1),
      };
    }
  }
}

// ---------- Splitting ----------

/**
 * Parses page groups for splitting, e.g. "1-3, 4-6, 7-" → [[0,1,2],[3,4,5],[6,…]].
 * Every item separated by a comma or semicolon becomes one output file. Returns null on error.
 */
export function parseRangeGroups(text: string, pageCount: number): number[][] | null {
  const parts = text
    .split(/[,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const groups: number[][] = [];
  for (const part of parts) {
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part);
    let from: number;
    let to: number;
    if (m) {
      from = m[1] ? parseInt(m[1], 10) : 1;
      to = m[2] ? parseInt(m[2], 10) : pageCount;
    } else if (/^\d+$/.test(part)) {
      from = to = parseInt(part, 10);
    } else {
      return null;
    }
    if (from < 1 || to > pageCount || from > to) return null;
    groups.push(Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i));
  }
  return groups;
}

/** Groups of `size` pages. */
export function chunkGroups(pageCount: number, size: number): number[][] {
  const groups: number[][] = [];
  for (let i = 0; i < pageCount; i += size) {
    groups.push(Array.from({ length: Math.min(size, pageCount - i) }, (_, j) => i + j));
  }
  return groups;
}

/**
 * Range description for a file name: [0,1,2] → "1-3", [4] → "5",
 * a non-contiguous selection [1,4,6] → "2-7_<selectionSuffix>".
 */
export function groupLabel(group: number[], selectionSuffix: string): string {
  const first = group[0] + 1;
  const last = group[group.length - 1] + 1;
  const contiguous = group.every((p, i) => i === 0 || p === group[i - 1] + 1);
  if (group.length === 1) return String(first);
  return contiguous ? `${first}-${last}` : `${first}-${last}_${selectionSuffix}`;
}
