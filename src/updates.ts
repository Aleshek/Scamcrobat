/**
 * Desktop: tells the user when a newer version of Scamcrobat is out. At most once a day
 * the app asks GitHub for the number of the latest release – nothing about the user or
 * their documents is sent. It can be turned off on the start page. The web version is
 * always the latest one, so it never asks.
 */
import { useSyncExternalStore } from "react";
import { checkForUpdate, isDesktop } from "./platform";

export interface Update {
  version: string;
  /** The release page on GitHub */
  url: string;
}

interface State {
  enabled: boolean;
  /** When GitHub was last asked (ms) */
  checked: number;
  /** A newer version found by the last check */
  latest: Update | null;
  /** The version the user closed the notice for */
  dismissed: string | null;
}

const KEY = "scamcrobat.updates";
const DAY = 24 * 60 * 60 * 1000;
const DEFAULTS: State = { enabled: true, checked: 0, latest: null, dismissed: null };

let state: State | null = null;
const listeners = new Set<() => void>();

function read(): State {
  if (state) return state;
  try {
    state = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<State>) };
  } catch {
    state = { ...DEFAULTS };
  }
  return state;
}

function write(change: Partial<State>) {
  state = { ...read(), ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* not critical */
  }
  for (const l of listeners) l();
}

/** Asks GitHub, unless it was asked less than a day ago or the check is turned off. */
export async function checkUpdates(): Promise<void> {
  const s = read();
  if (!isDesktop || !s.enabled || Date.now() - s.checked < DAY) return;
  try {
    const found = await checkForUpdate();
    if (!found) return; // offline, GitHub unavailable… try again next time
    write({ checked: Date.now(), latest: found.newer ? { version: found.version, url: found.url } : null });
  } catch (e) {
    console.warn("Update check failed", e);
  }
}

export function setUpdateChecks(enabled: boolean) {
  write(enabled ? { enabled, checked: 0 } : { enabled, latest: null });
  if (enabled) void checkUpdates();
}

export function dismissUpdate(version: string) {
  write({ dismissed: version });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the check is on, and the newer version to tell about (unless closed). */
export function useUpdates(): { enabled: boolean; available: Update | null } {
  const s = useSyncExternalStore(subscribe, read);
  const available = s.enabled && s.latest && s.latest.version !== s.dismissed ? s.latest : null;
  return { enabled: s.enabled, available };
}
