// PDFs from images and reducing file size.
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { buffer, call, fixture, reopen } from "./harness";

/** A page of a demo document as an image (PNG or JPEG) at `dpi`. */
function pageImage(format: "png" | "jpg", dpi: number): Uint8Array {
  const doc = mupdf.Document.openDocument(fixture("demo-en.pdf"), "application/pdf");
  const pix = doc.loadPage(1).toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false);
  return format === "png" ? pix.asPNG() : pix.asJPEG(90);
}

describe("PDF from images", () => {
  it("makes a page of each image", async () => {
    const info = await call("imagesToPdf", {
      images: [
        { data: buffer(pageImage("jpg", 100)), name: "scan-1.jpg" },
        { data: buffer(pageImage("png", 72)), name: "scan-2.png" },
      ],
      paper: "a4",
    });
    expect(info.pageCount).toBe(2);
    for (const page of info.pages) {
      expect(page.width).toBeGreaterThan(100);
      expect(page.height).toBeGreaterThan(page.width); // portrait, like the scanned page
    }
    const saved = reopen(await call("getBytes", { docId: info.docId }));
    expect(saved.countPages()).toBe(2);
    await call("close", { docId: info.docId });
  });

  it("refuses files that are not images", async () => {
    const junk = new TextEncoder().encode("not an image");
    await expect(call("imagesToPdf", { images: [{ data: buffer(junk), name: "notes.txt" }], paper: "a4" })).rejects.toMatchObject({
      code: "IMAGE_UNREADABLE",
    });
  });
});

describe("reducing file size", () => {
  it("scales down large images and keeps the pages", async () => {
    // a document with a big image: one page scanned at 300 DPI
    const scan = await call("imagesToPdf", { images: [{ data: buffer(pageImage("jpg", 300)), name: "scan.jpg" }], paper: "a4" });
    const progress: string[] = [];
    const result = await call("compress", { docId: scan.docId, preset: "small" }, (p) => progress.push(p.stage));
    expect(result.images).toBe(1);
    expect(result.changed).toBe(1);
    expect(result.after).toBeLessThan(result.before / 2);
    expect(result.signed).toBe(false);
    expect(progress.length).toBeGreaterThan(0);
    expect(reopen(result.data).countPages()).toBe(1);
    await call("close", { docId: scan.docId });
  });

  it("does not make a document without images bigger", async () => {
    const { docId } = await call("open", { data: buffer(fixture("demo-en.pdf")), name: "demo-en.pdf" });
    const result = await call("compress", { docId, preset: "lossless" });
    expect(result.after).toBeLessThanOrEqual(result.before);
    expect(reopen(result.data).countPages()).toBe(6);
    await call("close", { docId });
  });
});
