/**
 * Watermarks and page numbers: text written into the content of pages.
 *
 * The text is set in the URW Nimbus Sans built into MuPDF (the same widths as
 * Helvetica/Arial, full Central European coverage), embedded once as a subset of the
 * glyphs used and shared by all pages. Each page gets a content stream of its own,
 * after the existing content (over it) or before it (behind it), marked as a
 * pagination artifact (watermark, header or footer), so screen readers skip it and
 * other editors recognize it. Positions are computed in the page as it is shown (its
 * rotation and crop applied, see stampLayout.ts), so the text stands upright where the
 * user put it.
 */
import * as mupdf from "mupdf";
import { CodedError } from "./coded";
import { stampMatrix, stampSize } from "./stampLayout";
import { hex4, num, toUnicodeCMap } from "./textedit";
import type { Rect, Stamp } from "./types";

/** Glyph ids of a text; `used` collects every glyph with its character (for ToUnicode). */
function encode(font: mupdf.Font, text: string, used: Map<number, string>): number[] {
  const gids: number[] = [];
  for (const c of text) {
    const gid = font.encodeCharacter(c.codePointAt(0)!);
    if (gid <= 0) throw new CodedError(`No font has the character ${c}`, "GLYPH_MISSING", c);
    if (!used.has(gid)) used.set(gid, c);
    gids.push(gid);
  }
  return gids;
}

/**
 * Embeds a subset of a built-in font (only the glyphs used; glyph ids stay the same in
 * these CID fonts) with a ToUnicode map, so the text can be searched and copied.
 */
function embedFont(pdf: mupdf.PDFDocument, font: mupdf.Font, used: Map<number, string>): mupdf.PDFObject {
  const scratch = new mupdf.PDFDocument();
  const graft = pdf.newGraftMap();
  try {
    const ref = scratch.addFont(font);
    const gids = [...used.keys()].sort((a, b) => a - b);
    const content = `BT /F0 1 Tf ${gids.map((g) => `<${hex4(g)}> Tj`).join(" ")} ET\n`;
    scratch.insertPage(-1, scratch.addPage([0, 0, 100, 100], 0, { Font: { F0: ref } }, content));
    scratch.subsetFonts();
    // The character map and the widths of the glyphs used only: an incremental save
    // writes every object that gets copied, needed or not.
    ref.put("ToUnicode", scratch.addStream(toUnicodeCMap(used), {}));
    const widths = scratch.newArray();
    for (const g of gids) {
      widths.push(g);
      const w = scratch.newArray();
      w.push(Math.round(font.advanceGlyph(g) * 1000));
      widths.push(w);
    }
    ref.get("DescendantFonts").get(0).put("W", widths);
    return graft.graftObject(ref);
  } finally {
    graft.destroy();
    scratch.destroy();
  }
}

/** Name of `ref` in a resource dictionary (Font, ExtGState…), adding it under a free name when it is not there. */
function resourceName(
  pdf: mupdf.PDFDocument,
  resources: mupdf.PDFObject,
  kind: string,
  ref: mupdf.PDFObject,
  prefix: string,
): string {
  let dict = resources.get(kind);
  if (!dict.isDictionary()) {
    resources.put(kind, pdf.newDictionary());
    dict = resources.get(kind);
  }
  // Pages often share (inherit) their resources: the font is added there only once.
  const target = ref.asIndirect();
  let found: string | null = null;
  dict.forEach((value, key) => {
    if (found === null && value.isIndirect() && value.asIndirect() === target) found = String(key);
  });
  if (found !== null) return found;
  let i = 0;
  while (!dict.get(`${prefix}${i}`).isNull()) i++;
  dict.put(`${prefix}${i}`, ref);
  return `${prefix}${i}`;
}

/**
 * Adds a content stream to a page: before the existing content (behind it), or after
 * it with the existing content wrapped in q/Q (`open` is a shared "q" stream), so that
 * whatever graphics state it leaves behind does not affect the new text.
 */
function addContent(pdf: mupdf.PDFDocument, pageObj: mupdf.PDFObject, content: string, open: mupdf.PDFObject | null) {
  const contents = pageObj.get("Contents");
  const all = pdf.newArray();
  all.push(open ?? pdf.addStream(content, {}));
  if (contents.isArray()) contents.forEach((v) => all.push(v));
  else if (!contents.isNull()) all.push(contents);
  if (open) all.push(pdf.addStream(`\nQ\n${content}`, {}));
  pageObj.put("Contents", all);
}

/** Writes a watermark or page numbers into the pages (one undo step is up to the caller). */
export function stampPages(pdf: mupdf.PDFDocument, stamp: Stamp) {
  const font = new mupdf.Font(stamp.kind === "watermark" ? "Helvetica-Bold" : "Helvetica");
  try {
    const used = new Map<number, string>();
    const items = stamp.texts
      .map(({ page, text }) => ({ page, gids: encode(font, text.replace(/\s+/g, " ").trim(), used) }))
      .filter((item) => item.gids.length > 0);
    if (!items.length) return;
    const fontRef = embedFont(pdf, font, used);
    const opacity = Math.min(Math.max(stamp.opacity, 0), 1);
    const gsRef = opacity < 1 ? pdf.addObject({ Type: "ExtGState", ca: opacity, CA: opacity }) : null;
    const open = stamp.under ? null : pdf.addStream("q\n", {});
    const subtype = stamp.kind === "watermark" ? "Watermark" : stamp.position.startsWith("top") ? "Header" : "Footer";
    const color = stamp.color.map(num).join(" ");

    for (const item of items) {
      const page = pdf.loadPage(item.page) as mupdf.PDFPage;
      try {
        const pageObj = page.getObject();
        let resources = pageObj.getInheritable("Resources");
        if (!resources.isDictionary()) {
          pageObj.put("Resources", pdf.newDictionary());
          resources = pageObj.get("Resources");
        }
        const fontName = resourceName(pdf, resources, "Font", fontRef, "ScF");
        const gsName = gsRef ? resourceName(pdf, resources, "ExtGState", gsRef, "ScGS") : null;
        const bounds = page.getBounds() as Rect;
        const em = item.gids.reduce((w, g) => w + font.advanceGlyph(g), 0);
        const size = stampSize(stamp, bounds, em);
        const toUser = mupdf.Matrix.invert(page.getTransform());
        const m = mupdf.Matrix.concat(stampMatrix(stamp, bounds, em * size, size), toUser);
        let content = `/Artifact <</Type /Pagination /Subtype /${subtype}>> BDC\nq\n`;
        if (gsName) content += `/${gsName} gs\n`;
        content += `${color} rg\n${m.map(num).join(" ")} cm\n`;
        content += `BT /${fontName} ${num(size)} Tf <${item.gids.map((g) => hex4(g)).join("")}> Tj ET\nQ\nEMC\n`;
        addContent(pdf, pageObj, content, open);
      } finally {
        page.destroy();
      }
    }
  } finally {
    font.destroy();
  }
}
