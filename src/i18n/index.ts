/**
 * Localization. English is the source language (en.tsx defines the shape of all
 * messages), other languages implement the same `Messages` type, so a missing or
 * misspelled key is a compile error.
 *
 * Language choice: `?lang=xx` in the URL, then the user's saved choice,
 * then the system / browser language, then English.
 */
import { useSyncExternalStore } from "react";
import { en, type Messages } from "./en";
import { cs } from "./cs";

export type { Messages };
export type Lang = "en" | "cs";

export const LANGUAGES: { code: Lang; name: string }[] = [
  { code: "en", name: "English" },
  { code: "cs", name: "Čeština" },
];

const DICTIONARIES: Record<Lang, Messages> = { en, cs };
const STORAGE_KEY = "scamcrobat.lang";

const isLang = (v: unknown): v is Lang => v === "en" || v === "cs";

function detectLanguage(): Lang {
  try {
    const fromUrl = new URLSearchParams(location.search).get("lang");
    if (isLang(fromUrl)) return fromUrl;
  } catch {
    /* no URL (tests) */
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* storage may be blocked */
  }
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of preferred) {
    const base = tag?.toLowerCase().split("-")[0];
    // Slovak readers understand Czech far better than English.
    if (base === "cs" || base === "sk") return "cs";
    if (base === "en") return "en";
  }
  return "en";
}

let current: Lang = detectLanguage();
const listeners = new Set<() => void>();

function applyLanguage() {
  document.documentElement.lang = current;
  window.scamcrobat?.setLanguage?.(current);
}
applyLanguage();

export function getLang(): Lang {
  return current;
}

/** Current messages – for code outside React components. */
export function msg(): Messages {
  return DICTIONARIES[current];
}

export function setLang(lang: Lang) {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* not critical */
  }
  applyLanguage();
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang);
}

/** Messages in the current language; the component re-renders when the language changes. */
export function useT(): Messages {
  return DICTIONARIES[useLang()];
}
