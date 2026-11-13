/**
 * PDF jádro běžící ve Web Workeru. Veškerá práce s MuPDF (WASM) se děje tady,
 * aby vykreslování nebrzdilo uživatelské rozhraní.
 */
import * as mupdf from "mupdf";
import type {
  DocInfo,
  EngineApi,
  EngineMethod,
  EngineRequest,
  EngineResponse,
  OutlineNode,
  PageInfo,
  PageRef,
  Point,
  Quad,
  SearchHit,
} from "./types";

interface WorkerScope {
  onmessage: ((e: MessageEvent<EngineRequest>) => void) | null;
  postMessage(message: EngineResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

class CodedError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

interface DocEntry {
  doc: mupdf.Document;
  /** Původní obsah souboru – z něj se při úpravách dělá čistá kopie a ukládá se. */
  bytes: Uint8Array;
  password?: string;
}

const docs = new Map<number, DocEntry>();
let nextDocId = 1;

// Malá LRU cache strukturovaného textu (pro výběr textu tažením myši).
const stextCache = new Map<string, mupdf.StructuredText>();
const STEXT_CACHE_SIZE = 6;

function getEntry(docId: number): DocEntry {
  const entry = docs.get(docId);
  if (!entry) throw new CodedError("Dokument není otevřený", "NO_DOC");
  return entry;
}

function getDoc(docId: number): mupdf.Document {
  return getEntry(docId).doc;
}

function getPdf(docId: number): mupdf.PDFDocument {
  const pdf = getDoc(docId).asPDF();
  if (!pdf) throw new CodedError("Upravovat lze jen dokumenty PDF", "NOT_PDF");
  return pdf;
}

/** Otevře dokument z bajtů a ověří heslo. */
function openBytes(bytes: Uint8Array, name: string, password?: string): mupdf.Document {
  const doc = mupdf.Document.openDocument(bytes, name || "application/pdf");
  if (doc.needsPassword()) {
    if (!password) {
      doc.destroy();
      throw new CodedError("Dokument je chráněný heslem", "PASSWORD_REQUIRED");
    }
    if (!doc.authenticatePassword(password)) {
      doc.destroy();
      throw new CodedError("Nesprávné heslo", "PASSWORD_WRONG");
    }
  }
  return doc;
}

/** Zaregistruje otevřený dokument a vrátí informace o něm pro UI. */
function registerDoc(doc: mupdf.Document, bytes: Uint8Array, password?: string): DocInfo {
  const pageCount = doc.countPages();
  const pages: PageInfo[] = [];
  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    const [x0, y0, x1, y1] = page.getBounds();
    let label = String(i + 1);
    try {
      label = page.getLabel() || label;
    } catch {
      /* jiné formáty než PDF nemají štítky stránek */
    }
    pages.push({ x0, y0, width: x1 - x0, height: y1 - y0, label });
    page.destroy();
  }
  let outline: OutlineNode[] = [];
  try {
    outline = convertOutline(doc.loadOutline());
  } catch {
    /* poškozené záložky ignorujeme */
  }
  const title = doc.getMetaData(mupdf.Document.META_INFO_TITLE)?.trim() || null;
  const docId = nextDocId++;
  docs.set(docId, { doc, bytes, password });
  return { docId, pageCount, pages, title, outline, isPdf: doc.asPDF() !== null };
}

/** Základ nového PDF: preferovaný dokument, jinak ten, ze kterého pochází nejvíc stránek. */
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
 * Sestaví nové PDF ze zadaných stránek (pořadí, otočení, stránky z více souborů).
 *
 * Základem je čerstvá kopie hlavního dokumentu (viz pickBase) – díky tomu
 * zůstanou zachované jeho záložky, metadata, formuláře a odkazy. Stránky z ostatních
 * souborů se do něj „naroubují“ a nakonec se vše přeskládá do požadovaného pořadí.
 */
function buildPdf(refs: PageRef[], prefer?: number): Uint8Array {
  if (!refs.length) throw new CodedError("Dokument musí mít aspoň jednu stránku", "EMPTY");

  const baseId = pickBase(refs, prefer);
  const baseEntry = getEntry(baseId);
  getPdf(baseId); // ověří, že jde o PDF
  const base = openBytes(baseEntry.bytes, "application/pdf", baseEntry.password).asPDF()!;
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

/** Vykreslí stránku do RGB pixmapy v daném měřítku (1 = 72 DPI). */
function renderPixmap(docId: number, pageIndex: number, scale: number): mupdf.Pixmap {
  const page = getDoc(docId).loadPage(pageIndex);
  try {
    return page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  } finally {
    page.destroy();
  }
}

/** Převede RGB pixmapu na ImageData (RGBA). */
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
          throw new CodedError("Tento prohlížeč neumí ukládat WebP", "WEBP_UNSUPPORTED");
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
        for (const quads of page.search(needle, undefined)) {
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
    // Výsledek zůstává zašifrovaný stejně jako základní dokument, proto stejné heslo.
    const password = docs.get(pickBase(pages, base))?.password;
    const doc = openBytes(bytes, "application/pdf", password);
    return [registerDoc(doc, bytes, password)];
  },

  buildPdf({ pages, base }) {
    const bytes = buildPdf(pages, base);
    return [bytes, [bytes.buffer]];
  },

  getBytes({ docId }) {
    const bytes = getEntry(docId).bytes.slice();
    return [bytes, [bytes.buffer]];
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
    scope.postMessage({ id, ok: false, error: { message, code } });
  }
};

// MuPDF se načítá asynchronně (WASM); zpráva s id 0 dává UI vědět, že jádro je připravené.
scope.postMessage({ id: 0, ok: true, result: "ready" });
