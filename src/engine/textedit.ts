/**
 * Correcting existing text line by line (typos, dates, names, amounts).
 *
 * A "line" is a run of text on one baseline as MuPDF's text extraction sees it,
 * split at wide gaps, so every table cell is a line of its own. Correcting it:
 *
 * 1. The glyphs drawn on the page are collected (font, glyph id, character, exact
 *    matrix and color) – this, not the font's own character map, says which glyph
 *    shows which character: embedded subset fonts often have no usable map.
 * 2. The old glyphs of the line are removed with a redaction limited to the line's
 *    baseline band, so lines above and below are never touched, and the whole line is
 *    written again in a new content stream (so it stays one line for search and
 *    copying). The text before the first change keeps its exact positions, the text
 *    after the last change moves by the change in width.
 * 3. Each new character takes the font, size, matrix and color of the character it
 *    replaces. The original font is used again (a new font dictionary pointing to the
 *    font program already in the file); characters it does not contain fall back to
 *    MuPDF's built-in URW fonts, which have the same metrics as Helvetica/Arial, Times
 *    (New Roman) and Courier (New) – sans, serif or mono, bold and italic follow the
 *    original – embedded as subsets of a few kilobytes. Every written font gets a
 *    ToUnicode map, so the corrected text can be searched and copied.
 *
 * The removed text stays recoverable in the original bytes of the file, so after a
 * correction the document must be saved as a full rewrite (see snapshot()).
 */
import * as mupdf from "mupdf";
import { CodedError } from "./coded";
import type { Color, Point, Quad, Rect, TextLine } from "./types";

type Matrix = [number, number, number, number, number, number];

/** A glyph drawn on the page. */
interface Glyph {
  font: mupdf.Font;
  gid: number;
  uni: string;
  /** Glyph space (1 unit = 1 em) → page space */
  trm: Matrix;
  /** How many characters the glyph stands for (ligatures such as "fi" are more than 1) */
  chars: number;
  /** Drawn invisibly (text render mode 3, e.g. the text layer of a scan) */
  invisible: boolean;
}

/** A character of a line, as text extraction reports it, with the glyph that draws it. */
interface Char {
  c: string;
  origin: Point;
  quad: Quad;
  size: number;
  color: Color;
  font: mupdf.Font;
  glyph?: Glyph;
  /** How many characters the glyph draws (more than 1 for ligatures) */
  span: number;
  /** Part of a ligature that starts at an earlier character */
  cont: boolean;
}

interface Segment {
  chars: Char[];
  /** Unit vector of the writing direction (page space) */
  dir: Point;
  text: string;
  bbox: Rect;
}

/** Gap between words (in multiples of the font size) that splits a line into separate pieces. */
const SPLIT_GAP = 1.5;
/** Band around the baseline whose glyphs are removed (multiples of the font size). */
const BAND_ABOVE = 0.6;
const BAND_BELOW = 0.15;

const isSpace = (c: string) => c === " " || c === " " || c === "\t";

// ---------- Reading the page ----------

function collectGlyphs(list: mupdf.DisplayList): Glyph[] {
  const glyphs: Glyph[] = [];
  const collect = (text: mupdf.Text, ctm: mupdf.Matrix, invisible: boolean) => {
    let prev: Glyph | null = null;
    text.walk({
      beginSpan() {
        prev = null;
      },
      showGlyph(font, trm, gid, uni) {
        // -1 = the rest of a ligature drawn by the previous glyph
        if (gid < 0) {
          if (prev) prev.chars++;
          return;
        }
        const g: Glyph = {
          font,
          gid,
          uni: String.fromCodePoint(uni),
          trm: mupdf.Matrix.concat(trm, ctm) as Matrix,
          chars: 1,
          invisible,
        };
        glyphs.push(g);
        prev = g;
      },
    });
  };
  const device = new mupdf.Device({
    fillText: (text, ctm) => collect(text, ctm, false),
    strokeText: (text, _stroke, ctm) => collect(text, ctm, false),
    ignoreText: (text, ctm) => collect(text, ctm, true),
  });
  try {
    list.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
  }
  return glyphs;
}

const glyphKey = (font: mupdf.Font, x: number, y: number) =>
  `${font.pointer}|${Math.round(x * 10)}|${Math.round(y * 10)}`;

function readSegments(list: mupdf.DisplayList, glyphs: Glyph[] | null): Segment[] {
  const index = new Map<string, Glyph>();
  if (glyphs) {
    for (const g of glyphs) {
      const at = glyphKey(g.font, g.trm[4], g.trm[5]);
      if (!index.has(`${at}|${g.uni}`)) index.set(`${at}|${g.uni}`, g);
      if (!index.has(at)) index.set(at, g);
    }
  }
  /**
   * Finds the glyph drawing each character: the same font, position and character – or
   * just the same position, when the text comes from elsewhere (ActualText, e.g.
   * ligatures written by Chrome, whose glyph reports "ﬃ" for the characters "ffi").
   */
  const matchGlyphs = (chars: Char[]) => {
    const used = new Set<Glyph>();
    const keys = chars.map((ch) => glyphKey(ch.font, ch.origin[0], ch.origin[1]));
    chars.forEach((ch, i) => {
      ch.glyph = index.get(`${keys[i]}|${ch.c}`);
      if (ch.glyph) used.add(ch.glyph);
    });
    chars.forEach((ch, i) => {
      const g = ch.glyph ? undefined : index.get(keys[i]);
      if (g && !used.has(g)) {
        ch.glyph = g;
        used.add(g);
      }
    });
  };
  const segments: Segment[] = [];
  const stext = list.toStructuredText("preserve-whitespace");
  try {
    let chars: Char[] = [];
    let dir: Point = [1, 0];
    stext.walk({
      beginLine(_bbox, _wmode, d) {
        chars = [];
        const len = Math.hypot(d[0], d[1]) || 1;
        dir = [d[0] / len, d[1] / len];
      },
      onChar(c, origin, font, size, quad, color) {
        const ch: Char = {
          c,
          origin: [origin[0], origin[1]],
          quad: quad as Quad,
          size,
          color: [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0],
          font,
          span: 1,
          cont: false,
        };
        chars.push(ch);
      },
      endLine() {
        if (glyphs) matchGlyphs(chars);
        // The characters after the first one of a ligature have no glyph of their own
        // (and no width either, when the text comes from ActualText).
        for (let i = 0; i < chars.length; i++) {
          const g = chars[i].glyph;
          if (!g) continue;
          let k = 1;
          while (i + k < chars.length && !chars[i + k].glyph && (k < g.chars || zeroWidth(chars[i + k]))) {
            chars[i + k].cont = true;
            k++;
          }
          chars[i].span = k;
        }
        splitLine(chars, dir, segments);
      },
    });
  } finally {
    stext.destroy();
  }
  return segments;
}

const zeroWidth = (ch: Char) => Math.hypot(ch.quad[2] - ch.quad[0], ch.quad[3] - ch.quad[1]) < 0.01;
const along = (p: Point, dir: Point) => p[0] * dir[0] + p[1] * dir[1];
/** Advance of a character along the writing direction, from its quad. */
const advanceOf = (ch: Char, dir: Point) => (ch.quad[2] - ch.quad[0]) * dir[0] + (ch.quad[3] - ch.quad[1]) * dir[1];

function splitLine(chars: Char[], dir: Point, out: Segment[]) {
  let current: Char[] = [];
  let lastEnd: number | null = null;
  const flush = () => {
    let a = 0;
    let b = current.length;
    while (a < b && isSpace(current[a].c)) a++;
    while (b > a && isSpace(current[b - 1].c)) b--;
    if (b > a) {
      const kept = current.slice(a, b);
      out.push({ chars: kept, dir, text: kept.map((c) => c.c).join(""), bbox: boundsOf(kept) });
    }
    current = [];
    lastEnd = null;
  };
  for (const ch of chars) {
    if (!isSpace(ch.c)) {
      const start = along(ch.origin, dir);
      if (lastEnd !== null && start - lastEnd > SPLIT_GAP * ch.size) flush();
      lastEnd = start + advanceOf(ch, dir);
    }
    current.push(ch);
  }
  flush();
}

function boundsOf(chars: Char[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const ch of chars) {
    const q = ch.quad;
    x0 = Math.min(x0, q[0], q[2], q[4], q[6]);
    y0 = Math.min(y0, q[1], q[3], q[5], q[7]);
    x1 = Math.max(x1, q[0], q[2], q[4], q[6]);
    y1 = Math.max(y1, q[1], q[3], q[5], q[7]);
  }
  return [x0, y0, x1, y1];
}

// ---------- Fonts ----------

type Family = "sans" | "serif" | "mono";

interface FontStyle {
  family: Family;
  bold: boolean;
  italic: boolean;
}

function fontStyle(font: mupdf.Font): FontStyle {
  const name = font.getName().replace(/^[A-Z]{6}\+/, "");
  const mono = /courier|mono|consol|menlo|typewriter|lucida console/i.test(name) || font.isMono();
  const serif =
    !mono &&
    !/sans|gothic|grotesk/i.test(name) &&
    (/serif|times|roman|georgia|garamond|cambria|palatino|bookman|book antiqua|bodoni|century|minion|baskerville|caslon/i.test(
      name,
    ) ||
      font.isSerif());
  return {
    family: mono ? "mono" : serif ? "serif" : "sans",
    bold: /bold|black|heavy|semibold|demi/i.test(name) || font.isBold(),
    italic: /italic|oblique|slanted/i.test(name) || font.isItalic(),
  };
}

const FALLBACK: Record<Family, string[]> = {
  sans: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  serif: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
  mono: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};
const fallbackFonts = new Map<string, mupdf.Font>();
const fallbackPointers = new Set<number>();

/** Built-in font with the same metrics as the original's family (Helvetica = Arial, Times, Courier). */
function fallbackFor(font: mupdf.Font): mupdf.Font {
  const s = fontStyle(font);
  const name = FALLBACK[s.family][(s.bold ? 1 : 0) + (s.italic ? 2 : 0)];
  let f = fallbackFonts.get(name);
  if (!f) {
    f = new mupdf.Font(name);
    fallbackFonts.set(name, f);
    fallbackPointers.add(f.pointer);
  }
  return f;
}

const inkCache = new Map<string, boolean>();

/**
 * Whether a glyph draws anything. Subset fonts often keep the character map of the
 * full font, but the glyphs they do not need are empty.
 */
function hasInk(font: mupdf.Font, gid: number): boolean {
  const key = `${font.pointer}:${gid}`;
  let ink = inkCache.get(key);
  if (ink === undefined) {
    ink = false;
    const text = new mupdf.Text();
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 48, 48], false);
    const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    try {
      text.showGlyph(font, [32, 0, 0, -32, 8, 36], gid, 0);
      pix.clear(255);
      device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1);
      device.close();
      for (const v of pix.getPixels()) {
        if (v < 200) {
          ink = true;
          break;
        }
      }
    } finally {
      device.destroy();
      pix.destroy();
      text.destroy();
    }
    inkCache.set(key, ink);
  }
  return ink;
}

const FONT_FILES = ["FontFile", "FontFile2", "FontFile3"];

/** The font descriptor of a font dictionary (simple or Type 0). */
function descriptorOf(font: mupdf.PDFObject): mupdf.PDFObject | null {
  let dict = font.resolve();
  const descendants = dict.get("DescendantFonts");
  if (descendants.isArray() && descendants.length > 0) dict = descendants.get(0).resolve();
  const descriptor = dict.get("FontDescriptor");
  return descriptor.isDictionary() ? descriptor : null;
}

/** The font program stream of a font dictionary and its key in the font descriptor. */
function fontFileOf(font: mupdf.PDFObject): { descriptor: mupdf.PDFObject; key: string; file: mupdf.PDFObject } | null {
  const descriptor = descriptorOf(font);
  if (!descriptor) return null;
  for (const key of FONT_FILES) {
    const file = descriptor.get(key);
    if (file.isStream()) return { descriptor, key, file };
  }
  return null;
}

/** Font program streams used by a page (its fonts and those of its forms), by decoded length. */
function pageFontFiles(page: mupdf.PDFPage): Map<number, mupdf.PDFObject[]> {
  const out = new Map<number, mupdf.PDFObject[]>();
  const seen = new Set<number>();
  const visit = (resources: mupdf.PDFObject, depth: number) => {
    if (!resources.isDictionary()) return;
    resources.get("Font").forEach((font) => {
      const ff = fontFileOf(font);
      if (!ff || seen.has(ff.file.asIndirect())) return;
      seen.add(ff.file.asIndirect());
      try {
        const length = ff.file.readStream().getLength();
        out.set(length, [...(out.get(length) ?? []), ff.file]);
      } catch {
        /* a broken stream is never reused */
      }
    });
    if (depth < 3) resources.get("XObject").forEach((x) => visit(x.get("Resources"), depth + 1));
  };
  visit(page.getObject().getInheritable("Resources"), 0);
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Fonts written by one correction, embedded through a scratch document. An original
 * font gets a new font dictionary, but keeps pointing to its font program already in
 * the file (when MuPDF hands over the same bytes), so a correction adds only a few
 * hundred bytes. Any other font – a fallback, or an original that is not embedded in
 * the file (e.g. plain Helvetica) – is subset first (only the glyphs used; glyph ids
 * stay the same in these CID fonts): a few kilobytes.
 */
class FontWriter {
  private scratch = new mupdf.PDFDocument();
  private refs = new Map<number, mupdf.PDFObject | null>();
  private used = new Map<number, { font: mupdf.Font; ref: mupdf.PDFObject; gids: Map<number, string> }>();

  /** False when the font cannot be embedded again (e.g. Type 3 fonts). */
  canWrite(font: mupdf.Font): boolean {
    let ref = this.refs.get(font.pointer);
    if (ref === undefined) {
      try {
        ref = this.scratch.addFont(font);
      } catch {
        ref = null;
      }
      this.refs.set(font.pointer, ref);
    }
    return ref !== null;
  }

  use(font: mupdf.Font, gid: number, uni: string) {
    let entry = this.used.get(font.pointer);
    if (!entry) {
      if (!this.canWrite(font)) throw new Error("Font cannot be embedded");
      entry = { font, ref: this.refs.get(font.pointer)!, gids: new Map() };
      this.used.set(font.pointer, entry);
    }
    if (!entry.gids.has(gid)) entry.gids.set(gid, uni);
  }

  /**
   * Copies the used fonts into `pdf`; returns font pointer → font object. `existing` are
   * the font programs of the page (see pageFontFiles) that an original font may reuse.
   */
  finish(pdf: mupdf.PDFDocument, existing: Map<number, mupdf.PDFObject[]>): Map<number, mupdf.PDFObject> {
    const result = new Map<number, mupdf.PDFObject>();
    const graft = pdf.newGraftMap();
    try {
      const copy = (ptr: number, reuse?: { key: string; file: mupdf.PDFObject }) => {
        const entry = this.used.get(ptr)!;
        const ref = graft.graftObject(entry.ref);
        if (reuse) descriptorOf(ref)?.put(reuse.key, reuse.file);
        ref.put("ToUnicode", pdf.addStream(toUnicodeCMap(entry.gids), {}));
        result.set(ptr, ref);
      };
      const subset: number[] = [];
      for (const ptr of this.used.keys()) {
        // The same font program already in the file? Then it is not copied again.
        const ff = fallbackPointers.has(ptr) ? null : fontFileOf(this.used.get(ptr)!.ref);
        if (ff) {
          const bytes = ff.file.readStream().asUint8Array().slice();
          const match = existing.get(bytes.length)?.find((f) => sameBytes(f.readStream().asUint8Array(), bytes));
          if (match) {
            ff.descriptor.delete(ff.key);
            copy(ptr, { key: ff.key, file: match });
            continue;
          }
        }
        subset.push(ptr);
      }
      if (subset.length) {
        const resources: Record<string, mupdf.PDFObject> = {};
        let content = "";
        subset.forEach((ptr, i) => {
          const entry = this.used.get(ptr)!;
          resources[`F${i}`] = entry.ref;
          content += `BT /F${i} 1 Tf ${[...entry.gids.keys()].map((g) => `<${hex4(g)}> Tj`).join(" ")} ET\n`;
        });
        this.scratch.insertPage(-1, this.scratch.addPage([0, 0, 100, 100], 0, { Font: resources }, content));
        this.scratch.subsetFonts();
        for (const ptr of subset) copy(ptr);
      }
    } finally {
      graft.destroy();
    }
    return result;
  }

  destroy() {
    this.scratch.destroy();
  }
}

export const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");

function utf16Hex(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += hex4(s.charCodeAt(i));
  return out;
}

export function toUnicodeCMap(gids: Map<number, string>): string {
  const entries = [...gids].sort((a, b) => a[0] - b[0]);
  let body = "";
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n${chunk.map(([g, u]) => `<${hex4(g)}> <${utf16Hex(u)}>`).join("\n")}\nendbfchar\n`;
  }
  return (
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    body +
    "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
  );
}

// ---------- Choosing glyphs for the new text ----------

interface Placed {
  font: mupdf.Font;
  gid: number;
  uni: string;
  trm: Matrix;
  color: Color;
  invisible: boolean;
}

/** What is known about the fonts of a page: characters → glyph ids actually drawn with them. */
class FontMaps {
  private known = new Map<number, Map<string, number>>();
  private cmapOk = new Map<number, boolean>();

  /** Built from the characters on the page; a ligature is known by all its letters ("fi"). */
  constructor(segments: Segment[]) {
    for (const seg of segments) {
      seg.chars.forEach((ch, i) => {
        const g = ch.glyph;
        if (!g) return;
        const text = seg.chars
          .slice(i, i + ch.span)
          .map((c) => c.c)
          .join("");
        let map = this.known.get(g.font.pointer);
        if (!map) this.known.set(g.font.pointer, (map = new Map()));
        if (!map.has(text)) map.set(text, g.gid);
      });
    }
  }

  /** Glyph id of a character in a font, or -1 when the font is not known to have it. */
  glyph(font: mupdf.Font, c: string): number {
    const known = this.known.get(font.pointer)?.get(c);
    if (known !== undefined) return known;
    // The font's own character map can be trusted only if it agrees with every glyph on the page.
    if (this.trustsCmap(font)) {
      const gid = font.encodeCharacter(c.codePointAt(0)!);
      // (A space cannot be checked that way, so only one drawn on the page is used.)
      if (gid > 0 && !isSpace(c) && hasInk(font, gid)) return gid;
    }
    return -1;
  }

  /** A ligature glyph the font draws on the page for the letters starting at `text[k]`. */
  ligature(font: mupdf.Font, text: string[], k: number): { gid: number; length: number } | null {
    const map = this.known.get(font.pointer);
    if (!map) return null;
    for (let length = 3; length >= 2; length--) {
      if (k + length > text.length) continue;
      const gid = map.get(text.slice(k, k + length).join(""));
      if (gid !== undefined) return { gid, length };
    }
    return null;
  }

  private trustsCmap(font: mupdf.Font): boolean {
    let ok = this.cmapOk.get(font.pointer);
    if (ok === undefined) {
      const pairs = [...(this.known.get(font.pointer) ?? [])].filter(([c]) => [...c].length === 1);
      ok = pairs.length > 0 && pairs.every(([c, gid]) => font.encodeCharacter(c.codePointAt(0)!) === gid);
      this.cmapOk.set(font.pointer, ok);
    }
    return ok;
  }
}

/** Glyph matrix for a character without a glyph of its own (size and direction from the text). */
const plainTrm = (ch: Char, dir: Point): Matrix => [
  ch.size * dir[0],
  ch.size * dir[1],
  ch.size * dir[1],
  -ch.size * dir[0],
  ch.origin[0],
  ch.origin[1],
];

const withOrigin = (m: Matrix, p: Point): Matrix => [m[0], m[1], m[2], m[3], p[0], p[1]];

// ---------- Correcting a line ----------

/** Lines of text on a page, for the line editor. */
export function readTextLines(page: mupdf.PDFPage): TextLine[] {
  const list = page.toDisplayList(false);
  try {
    return readSegments(list, null).map((seg) => {
      const first = seg.chars.find((c) => !isSpace(c.c)) ?? seg.chars[0];
      const style = fontStyle(first.font);
      return {
        bbox: seg.bbox,
        text: seg.text,
        size: Math.max(...seg.chars.map((c) => c.size)),
        family: style.family,
        bold: style.bold,
        italic: style.italic,
        color: first.color,
        horizontal: Math.abs(seg.dir[1]) < 0.02 && seg.dir[0] > 0,
      };
    });
  } finally {
    list.destroy();
  }
}

const near = (a: Rect, b: Rect) => a.every((v, i) => Math.abs(v - b[i]) < 0.5);

/**
 * Replaces the text of a line (identified by its bounding box and text as returned by
 * readTextLines). Returns false when nothing changed.
 */
export function replaceTextLine(
  pdf: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  target: { bbox: Rect; text: string },
  newText: string,
): boolean {
  newText = newText.replace(/[\r\n\t]+/g, " ");
  const list = page.toDisplayList(false);
  const writer = new FontWriter();
  try {
    const segments = readSegments(list, collectGlyphs(list));
    const seg = segments.find((s) => s.text === target.text && near(s.bbox, target.bbox));
    if (!seg) throw new CodedError("The line is no longer on the page", "LINE_CHANGED");
    const { chars, dir } = seg;
    const maps = new FontMaps(segments);

    const oldArr = chars.map((c) => c.c);
    const newArr = Array.from(newText);
    const n = oldArr.length;
    const total = newArr.length;
    let p = 0;
    while (p < n && p < total && oldArr[p] === newArr[p]) p++;
    if (p === n && p === total) return false;
    // A ligature (such as "fi") is either kept whole or written again letter by letter.
    while (p > 0 && chars[p]?.cont) p--;
    let s = 0;
    while (s < n - p && s < total - p && oldArr[n - 1 - s] === newArr[total - 1 - s]) s++;
    while (s > 0 && chars[n - s].cont) s--;

    /** A visible character near `i` to copy the style from (spaces may be synthetic). */
    const styleNear = (i: number): Char => {
      for (let k = Math.min(i, n - 1); k >= 0; k--) if (!isSpace(chars[k].c)) return chars[k];
      for (let k = Math.max(i, 0); k < n; k++) if (!isSpace(chars[k].c)) return chars[k];
      return chars[0];
    };
    const trmOf = (ch: Char) => ch.glyph?.trm ?? plainTrm(ch, dir);

    const placed: Placed[] = [];
    /** Writes a glyph in the style (matrix, color) of `style`; returns its advance. */
    const put = (font: mupdf.Font, gid: number, uni: string, style: Char, at: Point): number => {
      const trm = trmOf(style);
      writer.use(font, gid, uni);
      placed.push({ font, gid, uni, trm: withOrigin(trm, at), color: style.color, invisible: style.glyph?.invisible ?? false });
      return font.advanceGlyph(gid) * Math.hypot(trm[0], trm[1]);
    };
    /** Picks a glyph for character `c` in the style of `style` and writes it; returns its advance. */
    const place = (c: string, style: Char, at: Point): number => {
      const gid = writer.canWrite(style.font) ? maps.glyph(style.font, c) : -1;
      if (gid >= 0) return put(style.font, gid, c, style, at);
      const font = fallbackFor(style.font);
      const fallback = isSpace(c) ? font.encodeCharacter(32) : font.encodeCharacter(c.codePointAt(0)!);
      // A space the original font lacks needs no glyph, only its width.
      if (isSpace(c)) return font.advanceGlyph(fallback) * Math.hypot(trmOf(style)[0], trmOf(style)[1]);
      if (fallback <= 0) throw new CodedError(`No font has the character ${c}`, "GLYPH_MISSING", c);
      return put(font, fallback, c, style, at);
    };

    /**
     * Writes unchanged characters from `j` again, shifted by `d`, with their own glyph
     * when possible (a ligature glyph covers several characters). Returns how many
     * characters were written.
     */
    const keep = (j: number, end: number, d: Point): number => {
      const ch = chars[j];
      const g = ch.glyph;
      const at: Point = [ch.origin[0] + d[0], ch.origin[1] + d[1]];
      if (g && j + ch.span <= end && writer.canWrite(g.font)) {
        const uni = oldArr.slice(j, j + ch.span).join("");
        writer.use(g.font, g.gid, uni);
        placed.push({ font: g.font, gid: g.gid, uni, trm: withOrigin(g.trm, at), color: ch.color, invisible: g.invisible });
        return ch.span;
      }
      if (!isSpace(ch.c) || g) place(ch.c, ch.cont || isSpace(ch.c) ? styleNear(j) : ch, at);
      return 1;
    };

    // The whole line is written again, so that it stays one line for search and copying
    // (new content comes after everything else on the page). The beginning of the line
    // up to the first change stays exactly where it was.
    for (let j = 0; j < p; ) j += keep(j, p, [0, 0]);

    let cursor: Point;
    if (p < n) {
      cursor = chars[p].origin;
    } else {
      const last = chars[n - 1];
      const adv = advanceOf(last, dir);
      cursor = [last.origin[0] + dir[0] * adv, last.origin[1] + dir[1] * adv];
    }

    // The changed middle part: each new character in the style of the one it replaces,
    // with the ligatures ("fi") the font uses elsewhere on the page.
    const replaced = n - s - p;
    const middle = newArr.slice(0, total - s);
    for (let k = p; k < middle.length; ) {
      const style = replaced > 0 ? styleNear(p + Math.min(k - p, replaced - 1)) : styleNear(p - 1);
      const lig = writer.canWrite(style.font) ? maps.ligature(style.font, middle, k) : null;
      let adv: number;
      if (lig) {
        adv = put(style.font, lig.gid, middle.slice(k, k + lig.length).join(""), style, cursor);
        k += lig.length;
      } else {
        adv = place(middle[k], style, cursor);
        k++;
      }
      cursor = [cursor[0] + dir[0] * adv, cursor[1] + dir[1] * adv];
    }

    // The unchanged end of the line keeps its spacing and moves by the change in width.
    if (s > 0) {
      const from = chars[n - s].origin;
      const shift: Point = [cursor[0] - from[0], cursor[1] - from[1]];
      for (let j = n - s; j < n; ) j += keep(j, n, shift);
    }

    // Font programs of the page, read before the old glyphs are removed.
    const fontFiles = pageFontFiles(page);
    removeGlyphs(page, chars, dir);
    writeGlyphs(pdf, page, placed, writer.finish(pdf, fontFiles));
    return true;
  } finally {
    writer.destroy();
    list.destroy();
  }
}

/** Removes the glyphs of the given characters (a redaction limited to their baseline band). */
function removeGlyphs(page: mupdf.PDFPage, chars: Char[], dir: Point) {
  const quads: Quad[] = [];
  const up: Point = [dir[1], -dir[0]];
  for (const ch of chars) {
    if (isSpace(ch.c)) continue;
    const adv = Math.max(advanceOf(ch, dir), ch.size * 0.1);
    const a = ch.origin;
    const b: Point = [a[0] + dir[0] * adv, a[1] + dir[1] * adv];
    const hi = BAND_ABOVE * ch.size;
    const lo = BAND_BELOW * ch.size;
    quads.push([
      a[0] + up[0] * hi, a[1] + up[1] * hi,
      b[0] + up[0] * hi, b[1] + up[1] * hi,
      a[0] - up[0] * lo, a[1] - up[1] * lo,
      b[0] - up[0] * lo, b[1] - up[1] * lo,
    ]);
  }
  if (!quads.length) return;
  const annot = page.createAnnotation("Redact");
  annot.setQuadPoints(quads);
  annot.applyRedaction(
    0,
    mupdf.PDFPage.REDACT_IMAGE_NONE,
    mupdf.PDFPage.REDACT_LINE_ART_NONE,
    mupdf.PDFPage.REDACT_TEXT_REMOVE,
  );
}

export const num = (v: number) => {
  const s = v.toFixed(4);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};

/** Writes glyphs in a new content stream of the page (the existing content is wrapped in q/Q). */
function writeGlyphs(pdf: mupdf.PDFDocument, page: mupdf.PDFPage, placed: Placed[], fonts: Map<number, mupdf.PDFObject>) {
  if (!placed.length) return;
  const pageObj = page.getObject();
  const toUser = mupdf.Matrix.invert(page.getTransform());

  let resources = pageObj.getInheritable("Resources");
  if (!resources.isDictionary()) {
    pageObj.put("Resources", pdf.newDictionary());
    resources = pageObj.get("Resources");
  }
  let fontDict = resources.get("Font");
  if (!fontDict.isDictionary()) {
    resources.put("Font", pdf.newDictionary());
    fontDict = resources.get("Font");
  }
  const names = new Map<number, string>();
  let next = 0;
  for (const [ptr, ref] of fonts) {
    while (!fontDict.get(`ScF${next}`).isNull()) next++;
    const name = `ScF${next++}`;
    fontDict.put(name, ref);
    names.set(ptr, name);
  }

  let out = "q\nBT\n0 Tc 0 Tw 100 Tz 0 Ts\n";
  let font = "";
  let color = "";
  let mode = -1;
  for (const g of placed) {
    const name = names.get(g.font.pointer)!;
    if (name !== font) out += `/${(font = name)} 1 Tf\n`;
    const rgb = g.color.map(num).join(" ");
    if (rgb !== color) out += `${(color = rgb)} rg\n`;
    const m = g.invisible ? 3 : 0;
    if (m !== mode) out += `${(mode = m)} Tr\n`;
    const t = mupdf.Matrix.concat(g.trm, toUser);
    out += `${t.map(num).join(" ")} Tm <${hex4(g.gid)}> Tj\n`;
  }
  out += "ET\nQ\n";

  const contents = pageObj.get("Contents");
  const all = pdf.newArray();
  all.push(pdf.addStream("q\n", {}));
  if (contents.isArray()) contents.forEach((v) => all.push(v));
  else if (!contents.isNull()) all.push(contents);
  all.push(pdf.addStream(`\nQ\n${out}`, {}));
  pageObj.put("Contents", all);
}
