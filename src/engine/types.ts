/** Typy sdílené mezi UI a PDF workerem. Souřadnice stránek jsou v PDF bodech (1/72 palce). */

export type Point = [number, number];
/** Čtyřúhelník: ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y */
export type Quad = [number, number, number, number, number, number, number, number];

export interface PageInfo {
  /** Šířka a výška stránky v bodech */
  width: number;
  height: number;
  /** Levý horní roh stránky v souřadnicích PDF (obvykle 0,0) */
  x0: number;
  y0: number;
  label: string;
}

export interface OutlineNode {
  title: string;
  page: number | null;
  children: OutlineNode[];
}

export interface DocInfo {
  docId: number;
  pageCount: number;
  pages: PageInfo[];
  title: string | null;
  outline: OutlineNode[];
  /** Jen PDF lze upravovat (MuPDF umí otevřít i XPS, EPUB, obrázky…) */
  isPdf: boolean;
}

/** Stránka ze zdrojového dokumentu při skládání nového PDF. */
export interface PageRef {
  docId: number;
  /** Index stránky ve zdrojovém dokumentu */
  page: number;
  /** Dodatečné otočení po směru hodinových ručiček, násobek 90 (může být i záporné nebo > 360) */
  rotate: number;
}

export type ImageFormat = "jpg" | "png" | "webp";

export interface SearchHit {
  page: number;
  quads: Quad[];
}

export interface TextSelection {
  page: number;
  quads: Quad[];
  text: string;
}

export interface RenderResult {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export interface ExportResult {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Požadavky, které UI posílá workeru: název → [argumenty, výsledek] */
export interface EngineApi {
  open: [{ data: ArrayBuffer; name: string; password?: string }, DocInfo];
  close: [{ docId: number }, void];
  render: [{ docId: number; page: number; scale: number }, RenderResult];
  exportPage: [
    { docId: number; page: number; dpi: number; format: ImageFormat; quality: number },
    ExportResult,
  ];
  search: [{ docId: number; needle: string }, SearchHit[]];
  selectText: [
    { docId: number; page: number; from: Point; to: Point; mode: "chars" | "words" },
    { quads: Quad[]; text: string },
  ];
  /** Sestaví nové PDF ze stránek a rovnou ho otevře jako nový dokument. */
  compose: [{ pages: PageRef[]; base?: number }, DocInfo];
  /** Sestaví nové PDF ze stránek a vrátí jeho obsah (extrakce, rozdělení). */
  buildPdf: [{ pages: PageRef[]; base?: number }, Uint8Array];
  /** Obsah otevřeného dokumentu pro uložení na disk. */
  getBytes: [{ docId: number }, Uint8Array];
}

export type EngineMethod = keyof EngineApi;

export interface EngineRequest<M extends EngineMethod = EngineMethod> {
  id: number;
  method: M;
  args: EngineApi[M][0];
}

export type EngineResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; code?: string } };

export class EngineError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}
