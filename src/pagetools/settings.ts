/** Remembered dialog settings (this device only) and color helpers of the page tools. */
import type { Color } from "../engine/types";

/** Settings saved under `key`; only values of the same type as in `fallback` are taken. */
export function loadJson<T extends object>(key: string, fallback: T): T {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Record<string, unknown> | null;
    if (!saved || typeof saved !== "object") return fallback;
    const out: Record<string, unknown> = { ...(fallback as Record<string, unknown>) };
    for (const [k, v] of Object.entries(fallback)) {
      if (typeof saved[k] === typeof v) out[k] = saved[k];
    }
    return out as T;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: object) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not critical */
  }
}

/** "#rrggbb" → RGB 0–1 */
export function colorFromHex(hex: string): Color {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/** Millimeters per point */
export const MM_PER_PT = 25.4 / 72;

/** A number typed by the user ("12,5" or "12.5"); NaN when it is not one. */
export function parseNumber(text: string): number {
  const t = text.trim().replace(",", ".");
  return /^-?\d*\.?\d+$/.test(t) ? parseFloat(t) : NaN;
}
