/**
 * Client of the PDF engine: sends requests to the worker and manages the render queue
 * (visible pages go first, cancelled requests are never sent).
 */
import {
  EngineError,
  type AnnotEdit,
  type EngineApi,
  type EngineMethod,
  type EngineResponse,
  type ImageFormat,
  type PageRef,
  type Point,
  type Protection,
  type RedactArea,
  type Rect,
  type RenderResult,
} from "./types";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface QueuedRender {
  args: EngineApi["render"][0];
  priority: number;
  seq: number;
  resolve: (r: RenderResult) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** How many render requests may be in the worker at once. */
const MAX_IN_FLIGHT = 2;

export const PRIORITY_VISIBLE = 0;
export const PRIORITY_NEARBY = 1;
export const PRIORITY_THUMBNAIL = 2;

export function abortError() {
  return new DOMException("Aborted", "AbortError");
}

export function isAbortError(e: unknown) {
  return e instanceof DOMException && e.name === "AbortError";
}

export class PdfEngine {
  private worker: Worker;
  private seq = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void>;
  private queue: QueuedRender[] = [];
  private inFlight = 0;

  constructor() {
    this.worker = new Worker(new URL("./pdf.worker.ts", import.meta.url), { type: "module" });
    let markReady!: () => void;
    let markFailed!: (e: unknown) => void;
    this.ready = new Promise((res, rej) => {
      markReady = res;
      markFailed = rej;
    });
    this.worker.onmessage = (e: MessageEvent<EngineResponse>) => {
      const msg = e.data;
      if (msg.id === 0) {
        markReady();
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new EngineError(msg.error.message, msg.error.code, msg.error.detail));
    };
    this.worker.onerror = (e) => {
      const err = new EngineError(`PDF engine failed: ${e.message || "unknown error"}`, "WORKER");
      markFailed(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private async call<M extends EngineMethod>(
    method: M,
    args: EngineApi[M][0],
    transfer: Transferable[] = [],
  ): Promise<EngineApi[M][1]> {
    await this.ready;
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, method, args }, transfer);
    });
  }

  open(data: ArrayBuffer, name: string, password?: string) {
    return this.call("open", { data, name, password }, [data]);
  }

  close(docId: number) {
    this.queue = this.queue.filter((q) => {
      if (q.args.docId !== docId) return true;
      q.reject(abortError());
      return false;
    });
    return this.call("close", { docId });
  }

  exportPage(docId: number, page: number, dpi: number, format: ImageFormat, quality: number) {
    return this.call("exportPage", { docId, page, dpi, format, quality });
  }

  search(docId: number, needle: string) {
    return this.call("search", { docId, needle });
  }

  selectText(docId: number, page: number, from: Point, to: Point, mode: "chars" | "words" = "chars") {
    return this.call("selectText", { docId, page, from, to, mode });
  }

  /**
   * Builds a new PDF from pages and opens it as a new document.
   * `base` = the document whose bookmarks and metadata should be kept (if any of its pages remain).
   */
  compose(pages: PageRef[], base?: number) {
    return this.call("compose", { pages, base });
  }

  /** Builds a new PDF from pages and returns its content. */
  buildPdf(pages: PageRef[], base?: number) {
    return this.call("buildPdf", { pages, base });
  }

  /** Document content including all edits, for saving. */
  getBytes(docId: number) {
    return this.call("getBytes", { docId });
  }

  /** Links, form fields and annotations of a page. */
  pageExtras(docId: number, page: number) {
    return this.call("pageExtras", { docId, page });
  }

  editAnnot(docId: number, page: number, edit: AnnotEdit) {
    return this.call("editAnnot", { docId, page, edit });
  }

  setField(docId: number, page: number, id: number, change: { value?: string; toggle?: boolean }) {
    return this.call("setField", { docId, page, id, ...change });
  }

  redact(docId: number, page: number, area: RedactArea) {
    return this.call("redact", { docId, page, area });
  }

  textLines(docId: number, page: number) {
    return this.call("textLines", { docId, page });
  }

  editText(docId: number, page: number, line: { bbox: Rect; text: string }, text: string) {
    return this.call("editText", { docId, page, line, text });
  }

  security(docId: number) {
    return this.call("security", { docId });
  }

  unlock(docId: number, password: string) {
    return this.call("unlock", { docId, password });
  }

  /** Protection applied at the next save; null removes it. */
  protect(docId: number, protection: Protection | null) {
    return this.call("protect", { docId, protection });
  }

  undo(docId: number) {
    return this.call("undo", { docId });
  }

  redo(docId: number) {
    return this.call("redo", { docId });
  }

  history(docId: number) {
    return this.call("history", { docId });
  }

  /** Schedules rendering of a page; lower priority value = sooner. */
  render(
    docId: number,
    page: number,
    scale: number,
    opts: { priority?: number; signal?: AbortSignal } = {},
  ): Promise<RenderResult> {
    const { priority = PRIORITY_VISIBLE, signal } = opts;
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<RenderResult>((resolve, reject) => {
      const item: QueuedRender = {
        args: { docId, page, scale },
        priority,
        seq: this.seq++,
        resolve,
        reject,
        signal,
      };
      if (signal) {
        item.onAbort = () => {
          const i = this.queue.indexOf(item);
          if (i >= 0) {
            this.queue.splice(i, 1);
            reject(abortError());
          }
        };
        signal.addEventListener("abort", item.onAbort, { once: true });
      }
      this.queue.push(item);
      this.pump();
    });
  }

  private pump() {
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i];
        const b = this.queue[best];
        if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
      }
      const item = this.queue.splice(best, 1)[0];
      if (item.signal && item.onAbort) item.signal.removeEventListener("abort", item.onAbort);
      this.inFlight++;
      this.call("render", item.args)
        .then((r) => {
          if (item.signal?.aborted) {
            r.bitmap.close();
            item.reject(abortError());
          } else {
            item.resolve(r);
          }
        }, (e) => item.reject(item.signal?.aborted ? abortError() : e))
        .finally(() => {
          this.inFlight--;
          this.pump();
        });
    }
  }
}
