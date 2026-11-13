/**
 * Recently opened files and the page each was left on (desktop only – the web version
 * cannot reopen a file by its path). Stored in localStorage on this device.
 */
import { useSyncExternalStore } from "react";
import { samePath } from "./platform";

export interface RecentFile {
  path: string;
  name: string;
  /** Page index the document was left on */
  page: number;
  time: number;
}

const KEY = "scamcrobat.recent";
const MAX = 10;

let cache: RecentFile[] | null = null;
const listeners = new Set<() => void>();

function read(): RecentFile[] {
  if (cache) return cache;
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as RecentFile[];
    cache = Array.isArray(list)
      ? list.filter((r) => typeof r?.path === "string" && typeof r.name === "string" && Number.isInteger(r.page))
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(list: RecentFile[]) {
  cache = list.slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* not critical */
  }
  for (const l of listeners) l();
}

export function rememberOpened(path: string, name: string) {
  const list = read();
  const old = list.find((r) => samePath(r.path, path));
  write([{ path, name, page: old?.page ?? 0, time: Date.now() }, ...list.filter((r) => r !== old)]);
}

export function rememberPage(path: string, page: number) {
  const list = read();
  const i = list.findIndex((r) => samePath(r.path, path));
  if (i < 0 || list[i].page === page) return;
  const copy = list.slice();
  copy[i] = { ...copy[i], page };
  write(copy);
}

export function lastPage(path: string): number {
  return read().find((r) => samePath(r.path, path))?.page ?? 0;
}

export function forgetRecent(path: string) {
  write(read().filter((r) => !samePath(r.path, path)));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRecent(): RecentFile[] {
  return useSyncExternalStore(subscribe, read);
}
