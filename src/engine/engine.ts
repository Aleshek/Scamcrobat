/**
 * Klient PDF jádra: posílá požadavky workeru a řídí frontu vykreslování
 * (viditelné stránky mají přednost, zrušené požadavky se vůbec nepošlou).
 */
import {
  EngineError,
  type EngineApi,
  type EngineMethod,
  type EngineResponse,
  type ImageFormat,
  type PageRef,
  type Point,
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

/** Kolik vykreslovacích požadavků smí být najednou ve workeru. */
const MAX_IN_FLIGHT = 2;

export const PRIORITY_VISIBLE = 0;
export const PRIORITY_NEARBY = 1;
export const PRIORITY_THUMBNAIL = 2;

export function abortError() {
  return new DOMException("Zrušeno", "AbortError");
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
      else p.reject(new EngineError(msg.error.message, msg.error.code));
    };
    this.worker.onerror = (e) => {
      const err = new EngineError(`PDF jádro selhalo: ${e.message || "neznámá chyba"}`, "WORKER");
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
   * Sestaví nové PDF ze stránek a otevře ho jako nový dokument.
   * `base` = dokument, jehož záložky a metadata se mají zachovat (pokud z něj zůstala nějaká stránka).
   */
  compose(pages: PageRef[], base?: number) {
    return this.call("compose", { pages, base });
  }

  /** Sestaví nové PDF ze stránek a vrátí jeho obsah. */
  buildPdf(pages: PageRef[], base?: number) {
    return this.call("buildPdf", { pages, base });
  }

  /** Obsah dokumentu pro uložení. */
  getBytes(docId: number) {
    return this.call("getBytes", { docId });
  }

  /** Naplánuje vykreslení stránky; nižší priorita = dřív. */
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
