import type { DocInfo } from "./engine/types";

/** A document open in a tab. */
export interface OpenDoc {
  info: DocInfo;
  name: string;
  /** Path of the file on disk (desktop only) – where it gets saved */
  path?: string;
  /** Default folder for the Save as / Export dialogs */
  dir?: string;
  /** The document has unsaved changes */
  dirty: boolean;
  /** Something was blacked out since the last save (saving asks first) */
  redacted?: boolean;
}

/** A tab either shows a document or the start page (doc = null). */
export interface Tab {
  id: number;
  doc: OpenDoc | null;
}

export interface TabsState {
  tabs: Tab[];
  activeId: number;
}

let nextTabId = 1;

export function createTab(doc: OpenDoc | null = null): Tab {
  return { id: nextTabId++, doc };
}

/** Puts a document into the active tab when it is the empty start page, otherwise into a new tab after it. */
export function placeDoc(s: TabsState, doc: OpenDoc): [TabsState, number] {
  const active = s.tabs.find((x) => x.id === s.activeId);
  if (active && !active.doc) {
    return [{ ...s, tabs: s.tabs.map((x) => (x.id === active.id ? { ...x, doc } : x)) }, active.id];
  }
  const tab = createTab(doc);
  const i = s.tabs.findIndex((x) => x.id === s.activeId);
  return [{ activeId: tab.id, tabs: [...s.tabs.slice(0, i + 1), tab, ...s.tabs.slice(i + 1)] }, tab.id];
}

export function setTabDoc(s: TabsState, id: number, update: (doc: OpenDoc) => OpenDoc): TabsState {
  return { ...s, tabs: s.tabs.map((x) => (x.id === id && x.doc ? { ...x, doc: update(x.doc) } : x)) };
}

/** Removes a tab; the tab to its right (or the last one) becomes active. Never leaves zero tabs. */
export function removeTab(s: TabsState, id: number): TabsState {
  const i = s.tabs.findIndex((x) => x.id === id);
  if (i < 0) return s;
  let tabs = s.tabs.filter((x) => x.id !== id);
  if (!tabs.length) tabs = [createTab()];
  const activeId = s.activeId === id ? tabs[Math.min(i, tabs.length - 1)].id : s.activeId;
  return { tabs, activeId };
}

/** Activates the next (dir = 1) or previous (dir = -1) tab, wrapping around. */
export function cycleTab(s: TabsState, dir: 1 | -1): TabsState {
  if (s.tabs.length < 2) return s;
  const i = s.tabs.findIndex((x) => x.id === s.activeId);
  const next = s.tabs[(i + dir + s.tabs.length) % s.tabs.length];
  return { ...s, activeId: next.id };
}

/** Activates an existing start page tab, or adds one at the end. */
export function startTab(s: TabsState): TabsState {
  const empty = s.tabs.find((x) => !x.doc);
  if (empty) return { ...s, activeId: empty.id };
  const tab = createTab();
  return { tabs: [...s.tabs, tab], activeId: tab.id };
}
