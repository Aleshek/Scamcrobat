/** Annotation tools, their colors and settings remembered between sessions. */
import type { Color, MarkupType, Point, Rect } from "../engine/types";

export type Tool = "select" | "highlight" | "underline" | "strikeout" | "note" | "text" | "ink" | "signature";

export const MARKUP: Partial<Record<Tool, MarkupType>> = {
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "StrikeOut",
};

export const isMarkupTool = (tool: Tool) => tool in MARKUP;

/** Tools that place one thing and then return to selecting. */
export const ONE_SHOT: Tool[] = ["note", "text", "signature"];

export const PALETTE: { name: string; color: Color }[] = [
  { name: "yellow", color: [1, 0.83, 0] },
  { name: "green", color: [0.2, 0.75, 0.3] },
  { name: "blue", color: [0.13, 0.42, 0.9] },
  { name: "red", color: [0.88, 0.16, 0.16] },
  { name: "purple", color: [0.55, 0.27, 0.85] },
  { name: "black", color: [0.1, 0.1, 0.12] },
];

const DEFAULT_COLORS: Record<string, string> = {
  highlight: "yellow",
  underline: "blue",
  strikeout: "red",
  note: "yellow",
  text: "black",
  ink: "red",
};

export const INK_WIDTHS = [1, 2.5, 5];
export const TEXT_SIZES = [8, 10, 12, 14, 18, 24, 36];

export interface ToolSettings {
  /** Color name per tool */
  colors: Record<string, string>;
  inkWidth: number;
  textSize: number;
}

const SETTINGS_KEY = "scamcrobat.annotate";

export function loadSettings(): ToolSettings {
  const fallback: ToolSettings = { colors: { ...DEFAULT_COLORS }, inkWidth: INK_WIDTHS[1], textSize: 12 };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<ToolSettings> | null;
    if (!saved) return fallback;
    return {
      colors: { ...fallback.colors, ...saved.colors },
      inkWidth: INK_WIDTHS.includes(saved.inkWidth ?? 0) ? saved.inkWidth! : fallback.inkWidth,
      textSize: TEXT_SIZES.includes(saved.textSize ?? 0) ? saved.textSize! : fallback.textSize,
    };
  } catch {
    return fallback;
  }
}

export function saveSettings(settings: ToolSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* not critical */
  }
}

export function colorOf(name: string | undefined): Color {
  return (PALETTE.find((p) => p.name === name) ?? PALETTE[0]).color;
}

export function cssColor(c: Color | null | undefined, alpha = 1): string {
  if (!c) return `rgba(0, 0, 0, ${alpha})`;
  const [r, g, b] = c.map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 255));
  return alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function sameColor(a: Color | null | undefined, b: Color | null | undefined) {
  if (!a || !b) return false;
  return a.every((v, i) => Math.abs(v - b[i]) < 0.02);
}

/** Line height of text boxes relative to the font size (MuPDF lays FreeText out the same way). */
export const TEXT_LINE_HEIGHT = 1.2;

let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * Rectangle of a text box at the given top left corner that fits the text. The
 * appearance is drawn by MuPDF with Helvetica, which has the same widths as Arial.
 */
export function textBoxRect(at: Point, text: string, size: number): Rect {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  let width = size * 4;
  const lines = text.split("\n");
  if (measureCtx) {
    measureCtx.font = `${size}px Helvetica, Arial, sans-serif`;
    for (const line of lines) width = Math.max(width, measureCtx.measureText(line).width);
  }
  const pad = Math.max(2, size * 0.25);
  return [at[0], at[1], at[0] + width + 2 * pad + 2, at[1] + lines.length * size * TEXT_LINE_HEIGHT + 2 * pad];
}

/** Rectangle of the given size centered at a point. */
export function rectAround([x, y]: Point, width: number, height: number): Rect {
  return [x - width / 2, y - height / 2, x + width / 2, y + height / 2];
}

/** Scales an image of the given aspect ratio into a rectangle and centers it there. */
export function fitInto(r: Rect, aspect: number): Rect {
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  const cx = (r[0] + r[2]) / 2;
  const cy = (r[1] + r[3]) / 2;
  const fw = Math.min(w, h * aspect);
  const fh = fw / aspect;
  return [cx - fw / 2, cy - fh / 2, cx + fw / 2, cy + fh / 2];
}
