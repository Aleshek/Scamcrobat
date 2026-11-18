/**
 * The PDF engine running in a Web Worker. All work with MuPDF (WASM) happens here
 * so that rendering never blocks the user interface.
 *
 * Errors carry a `code` that the UI translates; the messages are only for logs.
 */
import * as mupdf from "mupdf";
import { CodedError } from "./coded";
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
  OutlineNode,
  PageExtras,
  PageInfo,
  PageRef,
  Permissions,
  Point,
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

/** Registers an open document and returns information about it for the UI. */
function registerDoc(doc: mupdf.Document, bytes: Uint8Array, password?: string, ownerPassword?: string): DocInfo {
  const pageCount = doc.countPages();
  const pages: PageInfo[] = [];
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
  let outline: OutlineNode[] = [];
  try {
    outline = convertOutline(doc.loadOutline());
  } catch {
    /* ignore broken bookmarks */
  }
  const title = doc.getMetaData(mupdf.Document.META_INFO_TITLE)?.trim() || null;
  const docId = nextDocId++;
  // Undo and redo of annotation and form edits.
  doc.asPDF()?.enableJournal();
  docs.set(docId, newEntry(doc, bytes, password, ownerPassword));
  return { docId, pageCount, pages, title, outline, isPdf: doc.asPDF() !== null };
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

/**
 * Builds a new PDF from the given pages (order, rotation, pages from several files).
 *
 * It starts from a fresh copy of the main document (see pickBase), so its bookmarks,
 * metadata, forms and links are kept. Pages from other files are grafted into it
 * and finally everything is rearranged into the requested order.
 */
function buildPdf(refs: PageRef[], prefer?: number): Uint8Array {
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

/** Runs one user action as a single undo step. */
function editPage<T>(docId: number, pageIndex: number, name: string, fn: (page: mupdf.PDFPage) => T): T {
  const entry = getEntry(docId);
  const pdf = getPdf(docId);
  const page = pdf.loadPage(pageIndex);
  pdf.beginOperation(name);
  try {
    const result = fn(page);
    pdf.endOperation();
    return result;
  } catch (e) {
    pdf.abandonOperation();
    throw e;
  } finally {
    page.destroy();
    entry.edited = true;
    dropStextFor(docId);
  }
}

function undoRedo(docId: number, redo: boolean): EditState {
  const pdf = getPdf(docId);
  if (redo ? pdf.canRedo() : pdf.canUndo()) {
    if (redo) pdf.redo();
    else pdf.undo();
    getEntry(docId).edited = true;
    dropStextFor(docId);
  }
  return historyOf(docId);
}

type Handler<M extends EngineMethod> = (
  args: EngineApi[M][0],
) => Promise<[EngineApi[M][1], Transferable[]?]> | [EngineApi[M][1], Transferable[]?];

const handlers: { [M in EngineMethod]: Handler<M> } = {
  open({ data, name, password }) {
    const bytes = new Uint8Array(data);
    const doc = openBytes(bytes, name, password);
    return [registerDoc(doc, bytes, password)];
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
        // Like browsers: "Crows" matches "crows", "zlutoucky" matches "žluťoučký".
        for (const quads of page.search(needle, "ignore-case,ignore-diacritics")) {
          hits.push({ page: i, quads: quads as Quad[] });
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
      const q = stext.snap(from, to, "words") as Quad;
      a = [q[0], (q[1] + q[5]) / 2];
      b = [q[6], (q[3] + q[7]) / 2];
    }
    const quads = stext.highlight(a, b, 500) as Quad[];
    const text = quads.length ? stext.copy(a, b) : "";
    return [{ quads, text }];
  },

  compose({ pages, base }) {
    const bytes = buildPdf(pages, base);
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
    const [result, transfer] = await handler(args as never);
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
