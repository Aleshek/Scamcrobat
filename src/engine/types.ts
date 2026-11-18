/** Types shared by the UI and the PDF worker. Page coordinates are in PDF points (1/72 inch). */

export type Point = [number, number];
/** Quadrilateral: ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y */
export type Quad = [number, number, number, number, number, number, number, number];

/** Rectangle: x0, y0, x1, y1 (page coordinates, y grows downwards) */
export type Rect = [number, number, number, number];
/** RGB color, every component 0–1 */
export type Color = [number, number, number];

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

export interface LinkInfo {
  rect: Rect;
  /** External target (web address, e-mail) */
  uri?: string;
  /** Target page of an internal link */
  page?: number;
}

export type WidgetKind = "text" | "checkbox" | "radio" | "combobox" | "listbox" | "signature" | "button";

/** A form field on a page. */
export interface WidgetInfo {
  id: number;
  kind: WidgetKind;
  name: string;
  rect: Rect;
  value: string;
  options?: string[];
  multiline: boolean;
  readOnly: boolean;
  maxLen: number;
  /** Font size from the field definition; 0 = automatic */
  fontSize: number;
}

/** An annotation on a page (highlight, note, drawing…). */
export interface AnnotInfo {
  id: number;
  /** PDF annotation type: Highlight, Ink, FreeText, Text, Stamp… */
  type: string;
  /** What is drawn on the page */
  bounds: Rect;
  /** The annotation's own rectangle, when it has one (it can be moved and resized) */
  rect?: Rect;
  quads?: Quad[];
  ink?: Point[][];
  contents: string;
  color: Color | null;
  /** FreeText font size */
  fontSize?: number;
  /** Line width (Ink) */
  width?: number;
}

export interface PageExtras {
  links: LinkInfo[];
  widgets: WidgetInfo[];
  annots: AnnotInfo[];
}

export type MarkupType = "Highlight" | "Underline" | "StrikeOut";

export type NewAnnot =
  | { type: MarkupType; quads: Quad[]; color: Color }
  | { type: "Ink"; strokes: Point[][]; color: Color; width: number }
  | { type: "FreeText"; rect: Rect; text: string; color: Color; size: number }
  | { type: "Text"; rect: Rect; text: string; color: Color }
  | { type: "Stamp"; rect: Rect; image: Uint8Array };

export type AnnotEdit =
  | { op: "create"; annot: NewAnnot }
  | { op: "move"; id: number; dx: number; dy: number }
  | { op: "setRect"; id: number; rect: Rect }
  | { op: "delete"; id: number }
  | { op: "setContents"; id: number; text: string; rect?: Rect }
  | { op: "setColor"; id: number; color: Color };

/** An area to black out: the quads of selected text or a rectangle. */
export type RedactArea = { quads: Quad[] } | { rect: Rect };

/** A line of text on a page that can be corrected (see textedit.ts). */
export interface TextLine {
  bbox: Rect;
  text: string;
  /** Largest font size on the line */
  size: number;
  family: "sans" | "serif" | "mono";
  bold: boolean;
  italic: boolean;
  color: Color;
  /** Written horizontally from left to right (only such lines can be edited) */
  horizontal: boolean;
}

/** What a protected document allows without its permissions password. */
export interface Permissions {
  print: boolean;
  copy: boolean;
  /** Changes: editing, comments, form filling, organizing pages */
  edit: boolean;
}

/** New password protection, applied when the document is saved. */
export interface Protection {
  /** Password to open the document; "" = none */
  openPassword: string;
  /** Password to change the protection; "" = no restrictions */
  permissionsPassword: string;
  /** Allowed without the permissions password */
  permissions: Permissions;
}

export interface SecurityInfo {
  /** Encryption of the document as it is now, e.g. "AES 256-bit"; null = none */
  method: string | null;
  /** A password is needed to open the document */
  openPassword: boolean;
  /** What is allowed without the permissions password (all true when not restricted) */
  permissions: Permissions;
  /** The protection can be changed: the document has no restrictions or the permissions password is known */
  canChange: boolean;
  /** Protection to apply at the next save: undefined = keep as it is, null = remove */
  pending?: Protection | null;
}

/** State of the edit history after a change; `id` = the annotation that was created. */
export interface EditState {
  canUndo: boolean;
  canRedo: boolean;
  id?: number;
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
  /** Content of an open document including all edits, for saving to disk. */
  getBytes: [{ docId: number }, Uint8Array];
  /** Links, form fields and annotations of a page. */
  pageExtras: [{ docId: number; page: number }, PageExtras];
  editAnnot: [{ docId: number; page: number; edit: AnnotEdit }, EditState];
  /** Sets a form field: text or choice value, or `toggle` for check boxes and radio buttons. */
  setField: [{ docId: number; page: number; id: number; value?: string; toggle?: boolean }, EditState];
  /** Blacks out an area: removes text, images and drawings under it for good (once saved). */
  redact: [{ docId: number; page: number; area: RedactArea }, EditState];
  /** Lines of text on a page that can be corrected. */
  textLines: [{ docId: number; page: number }, TextLine[]];
  /** Replaces the text of a line (`line` as returned by textLines). */
  editText: [{ docId: number; page: number; line: { bbox: Rect; text: string }; text: string }, EditState];
  security: [{ docId: number }, SecurityInfo];
  /** Checks the permissions password, so the protection can be changed. */
  unlock: [{ docId: number; password: string }, SecurityInfo];
  /** Sets the protection applied at the next save; null removes it. */
  protect: [{ docId: number; protection: Protection | null }, SecurityInfo];
  undo: [{ docId: number }, EditState];
  redo: [{ docId: number }, EditState];
  history: [{ docId: number }, EditState];
}

export type EngineMethod = keyof EngineApi;

export interface EngineRequest<M extends EngineMethod = EngineMethod> {
  id: number;
  method: M;
  args: EngineApi[M][0];
}

export type EngineResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; code?: string; detail?: string } };

/**
 * Error from the engine; `code` (e.g. PASSWORD_REQUIRED) is translated by the UI,
 * `detail` fills in the translated message (e.g. the character that cannot be written).
 */
export class EngineError extends Error {
  constructor(
    message: string,
    public code?: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}
