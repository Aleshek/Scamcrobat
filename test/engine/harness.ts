/**
 * Runs the PDF worker (src/engine/pdf.worker.ts) in Node: a stand-in for the worker scope
 * passes requests to it and collects its replies, exactly as the app's Web Worker does.
 * Only rendering needs browser APIs (ImageBitmap, OffscreenCanvas); everything else works here.
 */
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import type { DocInfo, EngineApi, EngineMethod, EngineResponse, Progress } from "../../src/engine/types";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  progress?: (p: Progress) => void;
}

/** An error from the engine, with its code (e.g. PASSWORD_REQUIRED) */
export class EngineFailure extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

const pending = new Map<number, Pending>();
let nextId = 1;

const scope = {
  onmessage: null as ((e: { data: unknown }) => void) | null,
  postMessage(message: EngineResponse) {
    if (message.id === 0) return; // "ready"
    const p = pending.get(message.id);
    if (!p) return;
    if (message.ok === undefined) {
      p.progress?.(message.progress);
      return;
    }
    pending.delete(message.id);
    if (message.ok) p.resolve(message.result);
    else p.reject(new EngineFailure(message.error.message, message.error.code));
  },
};

(globalThis as { self?: unknown }).self = scope;
await import("../../src/engine/pdf.worker");

/** Sends a request to the engine, like the app does. */
export function call<M extends EngineMethod>(
  method: M,
  args: EngineApi[M][0],
  progress?: (p: Progress) => void,
): Promise<EngineApi[M][1]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress });
    scope.onmessage!({ data: { id, method, args } });
  });
}

/** Content of a file in test/fixtures */
export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
}

/** Copies bytes into a fresh ArrayBuffer (the engine takes ownership of what it gets). */
export function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

/** Opens a fixture or a byte array in the engine. */
export function open(source: string | Uint8Array, password?: string): Promise<DocInfo> {
  const bytes = typeof source === "string" ? fixture(source) : source;
  return call("open", { data: buffer(bytes), name: typeof source === "string" ? source : "test.pdf", password });
}

/** Opens saved bytes with MuPDF directly, independently of the engine. */
export function reopen(bytes: Uint8Array, password?: string): mupdf.PDFDocument {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
  if (!doc) throw new Error("Not a PDF");
  if (doc.needsPassword() && !doc.authenticatePassword(password ?? "")) throw new Error("Wrong password");
  return doc;
}

/** Text of a page of a document opened with `reopen`, spaces collapsed. */
export function pageText(doc: mupdf.Document, page: number): string {
  return doc.loadPage(page).toStructuredText("").asText().replace(/\s+/g, " ").trim();
}

/** The saved file starts with the original bytes (an incremental save). */
export function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

/** How many times the file ends a revision ("%%EOF") – 1 for a file written as a whole. */
export function revisions(bytes: Uint8Array): number {
  return (Buffer.from(bytes).toString("latin1").match(/%%EOF/g) ?? []).length;
}
