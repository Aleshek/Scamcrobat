/**
 * Printing: the chosen pages are rendered to images, laid out one image per sheet
 * (each sheet sized and oriented like its PDF page through named CSS @page rules)
 * and handed to the system print dialog. This is the same approach browsers' own
 * PDF viewers use, and it works the same on the web and in the desktop app.
 */
import type { PdfEngine } from "../engine/engine";
import type { DocInfo } from "../engine/types";
import { isDesktop, printWindow } from "../platform";

/** Upper limit of pixels per printed page (large formats would eat the memory). */
const MAX_PIXELS = 24_000_000;
const JPEG_QUALITY = 92;

export interface PrintOptions {
  pages: number[];
  dpi: number;
  onProgress(done: number, total: number): void;
  /** Return true to stop preparing pages. */
  cancelled(): boolean;
}

/** Prepares the pages and opens the print dialog. Resolves when printing is over (or cancelled). */
export async function printDocument(engine: PdfEngine, doc: DocInfo, opts: PrintOptions): Promise<void> {
  const root = document.createElement("div");
  root.className = "print-root";
  const style = document.createElement("style");
  const urls: string[] = [];
  const pageRules = new Map<string, string>();

  const cleanup = () => {
    root.remove();
    style.remove();
    for (const url of urls) URL.revokeObjectURL(url);
  };

  try {
    let done = 0;
    for (const index of opts.pages) {
      if (opts.cancelled()) return cleanup();
      const info = doc.pages[index];
      let dpi = opts.dpi;
      const pixels = ((info.width * dpi) / 72) * ((info.height * dpi) / 72);
      if (pixels > MAX_PIXELS) dpi *= Math.sqrt(MAX_PIXELS / pixels);

      const { data } = await engine.exportPage(doc.docId, index, dpi, "jpg", JPEG_QUALITY);
      const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
      urls.push(url);

      // One named @page per distinct page size, so every sheet keeps its size and orientation.
      const w = info.width.toFixed(2);
      const h = info.height.toFixed(2);
      const key = `${w}x${h}`;
      let name = pageRules.get(key);
      if (!name) {
        name = `sc-page-${pageRules.size}`;
        pageRules.set(key, name);
      }
      const sheet = document.createElement("div");
      sheet.className = "print-sheet";
      sheet.style.cssText = `page: ${name}; width: ${w}pt; height: calc(${h}pt - 1px);`;
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      sheet.appendChild(img);
      root.appendChild(sheet);
      await img.decode().catch(() => {});

      done++;
      opts.onProgress(done, opts.pages.length);
    }

    const rules = [...pageRules].map(([key, name]) => {
      const [w, h] = key.split("x");
      return `@page ${name} { size: ${w}pt ${h}pt; margin: 0; }`;
    });
    style.textContent = `@page { margin: 0; }\n${rules.join("\n")}`;
    document.head.appendChild(style);
    document.body.appendChild(root);
    // Give the browser a frame to lay out the sheets before printing.
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    if (isDesktop) {
      await printWindow();
    } else {
      // window.print() blocks in Chromium but not everywhere – clean up after "afterprint".
      await new Promise<void>((resolve) => {
        window.addEventListener("afterprint", () => resolve(), { once: true });
        void printWindow();
      });
    }
  } finally {
    cleanup();
  }
}
