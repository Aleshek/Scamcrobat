import { createContext, useContext } from "react";
import type { PdfEngine } from "../engine/engine";
import type { AnnotEdit, Color, EditState, Point, Rect } from "../engine/types";
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
  /** Only PDFs can be annotated */
  canEdit: boolean;
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
  placeSignature(page: number, rect: Rect): void;
  /** A signature form field was clicked. */
  signField(page: number, rect: Rect): void;
  goToPage(page: number): void;
  openUri(uri: string): void;
  pageLabel(page: number): string;
}

export const EditContext = createContext<EditApi | null>(null);

export const useEdit = () => useContext(EditContext);
