/** Types shared by the UI and the PDF worker. Page coordinates are in PDF points (1/72 inch). */

export type Point = [number, number];
/** Quadrilateral: ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y */
export type Quad = [number, number, number, number, number, number, number, number];

export interface PageInfo {
  /** Page width and height in points */
  width: number;
  height: number;
  /** Top left corner of the page in PDF coordinates (usually 0,0) */
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
  /** Only PDFs can be edited (MuPDF also opens XPS, EPUB, images…) */
  isPdf: boolean;
}

/** A page of a source document used when composing a new PDF. */
export interface PageRef {
  docId: number;
  /** Page index in the source document */
  page: number;
  /** Additional clockwise rotation, a multiple of 90 (may be negative or > 360) */
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

/** Requests the UI sends to the worker: name → [arguments, result] */
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
  /** Builds a new PDF from pages and opens it right away as a new document. */
  compose: [{ pages: PageRef[]; base?: number }, DocInfo];
  /** Builds a new PDF from pages and returns its content (extract, split). */
  buildPdf: [{ pages: PageRef[]; base?: number }, Uint8Array];
  /** Content of an open document, for saving to disk. */
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

/** Error from the engine; `code` (e.g. PASSWORD_REQUIRED) is translated by the UI. */
export class EngineError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}
