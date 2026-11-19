/**
 * The PDF engine running in a Web Worker. All work with MuPDF (WASM) happens here
 * so that rendering never blocks the user interface.
 *
 * Errors carry a `code` that the UI translates; the messages are only for logs.
 */
import * as mupdf from "mupdf";
import { CodedError } from "./coded";
import { compressPdf } from "./compress";
import { imagesToPdf } from "./images";
import { stampPages } from "./stamp";
import { readTextLines, replaceTextLine } from "./textedit";
import type {
  AnnotEdit,
  AnnotInfo,
  Color,
  DocInfo,
  DocRights,
  EditState,
  LinkInfo,
  NewAnnot,
  EngineApi,
  EngineMethod,
  EngineRequest,
  EngineResponse,
  Margins,
  OutlineFile,
  OutlineNode,
  PageExtras,
  PageInfo,
  PageMode,
  PageRef,
  Permissions,
  Point,
  Progress,
  Protection,
  Quad,
  RedactArea,
  Rect,
  SearchHit,
  SecurityInfo,
  WidgetInfo,
  WidgetKind,
} from "./types";

interface WorkerScope {
  onmessage: ((e: MessageEvent<EngineRequest>) => void) | null;
  postMessage(message: EngineResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

interface DocEntry {
  doc: mupdf.Document;
  /**
   * File content of the document. Page organizing starts from a clean copy of it.
   * Annotations and form values are edited directly in `doc`; `edited` says that
   * `bytes` are behind and have to be written again (see snapshot).
   */
  bytes: Uint8Array;
  password?: string;
  edited: boolean;
  /**
   * Content was removed (redaction, text correction): the next save must write the
   * whole file again, an incremental save would keep the old content in it.
   */
  rewrite: boolean;
  /** Opened with full rights (not protected, or the permissions password is known) */
  owner: boolean;
  /** The permissions password, when the document is protected and it is known */
  ownerPassword?: string;
  /** Protection to apply at the next save: undefined = keep as it is, null = remove */
  protection?: Protection | null;
}

const docs = new Map<number, DocEntry>();
let nextDocId = 1;

// Small LRU cache of structured text (for selecting text by dragging).
const stextCache = new Map<string, mupdf.StructuredText>();
const STEXT_CACHE_SIZE = 6;

function getEntry(docId: number): DocEntry {
  const entry = docs.get(docId);
  if (!entry) throw new CodedError("Document is not open", "NO_DOC");
  return entry;
}

function getDoc(docId: number): mupdf.Document {
  return getEntry(docId).doc;
}

function getPdf(docId: number): mupdf.PDFDocument {
  const pdf = getDoc(docId).asPDF();
  if (!pdf) throw new CodedError("Only PDF documents can be edited", "NOT_PDF");
  return pdf;
}

/** Opens a document from bytes and checks the password. */
function openBytes(bytes: Uint8Array, name: string, password?: string): mupdf.Document {
  const doc = mupdf.Document.openDocument(bytes, name || "application/pdf");
  if (doc.needsPassword()) {
    if (!password) {
      doc.destroy();
      throw new CodedError("Document is password protected", "PASSWORD_REQUIRED");
    }
    if (!doc.authenticatePassword(password)) {
      doc.destroy();
      throw new CodedError("Incorrect password", "PASSWORD_WRONG");
    }
  }
  return doc;
}

const isEncrypted = (doc: mupdf.Document) => (doc.getMetaData("encryption") ?? "None") !== "None";

/**
 * What a password unlocks in a document's bytes: 2 = opening, 4 = full rights.
 * Checked on a separate instance: a wrong password spoils an authenticated document.
 */
function checkPassword(bytes: Uint8Array, password: string): number {
  const probe = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    return probe.authenticatePassword(password);
  } finally {
    probe.destroy();
  }
}

function newEntry(doc: mupdf.Document, bytes: Uint8Array, password?: string, ownerPassword?: string): DocEntry {
  let owner = true;
  if (doc.asPDF() && isEncrypted(doc)) {
    // Full rights with the password used to open it (or none), or with the one known from before.
    owner = (checkPassword(bytes, password ?? "") & 4) !== 0;
    if (!owner && ownerPassword) owner = (checkPassword(bytes, ownerPassword) & 4) !== 0;
  }
  return {
    doc,
    bytes,
    password,
    edited: false,
    rewrite: false,
    owner,
    ownerPassword: owner ? ownerPassword : undefined,
  };
}

/** Size and label of every page (as shown: rotated and cropped). */
function pageInfos(doc: mupdf.Document): PageInfo[] {
  const pages: PageInfo[] = [];
  const pageCount = doc.countPages();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    const [x0, y0, x1, y1] = page.getBounds();
    let label = String(i + 1);
    try {
      label = page.getLabel() || label;
    } catch {
      /* formats other than PDF have no page labels */
    }
    pages.push({ x0, y0, width: x1 - x0, height: y1 - y0, label });
    page.destroy();
  }
  return pages;
}

/** The page layout a PDF asks for when it opens (/PageLayout in its catalog). */
function pageModeOf(doc: mupdf.Document): PageMode | undefined {
  const pdf = doc.asPDF();
  if (!pdf) return undefined;
  try {
    const layout = pdf.getTrailer().get("Root").get("PageLayout");
    if (!layout.isName()) return undefined;
    const name = layout.asName();
    if (name === "TwoColumnLeft" || name === "TwoPageLeft") return "two";
    if (name === "TwoColumnRight" || name === "TwoPageRight") return "cover";
    if (name === "SinglePage" || name === "OneColumn") return "single";
  } catch {
    /* a broken catalog has no preference */
  }
  return undefined;
}

/** Registers an open document and returns information about it for the UI. */
function registerDoc(doc: mupdf.Document, bytes: Uint8Array, password?: string, ownerPassword?: string): DocInfo {
  const pages = pageInfos(doc);
  let outline: OutlineNode[] = [];
  try {
    outline = convertOutline(doc.loadOutline());
  } catch {
    /* ignore broken bookmarks */
  }
  const title = doc.getMetaData(mupdf.Document.META_INFO_TITLE)?.trim() || null;
  const pageMode = pageModeOf(doc);
  const docId = nextDocId++;
  // Undo and redo of annotation and form edits.
  doc.asPDF()?.enableJournal();
  docs.set(docId, newEntry(doc, bytes, password, ownerPassword));
  return { docId, pageCount: pages.length, pages, title, outline, isPdf: doc.asPDF() !== null, pageMode };
}

/** Base of a new PDF: the preferred document, otherwise the one most pages come from. */
function pickBase(refs: PageRef[], prefer?: number): number {
  if (prefer !== undefined && refs.some((r) => r.docId === prefer)) return prefer;
  const counts = new Map<number, number>();
  for (const r of refs) counts.set(r.docId, (counts.get(r.docId) ?? 0) + 1);
  let baseId = refs[0].docId;
  for (const [id, n] of counts) if (n > counts.get(baseId)!) baseId = id;
  return baseId;
}

const normalizeRotation = (deg: number) => (((Math.round(deg / 90) * 90) % 360) + 360) % 360;

type LinkDest = ReturnType<mupdf.Document["resolveLinkDestination"]>;

interface OutlineDraft {
  title: string;
  uri?: string;
  children: OutlineDraft[];
}

/**
 * The bookmarks of a source document for a composed PDF: pointing to where their pages
 * ended up (with the same view of the page). A bookmark whose page is gone points to
 * its first remaining child, or is left out when nothing remains under it.
 */
function remapOutline(
  src: mupdf.Document,
  dest: mupdf.Document,
  items: ReturnType<mupdf.Document["loadOutline"]>,
  newIndex: (page: number) => number | undefined,
): OutlineDraft[] {
  const out: OutlineDraft[] = [];
  for (const item of items ?? []) {
    const children = remapOutline(src, dest, item.down ?? null, newIndex);
    let uri: string | undefined;
    const uriIn = item.uri ?? "";
    if (uriIn && !uriIn.startsWith("#") && /^\w[\w+.-]*:/.test(uriIn)) {
      uri = uriIn; // a web page or another file
    } else if (typeof item.page === "number" && item.page >= 0) {
      const page = newIndex(item.page);
      if (page !== undefined) {
        let dest0: LinkDest = { type: "Fit", chapter: 0, page, x: NaN, y: NaN, width: NaN, height: NaN, zoom: NaN };
        try {
          if (uriIn) dest0 = { ...src.resolveLinkDestination(uriIn), chapter: 0, page };
        } catch {
          /* keep "fit the page" */
        }
        uri = dest.formatLinkURI(dest0);
      }
    }
    uri ??= firstUri(children);
    if (uri || children.length) out.push({ title: item.title ?? "", uri, children });
  }
  return out;
}

const firstUri = (items: OutlineDraft[]): string | undefined => {
  for (const item of items) {
    const uri = item.uri ?? firstUri(item.children);
    if (uri) return uri;
  }
  return undefined;
};

/** Inserts bookmarks at the position of the iterator (they come before what is there). */
function writeOutline(it: mupdf.OutlineIterator, items: OutlineDraft[]) {
  for (const item of items) {
    it.insert({ title: item.title, uri: item.uri, open: false });
    if (!item.children.length) continue;
    it.prev(); // the bookmark just inserted
    it.down();
    writeOutline(it, item.children);
    it.up();
    it.next();
  }
}

/**
 * Bookmarks of a composed PDF: each of `files` gets a top-level bookmark named after
 * it, pointing to its first page, with its own bookmarks under it (in the order in
 * which the files come in the document). The base document keeps its bookmarks as
 * they are, unless it is one of `files` itself.
 */
function mergeOutlines(base: mupdf.PDFDocument, baseId: number, refs: PageRef[], files: OutlineFile[]) {
  const first = new Map<string, number>();
  refs.forEach((r, i) => {
    const key = `${r.docId}:${r.page}`;
    if (!first.has(key)) first.set(key, i);
  });
  const firstPage = (docId: number) => refs.findIndex((r) => r.docId === docId);
  const ordered = files.filter((f) => firstPage(f.docId) >= 0).sort((a, b) => firstPage(a.docId) - firstPage(b.docId));
  if (!ordered.length) return;

  const drafts = ordered.map((f): OutlineDraft => {
    const src = getDoc(f.docId);
    let children: OutlineDraft[] = [];
    try {
      children = remapOutline(src, base, src.loadOutline(), (page) => first.get(`${f.docId}:${page}`));
    } catch {
      /* broken bookmarks are left out */
    }
    const uri = base.formatLinkURI({
      type: "Fit",
      chapter: 0,
      page: firstPage(f.docId),
      x: NaN,
      y: NaN,
      width: NaN,
      height: NaN,
      zoom: NaN,
    });
    return { title: f.title, uri, children };
  });

  // The base document's own bookmarks go under its file name, too.
  if (ordered.some((f) => f.docId === baseId)) base.getTrailer().get("Root").delete("Outlines");
  const it = base.outlineIterator();
  try {
    while (it.next() === mupdf.OutlineIterator.ITERATOR_AT_ITEM) {
      /* to the end of the top level */
    }
    writeOutline(it, drafts);
  } finally {
    it.destroy();
  }
}

/**
 * Builds a new PDF from the given pages (order, rotation, pages from several files).
 *
 * It starts from a fresh copy of the main document (see pickBase), so its bookmarks,
 * metadata, forms and links are kept. Pages from other files are grafted into it
 * and finally everything is rearranged into the requested order. The bookmarks of
 * `files` are added under a bookmark named after each (see mergeOutlines).
 */
function buildPdf(refs: PageRef[], prefer?: number, files?: OutlineFile[]): Uint8Array {
  if (!refs.length) throw new CodedError("Document must have at least one page", "EMPTY");

  const baseId = pickBase(refs, prefer);
  getPdf(baseId); // make sure it is a PDF
  // Pages of a document with restrictions may be organized only when its author allows
  // it; taking them into another document is copying, too.
  for (const docId of new Set(refs.map((r) => r.docId))) {
    requireRight(docId, "assemble");
    if (docId !== baseId) requireRight(docId, "copy");
  }
  const base = openBytes(snapshot(baseId), "application/pdf", getEntry(baseId).password).asPDF()!;
  const graftMaps = new Map<number, mupdf.PDFGraftMap>();
  try {
    const baseCount = base.countPages();
    const indexOf = new Map<string, number>();
    for (let i = 0; i < baseCount; i++) indexOf.set(`${baseId}:${i}`, i);

    let next = baseCount;
    for (const r of refs) {
      const key = `${r.docId}:${r.page}`;
      if (indexOf.has(key)) continue;
      let map = graftMaps.get(r.docId);
      if (!map) {
        map = base.newGraftMap();
        graftMaps.set(r.docId, map);
      }
      map.graftPage(-1, getPdf(r.docId), r.page);
      indexOf.set(key, next++);
    }

    base.rearrangePages(refs.map((r) => indexOf.get(`${r.docId}:${r.page}`)!));

    refs.forEach((r, i) => {
      const extra = normalizeRotation(r.rotate);
      if (!extra) return;
      const page = base.loadPage(i) as mupdf.PDFPage;
      try {
        const obj = page.getObject();
        const current = obj.getInheritable("Rotate");
        const was = current.isNumber() ? current.asNumber() : 0;
        obj.put("Rotate", normalizeRotation(was + extra));
      } finally {
        page.destroy();
      }
    });

    if (files?.length) mergeOutlines(base, baseId, refs, files);

    return base.saveToBuffer("garbage=deduplicate,compress").asUint8Array().slice();
  } finally {
    for (const map of graftMaps.values()) map.destroy();
    base.destroy();
  }
}

// Permission bits of the PDF standard security handler (the P value is signed).
const P_BASE = -3904; // reserved bits set, every permission cleared
const P_PRINT = 4 | 2048; // print, print in high quality
const P_COPY = 16;
const P_EDIT = 8 | 32 | 256 | 1024; // modify, annotate, fill forms, assemble pages
const P_ACCESSIBILITY = 512; // text for screen readers stays allowed

function permissionBits(p: Permissions): number {
  return P_BASE | P_ACCESSIBILITY | (p.print ? P_PRINT : 0) | (p.copy ? P_COPY : 0) | (p.edit ? P_EDIT : 0);
}

/** Save options that apply new protection (AES-256), or remove it (null). */
function protectionOptions(p: Protection | null): Record<string, unknown> {
  if (!p) return { encrypt: "none" };
  const restricted = p.permissionsPassword !== "";
  return {
    encrypt: "aes-256",
    "user-password": p.openPassword,
    // Without restrictions the open password gives full rights (an empty owner password
    // would let anyone open the document).
    "owner-password": restricted ? p.permissionsPassword : p.openPassword,
    permissions: restricted ? permissionBits(p.permissions) : -4,
  };
}

/**
 * Up to date content of a document: when annotations or form fields were edited,
 * writes the document again. Saving appends the changes to the original file
 * (incremental save) when possible, so digital signatures stay valid. After a
 * redaction, a text correction or a change of the protection, the whole file is
 * written again instead, garbage collected, so that nothing removed stays in it.
 * The document is then reopened from the new content, so the next save appends to
 * it (MuPDF would otherwise append only the changes made since the previous save).
 */
function snapshot(docId: number): Uint8Array {
  const entry = getEntry(docId);
  if (!entry.edited) return entry.bytes;
  const pdf = entry.doc.asPDF()!;
  let options: string;
  let password = entry.password;
  let ownerPassword = entry.ownerPassword;
  if (entry.protection !== undefined) {
    const p = entry.protection;
    // (JSON, as passwords may contain commas)
    options = JSON.stringify({ ...protectionOptions(p), garbage: "deduplicate", compress: true });
    password = p?.openPassword || undefined;
    ownerPassword = p ? p.permissionsPassword || p.openPassword : undefined;
  } else if (entry.rewrite || !pdf.canBeSavedIncrementally()) {
    options = "garbage=deduplicate,compress";
  } else {
    options = "incremental,compress";
  }
  const bytes = pdf.saveToBuffer(options).asUint8Array().slice();
  const fresh = openBytes(bytes, "application/pdf", password);
  fresh.asPDF()?.enableJournal();
  dropStextFor(docId);
  entry.doc.destroy();
  docs.set(docId, newEntry(fresh, bytes, password, ownerPassword));
  return bytes;
}

const ALL_RIGHTS: DocRights = { print: true, copy: true, modify: true, annotate: true, fillForms: true, assemble: true };

/**
 * Rights given by the P value of the standard security handler. Since revision 3,
 * filling in forms (bit 9) and assembling pages (bit 11) have bits of their own,
 * the way Acrobat and qpdf read them.
 */
function rightsOf(bits: number, revision: number): DocRights {
  const has = (bit: number) => (bits & bit) !== 0;
  const modern = revision >= 3;
  return {
    print: has(4),
    copy: has(16),
    modify: has(8),
    annotate: has(32),
    fillForms: has(32) || (modern && has(256)),
    assemble: modern ? has(1024) : has(8),
  };
}

function securityOf(entry: DocEntry): SecurityInfo {
  const pdf = entry.doc.asPDF();
  const all: Permissions = { print: true, copy: true, edit: true };
  if (!pdf || !isEncrypted(entry.doc)) {
    return {
      method: null,
      openPassword: false,
      permissions: all,
      rights: ALL_RIGHTS,
      canChange: !!pdf,
      pending: entry.protection,
    };
  }
  const info = entry.doc.getMetaData("encryption") ?? "";
  const m = /(\d+)-bit (\w+)/.exec(info);
  const encrypt = pdf.getTrailer().get("Encrypt");
  const p = encrypt.get("P");
  const r = encrypt.get("R");
  const bits = p.isNumber() ? p.asNumber() : -1;
  const restricted = { print: (bits & 4) !== 0, copy: (bits & 16) !== 0, edit: (bits & 8) !== 0 };
  return {
    method: m ? `${m[2]} ${m[1]}-bit` : info,
    openPassword: !!entry.password,
    permissions: restricted,
    rights: entry.owner ? ALL_RIGHTS : rightsOf(bits, r.isNumber() ? r.asNumber() : 2),
    canChange: entry.owner,
    pending: entry.protection,
  };
}

/** Refuses an action the restrictions of the document do not allow. */
function requireRight(docId: number, right: keyof DocRights) {
  if (!securityOf(getEntry(docId)).rights[right]) {
    throw new CodedError(`Not allowed by the document's restrictions: ${right}`, "NOT_ALLOWED");
  }
}

/** A character of the page text and its quad. */
interface TextChar {
  c: string;
  quad: Quad;
}

const charLines = new WeakMap<mupdf.StructuredText, TextChar[][]>();

/** The characters of a page, line by line. */
function linesOf(stext: mupdf.StructuredText): TextChar[][] {
  let lines = charLines.get(stext);
  if (lines) return lines;
  lines = [];
  let line: TextChar[] | null = null;
  stext.walk({
    beginLine() {
      line = [];
      lines!.push(line);
    },
    onChar(c, _origin, _font, _size, quad) {
      line?.push({ c, quad: quad as Quad });
    },
    endLine() {
      line = null;
    },
  });
  charLines.set(stext, lines);
  return lines;
}

/** A point `t` of the way along a character in the reading direction (0 = its start, 1 = its end). */
function alongChar(q: Quad, t: number): Point {
  const left: Point = [(q[0] + q[4]) / 2, (q[1] + q[5]) / 2];
  const right: Point = [(q[2] + q[6]) / 2, (q[3] + q[7]) / 2];
  return [left[0] + (right[0] - left[0]) * t, left[1] + (right[1] - left[1]) * t];
}

/**
 * The character nearest to a point on the line the point is on (or less than a line
 * height away from it); measured along the line and across it, so it works for text
 * in any direction.
 */
function charNear(lines: TextChar[][], p: Point): [number, number] | null {
  let best: [number, number] | null = null;
  let bestDist = Infinity;
  lines.forEach((line, li) =>
    line.forEach((ch, ci) => {
      const q = ch.quad;
      const [lx, ly] = alongChar(q, 0);
      const [rx, ry] = alongChar(q, 1);
      const width = Math.hypot(rx - lx, ry - ly);
      const height = Math.hypot(q[4] - q[0], q[5] - q[1]) || 1;
      const [ux, uy] = width ? [(rx - lx) / width, (ry - ly) / width] : [1, 0];
      const cx = p[0] - (lx + rx) / 2;
      const cy = p[1] - (ly + ry) / 2;
      const along = Math.max(Math.abs(cx * ux + cy * uy) - width / 2, 0);
      const across = Math.max(Math.abs(cy * ux - cx * uy) - height / 2, 0);
      if (across > height) return; // not on this line
      const dist = along + across * 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = [li, ci];
      }
    }),
  );
  return best;
}

/** First and last character of the word at `i` (spaces and wide gaps end a word). */
function wordAround(line: TextChar[], i: number): [number, number] {
  const space = (ch: TextChar) => /\s/.test(ch.c);
  if (space(line[i])) return [i, i];
  const gap = (a: TextChar, b: TextChar) => {
    const end = alongChar(a.quad, 1);
    const start = alongChar(b.quad, 0);
    const height = Math.hypot(a.quad[4] - a.quad[0], a.quad[5] - a.quad[1]);
    return Math.hypot(start[0] - end[0], start[1] - end[1]) > height * 0.25;
  };
  let first = i;
  let last = i;
  while (first > 0 && !space(line[first - 1]) && !gap(line[first - 1], line[first])) first--;
  while (last < line.length - 1 && !space(line[last + 1]) && !gap(line[last], line[last + 1])) last++;
  return [first, last];
}

/**
 * Selection by words (double click, then dragging): points just inside the first and
 * the last character, from the word under `from` to the word under `to`.
 *
 * Not `stext.snap()`: MuPDF snaps a point on the end of the last word of a line to the
 * first word of the next line, and where words are separated by gaps rather than space
 * characters it takes the whole line for one word.
 */
function wordSelection(stext: mupdf.StructuredText, from: Point, to: Point): [Point, Point] | null {
  const lines = linesOf(stext);
  const a = charNear(lines, from);
  const b = charNear(lines, to) ?? a;
  if (!a || !b) return null;
  const [start, end] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
  const first = wordAround(lines[start[0]], start[1])[0];
  const last = wordAround(lines[end[0]], end[1])[1];
  return [alongChar(lines[start[0]][first].quad, 0.25), alongChar(lines[end[0]][last].quad, 0.75)];
}

function getStext(docId: number, pageIndex: number): mupdf.StructuredText {
  const key = `${docId}:${pageIndex}`;
  let stext = stextCache.get(key);
  if (stext) {
    stextCache.delete(key);
    stextCache.set(key, stext);
    return stext;
  }
  const page = getDoc(docId).loadPage(pageIndex);
  try {
    stext = page.toStructuredText("preserve-whitespace");
  } finally {
    page.destroy();
  }
  stextCache.set(key, stext);
  while (stextCache.size > STEXT_CACHE_SIZE) {
    const [oldKey, old] = stextCache.entries().next().value!;
    old.destroy();
    stextCache.delete(oldKey);
  }
  return stext;
}

function dropStextFor(docId: number) {
  for (const [key, stext] of stextCache) {
    if (key.startsWith(`${docId}:`)) {
      stext.destroy();
      stextCache.delete(key);
    }
  }
}

function convertOutline(items: ReturnType<mupdf.Document["loadOutline"]>): OutlineNode[] {
  if (!items) return [];
  return items.map((item) => ({
    title: item.title ?? "",
    page: typeof item.page === "number" && item.page >= 0 ? item.page : null,
    children: convertOutline(item.down ?? null),
  }));
}

/**
 * Finds all occurrences of `needle` on a page, like browsers do: "Crows" matches
 * "crows", "zlutoucky" matches "žluťoučký".
 *
 * Not `page.search()`: MuPDF 1.28's text extraction expands presentation forms
 * (U+FB00–U+FDFF, U+FE70–U+FEFC) itself and, for code points that have no
 * decomposition – e.g. U+FD3E/U+FD3F, which Word's ToUnicode uses for "(" and ")"
 * in Segoe UI – stores an uninitialised value instead. It is often 0, depending on
 * what ran before (rendering any page makes it likely), and the search treats the
 * page text as a C string, so everything after that 0 becomes unsearchable.
 * "preserve-ligatures" skips that code; the search itself still folds ligatures
 * (ignore-diacritics implies compatibility decomposition), so "fi" matches "ﬁ".
 * Fixed upstream after MuPDF 1.28.6.
 */
function searchPage(page: mupdf.Page, needle: string): Quad[][] {
  const stext = page.toStructuredText("dehyphenate,preserve-ligatures");
  try {
    return stext.search(needle, "ignore-case,ignore-diacritics") as Quad[][];
  } finally {
    stext.destroy();
  }
}

/** Drops repeated quads – each character of a ligature maps to the whole glyph. */
function uniqueQuads(quads: Quad[]): Quad[] {
  const seen = new Set<string>();
  return quads.filter((quad) => {
    const key = quad.join();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Renders a page into an RGB pixmap at the given scale (1 = 72 DPI). */
function renderPixmap(docId: number, pageIndex: number, scale: number): mupdf.Pixmap {
  const page = getDoc(docId).loadPage(pageIndex);
  try {
    return page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  } finally {
    page.destroy();
  }
}

/** Converts an RGB pixmap to ImageData (RGBA). */
function pixmapToImageData(pix: mupdf.Pixmap): ImageData {
  const w = pix.getWidth();
  const h = pix.getHeight();
  const n = pix.getNumberOfComponents();
  const stride = pix.getStride();
  const src = pix.getPixels();
  const out = new Uint8ClampedArray(w * h * 4);
  if (n === 4) {
    for (let y = 0; y < h; y++) out.set(src.subarray(y * stride, y * stride + w * 4), y * w * 4);
    return new ImageData(out, w, h);
  }
  let o = 0;
  for (let y = 0; y < h; y++) {
    let i = y * stride;
    for (let x = 0; x < w; x++) {
      out[o] = src[i];
      out[o + 1] = src[i + 1];
      out[o + 2] = src[i + 2];
      out[o + 3] = 255;
      o += 4;
      i += n;
    }
  }
  return new ImageData(out, w, h);
}

// ---------- Links, form fields and annotations ----------

/** Annotation types the user does not see as annotations. */
const HIDDEN_ANNOTS = new Set(["Link", "Popup", "Widget"]);
const INVISIBLE = mupdf.PDFAnnotation.IS_HIDDEN | mupdf.PDFAnnotation.IS_NO_VIEW;

const toRect = (r: number[]): Rect => [r[0], r[1], r[2], r[3]];

function toColor(c: mupdf.AnnotColor | undefined): Color | null {
  if (!c || !c.length) return null;
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 3) return [c[0], c[1], c[2]];
  const [cy, m, y, k] = c as number[];
  return [(1 - cy) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
}

/** Stable identifier of an annotation: its PDF object number. */
function annotId(a: mupdf.PDFAnnotation, index: number) {
  const num = a.getObject().asIndirect();
  return num > 0 ? num : -(index + 1);
}

function findAnnot(page: mupdf.PDFPage, id: number): mupdf.PDFAnnotation {
  const list = page.getAnnotations();
  for (let i = 0; i < list.length; i++) if (annotId(list[i], i) === id) return list[i];
  throw new CodedError("Annotation not found", "NO_ANNOT");
}

function findWidget(page: mupdf.PDFPage, id: number): mupdf.PDFWidget {
  const list = page.getWidgets();
  for (let i = 0; i < list.length; i++) if (annotId(list[i], i) === id) return list[i];
  throw new CodedError("Form field not found", "NO_ANNOT");
}

function widgetKind(w: mupdf.PDFWidget): WidgetKind {
  switch (w.getFieldType()) {
    case "text":
      return "text";
    case "checkbox":
      return "checkbox";
    case "radiobutton":
      return "radio";
    case "combobox":
      return "combobox";
    case "listbox":
      return "listbox";
    case "signature":
      return "signature";
    default:
      return "button";
  }
}

function readLinks(doc: mupdf.Document, page: mupdf.Page): LinkInfo[] {
  const links: LinkInfo[] = [];
  for (const link of page.getLinks()) {
    const rect = toRect(link.getBounds());
    const uri = link.getURI();
    if (link.isExternal()) {
      if (uri) links.push({ rect, uri });
      continue;
    }
    try {
      const target = doc.resolveLink(uri);
      if (target >= 0) links.push({ rect, page: target });
    } catch {
      /* a link to nowhere */
    }
  }
  return links;
}

function readWidgets(page: mupdf.PDFPage): WidgetInfo[] {
  return page.getWidgets().map((w, i) => {
    const kind = widgetKind(w);
    let fontSize = 0;
    try {
      fontSize = w.getDefaultAppearance().size || 0;
    } catch {
      /* fields without a default appearance */
    }
    const isChoice = kind === "combobox" || kind === "listbox";
    return {
      id: annotId(w, i),
      kind,
      name: w.getLabel() || w.getName(),
      rect: toRect(w.getRect()),
      value: w.getValue() ?? "",
      options: isChoice ? w.getOptions() : undefined,
      multiline: kind === "text" && w.isMultiline(),
      readOnly: w.isReadOnly() || (w.getFlags() & INVISIBLE) !== 0,
      maxLen: kind === "text" ? w.getMaxLen() : 0,
      fontSize,
    };
  });
}

function readAnnots(page: mupdf.PDFPage): AnnotInfo[] {
  const out: AnnotInfo[] = [];
  page.getAnnotations().forEach((a, i) => {
    const type = a.getType();
    if (HIDDEN_ANNOTS.has(type) || a.getFlags() & INVISIBLE) return;
    const info: AnnotInfo = {
      id: annotId(a, i),
      type,
      bounds: toRect(a.getBounds()),
      contents: a.getContents() ?? "",
      color: toColor(a.getColor()),
    };
    if (a.hasRect()) info.rect = toRect(a.getRect());
    if (a.hasQuadPoints()) info.quads = a.getQuadPoints() as Quad[];
    if (a.hasInkList()) {
      info.ink = a.getInkList() as Point[][];
      info.width = a.getBorderWidth();
    }
    if (type === "FreeText") {
      try {
        const da = a.getDefaultAppearance();
        info.fontSize = da.size;
        info.color = toColor(da.color) ?? info.color;
      } catch {
        /* keep defaults */
      }
    }
    out.push(info);
  });
  return out;
}

function createAnnot(page: mupdf.PDFPage, spec: NewAnnot): mupdf.PDFAnnotation {
  const a = page.createAnnotation(spec.type);
  switch (spec.type) {
    case "Highlight":
    case "Underline":
    case "StrikeOut":
      a.setColor(spec.color);
      a.setQuadPoints(spec.quads);
      break;
    case "Ink":
      a.setColor(spec.color);
      a.setBorderWidth(spec.width);
      a.setInkList(spec.strokes);
      break;
    case "FreeText":
      a.setRect(spec.rect);
      a.setDefaultAppearance("Helv", spec.size, spec.color);
      a.setBorderWidth(0);
      a.setContents(spec.text);
      break;
    case "Text":
      a.setRect(spec.rect);
      a.setColor(spec.color);
      a.setContents(spec.text);
      break;
    case "Stamp":
      a.setRect(spec.rect);
      a.setStampImage(new mupdf.Image(spec.image));
      break;
  }
  a.setModificationDate(new Date());
  a.update();
  return a;
}

const shiftRect = (r: number[], dx: number, dy: number): Rect => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
const shiftPoint = (p: number[], dx: number, dy: number): Point => [p[0] + dx, p[1] + dy];

function moveAnnot(a: mupdf.PDFAnnotation, dx: number, dy: number) {
  if (a.hasRect()) a.setRect(shiftRect(a.getRect(), dx, dy));
  if (a.hasInkList()) a.setInkList(a.getInkList().map((s) => s.map((p) => shiftPoint(p, dx, dy))));
  if (a.hasVertices()) a.setVertices(a.getVertices().map((p) => shiftPoint(p, dx, dy)));
  if (a.hasLine()) {
    const [p, q] = a.getLine();
    a.setLine(shiftPoint(p, dx, dy), shiftPoint(q, dx, dy));
  }
  if (a.hasQuadPoints()) {
    a.setQuadPoints(a.getQuadPoints().map((q) => q.map((v, i) => v + (i % 2 ? dy : dx)) as Quad));
  }
}

function applyEdit(page: mupdf.PDFPage, edit: AnnotEdit): number | undefined {
  if (edit.op === "create") {
    const a = createAnnot(page, edit.annot);
    return annotId(a, page.getAnnotations().length - 1);
  }
  const a = findAnnot(page, edit.id);
  switch (edit.op) {
    case "delete":
      page.deleteAnnotation(a);
      return;
    case "move":
      moveAnnot(a, edit.dx, edit.dy);
      break;
    case "setRect":
      a.setRect(edit.rect);
      break;
    case "setContents":
      a.setContents(edit.text);
      if (edit.rect) a.setRect(edit.rect);
      break;
    case "setColor":
      if (a.getType() === "FreeText") {
        const da = a.getDefaultAppearance();
        a.setDefaultAppearance(da.font || "Helv", da.size || 12, edit.color);
      } else {
        a.setColor(edit.color);
      }
      break;
  }
  a.setModificationDate(new Date());
  a.update();
}

const intersects = (a: Rect, b: number[]) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

function quadBounds(q: Quad): Rect {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Blacks out an area: text, images (their pixels) and drawings under it are removed
 * from the page content, and links too. Comments and form fields over it are deleted,
 * as they would still show (or hold) what was there.
 */
function redact(page: mupdf.PDFPage, area: RedactArea) {
  const rects = "quads" in area ? area.quads.map(quadBounds) : [area.rect];
  for (const w of page.getWidgets()) {
    if (rects.some((r) => intersects(r, w.getRect()))) page.deleteAnnotation(w);
  }
  for (const a of page.getAnnotations()) {
    if (a.getType() === "Popup") continue;
    if (rects.some((r) => intersects(r, a.getBounds()))) page.deleteAnnotation(a);
  }
  const annot = page.createAnnotation("Redact");
  if ("quads" in area) annot.setQuadPoints(area.quads);
  else annot.setRect(area.rect);
  annot.applyRedaction(
    1,
    mupdf.PDFPage.REDACT_IMAGE_PIXELS,
    mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
    mupdf.PDFPage.REDACT_TEXT_REMOVE,
  );
}

function historyOf(docId: number, id?: number): EditState {
  const pdf = getDoc(docId).asPDF();
  if (!pdf) return { canUndo: false, canRedo: false };
  return { canUndo: pdf.canUndo(), canRedo: pdf.canRedo(), id };
}

/** Runs one user action (possibly over many pages) as a single undo step. */
function editDoc<T>(docId: number, name: string, fn: (pdf: mupdf.PDFDocument) => T): T {
  const entry = getEntry(docId);
  const pdf = getPdf(docId);
  pdf.beginOperation(name);
  try {
    const result = fn(pdf);
    pdf.endOperation();
    return result;
  } catch (e) {
    pdf.abandonOperation();
    throw e;
  } finally {
    entry.edited = true;
    dropStextFor(docId);
  }
}

/** Runs one user action on a page as a single undo step. */
function editPage<T>(docId: number, pageIndex: number, name: string, fn: (page: mupdf.PDFPage) => T): T {
  return editDoc(docId, name, (pdf) => {
    const page = pdf.loadPage(pageIndex);
    try {
      return fn(page);
    } finally {
      page.destroy();
    }
  });
}

/** Name of the undo step that changes the size of pages (they are measured again after it). */
const CROP_STEP = "crop";

function undoRedo(docId: number, redo: boolean): EditState {
  const pdf = getPdf(docId);
  let resized = false;
  if (redo ? pdf.canRedo() : pdf.canUndo()) {
    const journal = pdf.getJournal();
    resized = journal.steps[redo ? journal.position : journal.position - 1] === CROP_STEP;
    if (redo) pdf.redo();
    else pdf.undo();
    getEntry(docId).edited = true;
    dropStextFor(docId);
  }
  const state = historyOf(docId);
  if (resized) state.pages = pageInfos(pdf);
  return state;
}

/** The smallest page a crop may leave (points). */
const MIN_CROP = 18;

/**
 * Crops a page: its visible area (CropBox) shrinks by the margins, measured from the
 * edges of the page as it is shown (rotated, already cropped). Nothing is removed from
 * the page content, the rest is only hidden – like in Acrobat.
 */
function cropPage(page: mupdf.PDFPage, m: Margins) {
  const [x0, y0, x1, y1] = page.getBounds();
  const visible: Rect = [x0 + m.left, y0 + m.top, x1 - m.right, y1 - m.bottom];
  if (visible[2] - visible[0] < MIN_CROP || visible[3] - visible[1] < MIN_CROP) {
    throw new CodedError("The cropped page would be too small", "CROP_TOO_SMALL");
  }
  const r = mupdf.Rect.transform(visible, mupdf.Matrix.invert(page.getTransform()));
  const obj = page.getObject();
  // Within the media box (in the page's own coordinates, y up).
  const media = obj.getInheritable("MediaBox");
  if (media.isArray() && media.length === 4) {
    const v = [0, 1, 2, 3].map((i) => media.get(i).asNumber());
    r[0] = Math.max(r[0], Math.min(v[0], v[2]));
    r[1] = Math.max(r[1], Math.min(v[1], v[3]));
    r[2] = Math.min(r[2], Math.max(v[0], v[2]));
    r[3] = Math.min(r[3], Math.max(v[1], v[3]));
  }
  obj.put("CropBox", r.map((v) => Math.round(v * 100) / 100));
}

/** A request's handler; `progress` reports how far a long one got. */
type Handler<M extends EngineMethod> = (
  args: EngineApi[M][0],
  progress: (p: Progress) => void,
) => Promise<[EngineApi[M][1], Transferable[]?]> | [EngineApi[M][1], Transferable[]?];

const handlers: { [M in EngineMethod]: Handler<M> } = {
  open({ data, name, password, sameAs }) {
    const bytes = new Uint8Array(data);
    // (a copy of an open document: encrypted with the same passwords)
    const like = sameAs !== undefined ? docs.get(sameAs) : undefined;
    const doc = openBytes(bytes, name, like?.password ?? password);
    return [registerDoc(doc, bytes, like?.password ?? password, like?.ownerPassword)];
  },

  async imagesToPdf({ images, paper }) {
    const bytes = await imagesToPdf(images, paper);
    return [registerDoc(openBytes(bytes, "application/pdf"), bytes)];
  },

  compress({ docId, preset }, progress) {
    getPdf(docId);
    // A smaller copy changes images and fonts – it is a change of the document.
    requireRight(docId, "modify");
    // Unsaved changes are written first (like saving does, which resets the undo history).
    const reopened = getEntry(docId).edited;
    const bytes = snapshot(docId);
    const result = compressPdf(bytes, getEntry(docId).password, preset, progress);
    return [
      { ...result, before: bytes.length, after: result.data.length, reopened },
      [result.data.buffer],
    ];
  },

  close({ docId }) {
    dropStextFor(docId);
    docs.get(docId)?.doc.destroy();
    docs.delete(docId);
    return [undefined];
  },

  async render({ docId, page, scale }) {
    const pix = renderPixmap(docId, page, scale);
    try {
      const bitmap = await createImageBitmap(pixmapToImageData(pix));
      return [{ bitmap, width: bitmap.width, height: bitmap.height }, [bitmap]];
    } finally {
      pix.destroy();
    }
  },

  async exportPage({ docId, page, dpi, format, quality }) {
    const pix = renderPixmap(docId, page, dpi / 72);
    try {
      pix.setResolution(dpi, dpi);
      const width = pix.getWidth();
      const height = pix.getHeight();
      let data: Uint8Array;
      if (format === "jpg") {
        data = pix.asJPEG(quality).slice();
      } else if (format === "png") {
        data = pix.asPNG().slice();
      } else {
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext("2d")!.putImageData(pixmapToImageData(pix), 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/webp", quality: quality / 100 });
        if (blob.type !== "image/webp") {
          throw new CodedError("This browser cannot encode WebP", "WEBP_UNSUPPORTED");
        }
        data = new Uint8Array(await blob.arrayBuffer());
      }
      return [{ data, width, height }, [data.buffer]];
    } finally {
      pix.destroy();
    }
  },

  search({ docId, needle }) {
    const doc = getDoc(docId);
    const hits: SearchHit[] = [];
    const count = doc.countPages();
    for (let i = 0; i < count; i++) {
      const page = doc.loadPage(i);
      try {
        let previous = "";
        for (const found of searchPage(page, needle)) {
          const quads = uniqueQuads(found);
          // A match inside a ligature ("fi" in "ﬃ") can come back twice.
          const key = quads.join(";");
          if (key === previous) continue;
          previous = key;
          hits.push({ page: i, quads });
        }
      } finally {
        page.destroy();
      }
    }
    return [hits];
  },

  selectText({ docId, page, from, to, mode }) {
    const stext = getStext(docId, page);
    let a: Point = from;
    let b: Point = to;
    if (mode === "words") {
      const ends = wordSelection(stext, from, to);
      if (!ends) return [{ quads: [], text: "" }];
      [a, b] = ends;
    }
    const quads = stext.highlight(a, b, 500) as Quad[];
    const text = quads.length ? stext.copy(a, b) : "";
    return [{ quads, text }];
  },

  compose({ pages, base, files }) {
    const bytes = buildPdf(pages, base, files);
    // The result stays encrypted like the base document, hence the same passwords
    // (an entered permissions password keeps the restrictions lifted).
    const baseEntry = docs.get(pickBase(pages, base));
    const doc = openBytes(bytes, "application/pdf", baseEntry?.password);
    return [registerDoc(doc, bytes, baseEntry?.password, baseEntry?.ownerPassword)];
  },

  buildPdf({ pages, base }) {
    const bytes = buildPdf(pages, base);
    return [bytes, [bytes.buffer]];
  },

  getBytes({ docId }) {
    const bytes = snapshot(docId).slice();
    return [bytes, [bytes.buffer]];
  },

  pageExtras({ docId, page }) {
    const doc = getDoc(docId);
    const pg = doc.loadPage(page);
    try {
      const extras: PageExtras = { links: readLinks(doc, pg), widgets: [], annots: [] };
      if (pg instanceof mupdf.PDFPage) {
        extras.widgets = readWidgets(pg);
        extras.annots = readAnnots(pg);
      }
      return [extras];
    } finally {
      pg.destroy();
    }
  },

  editAnnot({ docId, page, edit }) {
    requireRight(docId, "annotate");
    const id = editPage(docId, page, edit.op, (pg) => applyEdit(pg, edit));
    return [historyOf(docId, id)];
  },

  setField({ docId, page, id, value, toggle }) {
    requireRight(docId, "fillForms");
    editPage(docId, page, "field", (pg) => {
      const w = findWidget(pg, id);
      if (toggle) w.toggle();
      else if (w.isChoice()) w.setChoiceValue(value ?? "");
      else w.setTextValue(value ?? "");
      w.update();
    });
    return [historyOf(docId)];
  },

  redact({ docId, page, area }) {
    requireRight(docId, "modify");
    editPage(docId, page, "redact", (pg) => redact(pg, area));
    getEntry(docId).rewrite = true;
    return [historyOf(docId)];
  },

  textLines({ docId, page }) {
    const pg = getPdf(docId).loadPage(page);
    try {
      return [readTextLines(pg)];
    } finally {
      pg.destroy();
    }
  },

  editText({ docId, page, line, text }) {
    requireRight(docId, "modify");
    const pdf = getPdf(docId);
    if (editPage(docId, page, "text", (pg) => replaceTextLine(pdf, pg, line, text))) {
      getEntry(docId).rewrite = true;
    }
    return [historyOf(docId)];
  },

  crop({ docId, pages, margins }) {
    requireRight(docId, "modify");
    editDoc(docId, CROP_STEP, (pdf) => {
      for (const index of pages) {
        const page = pdf.loadPage(index);
        try {
          cropPage(page, margins);
        } finally {
          page.destroy();
        }
      }
    });
    const state = historyOf(docId);
    state.pages = pageInfos(getDoc(docId));
    return [state];
  },

  stamp({ docId, stamp }) {
    requireRight(docId, "modify");
    editDoc(docId, stamp.kind, (pdf) => stampPages(pdf, stamp));
    return [historyOf(docId)];
  },

  security({ docId }) {
    return [securityOf(getEntry(docId))];
  },

  unlock({ docId, password }) {
    const entry = getEntry(docId);
    if (!entry.owner) {
      if (!(checkPassword(entry.bytes, password) & 4)) throw new CodedError("Incorrect password", "PASSWORD_WRONG");
      entry.owner = true;
      entry.ownerPassword = password;
    }
    return [securityOf(entry)];
  },

  protect({ docId, protection }) {
    getPdf(docId);
    const entry = getEntry(docId);
    if (!entry.owner) throw new CodedError("The permissions password is needed", "PASSWORD_REQUIRED");
    entry.protection = protection;
    entry.edited = true;
    return [securityOf(entry)];
  },

  undo({ docId }) {
    return [undoRedo(docId, false)];
  },

  redo({ docId }) {
    return [undoRedo(docId, true)];
  },

  history({ docId }) {
    return [historyOf(docId)];
  },
};

scope.onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    const handler = handlers[method] as Handler<EngineMethod>;
    const progress = (p: Progress) => scope.postMessage({ id, progress: p });
    const [result, transfer] = await handler(args as never, progress);
    scope.postMessage({ id, ok: true, result }, transfer ?? []);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof CodedError ? err.code : undefined;
    const detail = err instanceof CodedError ? err.detail : undefined;
    scope.postMessage({ id, ok: false, error: { message, code, detail } });
  }
};

// MuPDF loads asynchronously (WASM); the message with id 0 tells the UI the engine is ready.
scope.postMessage({ id: 0, ok: true, result: "ready" });
