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

/** How pages are laid out in the viewer: one below another, side by side, or side by side after a cover page. */
export type PageMode = "single" | "two" | "cover";

export interface DocInfo {
  docId: number;
  pageCount: number;
  pages: PageInfo[];
  title: string | null;
  outline: OutlineNode[];
  /** Only PDFs can be edited (MuPDF also opens XPS, EPUB, images…) */
  isPdf: boolean;
  /** The page layout the document asks for when it opens (/PageLayout), if any */
  pageMode?: PageMode;
}

/** A page of a source document used when composing a new PDF. */
export interface PageRef {
  docId: number;
  /** Page index in the source document */
  page: number;
  /** Additional clockwise rotation, a multiple of 90 (may be negative or > 360) */
  rotate: number;
}

/**
 * A document whose bookmarks go into a composed PDF under a top-level bookmark with
 * this title (its file name), pointing to its first page.
 */
export interface OutlineFile {
  docId: number;
  title: string;
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

/**
 * What may be done with a document right now, by the permission bits of its protection
 * (all true when it is not restricted or its permissions password was entered).
 */
export interface DocRights {
  print: boolean;
  /** Copying text, exporting pages as images, taking pages into other documents */
  copy: boolean;
  /** Changing the content: correcting text, blacking out */
  modify: boolean;
  /** Comments, highlights, drawings, signatures */
  annotate: boolean;
  /** Filling in form fields */
  fillForms: boolean;
  /** Organizing pages: reordering, rotating, deleting, inserting */
  assemble: boolean;
}

export interface SecurityInfo {
  /** Encryption of the document as it is now, e.g. "AES 256-bit"; null = none */
  method: string | null;
  /** A password is needed to open the document */
  openPassword: boolean;
  /** What is allowed without the permissions password (all true when not restricted) */
  permissions: Permissions;
  /** What is allowed now: `permissions` in detail, or everything once the permissions password is known */
  rights: DocRights;
  /** The protection can be changed: the document has no restrictions or the permissions password is known */
  canChange: boolean;
  /** Protection to apply at the next save: undefined = keep as it is, null = remove */
  pending?: Protection | null;
}

/** Distances from the edges of a page as it is shown (points). */
export interface Margins {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type StampPosition = "center" | "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";

/** Text written into the content of pages: a watermark or page numbers. */
export interface Stamp {
  kind: "watermark" | "pageNumbers";
  /** The text for each page (0-based index) */
  texts: { page: number; text: string }[];
  /** Font size in points */
  size: number;
  color: Color;
  /** 0–1 */
  opacity: number;
  /** Counterclockwise, in degrees (only in the center) */
  rotation: number;
  position: StampPosition;
  /** Behind the page content instead of over it */
  under: boolean;
}

/** State of the edit history after a change; `id` = the annotation that was created. */
export interface EditState {
  canUndo: boolean;
  canRedo: boolean;
  id?: number;
  /** The new size of every page, when it changed (cropping, or undoing it) */
  pages?: PageInfo[];
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
  /**
   * Builds a new PDF from pages and opens it right away as a new document; the bookmarks
   * of `files` go under a top-level bookmark for each of them.
   */
  compose: [{ pages: PageRef[]; base?: number; files?: OutlineFile[] }, DocInfo];
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
  /** Crops pages: the visible area of each (its CropBox) shrinks by the margins. */
  crop: [{ docId: number; pages: number[]; margins: Margins }, EditState];
  /** Writes a watermark or page numbers into the content of pages. */
  stamp: [{ docId: number; stamp: Stamp }, EditState];
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
