import { createContext, useContext } from "react";
import type { PdfEngine } from "../engine/engine";
import type { AnnotEdit, Color, EditState, Point, RedactArea, Rect, TextLine } from "../engine/types";
import type { Signature } from "./signatures";
import type { Tool, ToolSettings } from "./tools";

export interface AnnotRef {
  page: number;
  id: number;
}

/** A note or a text box being written (a new one, or an existing one when `id` is set). */
export type Draft =
  | { kind: "note"; page: number; at: Point; id?: number; text: string }
  | { kind: "text"; page: number; at: Point; id?: number; text: string; size: number; color: Color };

/** What the pages of a document need for editing; provided by DocView. */
export interface EditApi {
  engine: PdfEngine;
  docId: number;
  /** Comments and signatures can be added and changed (a PDF whose restrictions allow it) */
  canAnnotate: boolean;
  /** The content can be changed: correcting text, blacking out */
  canModify: boolean;
  /** Form fields can be filled in */
  canFillForms: boolean;
  tool: Tool;
  settings: ToolSettings;
  /** The signature being placed (signature tool) */
  signature: Signature | null;
  selected: AnnotRef | null;
  draft: Draft | null;
  /** Changes whenever the page content changes, so it gets rendered again. */
  pageRev(page: number): number;
  select(ref: AnnotRef | null): void;
  setDraft(draft: Draft | null): void;
  /** Applies an edit; null when it failed (the error is shown to the user). */
  edit(page: number, edit: AnnotEdit): Promise<EditState | null>;
  setField(page: number, id: number, change: { value?: string; toggle?: boolean }): Promise<void>;
  /** Replaces the text of a line; false when it failed (the error is shown to the user). */
  editText(page: number, line: TextLine, text: string): Promise<boolean>;
  /** Blacks out an area for good (once saved); false when it failed. */
  redact(page: number, area: RedactArea): Promise<boolean>;
  placeSignature(page: number, rect: Rect): void;
  /** A signature form field was clicked. */
  signField(page: number, rect: Rect): void;
  goToPage(page: number): void;
  openUri(uri: string): void;
  pageLabel(page: number): string;
}

export const EditContext = createContext<EditApi | null>(null);

export const useEdit = () => useContext(EditContext);
