/**
 * A PDF from images: a page for each image (for each page of a multi-page TIFF).
 *
 * Page size: a scan (an image that says it has 150 pixels per inch or more) that fits
 * on A3 keeps its own size, so it stays the size of the paper it was scanned from.
 * Everything else – photos and screenshots, which say 72 or 96 ppi and would make
 * pages a meter wide – goes on an A4 or Letter page turned like the image, fitted
 * within 10 mm margins and centered; a small image is never enlarged.
 *
 * MuPDF reads JPEG, PNG, GIF, BMP, TIFF and JPEG 2000 itself (and keeps JPEG data as
 * it is, with no loss); formats it does not know (WebP, AVIF) are decoded by the browser.
 */
import * as mupdf from "mupdf";
import { CodedError } from "./coded";
import type { ImageFile, Paper } from "./types";

const MM = 72 / 25.4;
const A3: [number, number] = [297 * MM, 420 * MM];
const PAPER: Record<Paper, [number, number]> = { a4: [210 * MM, 297 * MM], letter: [612, 792] };
const MARGIN = 10 * MM;
/** Images saying at least this resolution are scans (or made for print) */
const SCAN_PPI = 150;
/** Resolution of a decoded image that has none */
const SCREEN_PPI = 96;

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  jfif: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  bmp: "image/bmp",
  dib: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  jp2: "image/jp2",
  jpx: "image/jpx",
};

/** One page to make: the image's size in points and how to draw it. */
interface Source {
  bounds: mupdf.Rect;
  ppi: number;
  draw(device: mupdf.Device, ctm: mupdf.Matrix): void;
  destroy(): void;
}

/** Where an image goes: the page box and the matrix that puts the image on it. */
function placement(source: Source, paper: Paper): { page: mupdf.Rect; ctm: mupdf.Matrix } {
  const [x0, y0, x1, y1] = source.bounds;
  const w = x1 - x0;
  const h = y1 - y0;
  const slack = 1; // a scan of A3 may come out a fraction of a point larger
  if (source.ppi >= SCAN_PPI && Math.min(w, h) <= A3[0] + slack && Math.max(w, h) <= A3[1] + slack) {
    return { page: [0, 0, w, h], ctm: [1, 0, 0, 1, -x0, -y0] };
  }
  let [pw, ph] = PAPER[paper];
  if (w > h) [pw, ph] = [ph, pw];
  const s = Math.min(1, (pw - 2 * MARGIN) / w, (ph - 2 * MARGIN) / h);
  const dx = (pw - w * s) / 2;
  const dy = (ph - h * s) / 2;
  return { page: [0, 0, pw, ph], ctm: [s, 0, 0, s, dx - x0 * s, dy - y0 * s] };
}

/** The resolution an image page was laid out with (its first image's). */
function resolutionOf(page: mupdf.Page): number {
  let ppi = 0;
  const probe = new mupdf.Device({
    fillImage(image: mupdf.Image) {
      if (!ppi) ppi = Math.min(image.getXResolution(), image.getYResolution());
    },
  });
  try {
    page.run(probe, mupdf.Matrix.identity);
    probe.close();
  } finally {
    probe.destroy();
  }
  return ppi || SCREEN_PPI;
}

/** The pages of an image file MuPDF can read; null when it cannot. */
function readWithMupdf(file: ImageFile): Source[] | null {
  const ext = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase() ?? "";
  const magic = MIME[ext];
  if (!magic) return null;
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(new Uint8Array(file.data), magic);
  } catch {
    return null;
  }
  const sources: Source[] = [];
  try {
    const count = doc.countPages();
    for (let i = 0; i < count; i++) {
      const page = doc.loadPage(i);
      sources.push({
        bounds: page.getBounds(),
        ppi: resolutionOf(page),
        draw: (device, ctm) => page.run(device, ctm),
        destroy: () => page.destroy(),
      });
    }
  } catch {
    for (const s of sources) s.destroy();
    doc.destroy();
    return null;
  }
  if (!sources.length) {
    doc.destroy();
    return null;
  }
  // The document goes with its last page.
  const last = sources[sources.length - 1];
  const destroyLast = last.destroy;
  last.destroy = () => {
    destroyLast();
    doc.destroy();
  };
  return sources;
}

/**
 * An image decoded by the browser, stored as JPEG (quality 92) when it is opaque,
 * otherwise as PNG (it keeps its transparency).
 */
async function readWithBrowser(file: ImageFile): Promise<Source | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([file.data]));
  } catch {
    return null;
  }
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const blob = await canvas.convertToBlob(opaque ? { type: "image/jpeg", quality: 0.92 } : { type: "image/png" });
  const image = new mupdf.Image(new Uint8Array(await blob.arrayBuffer()));
  const w = (width * 72) / SCREEN_PPI;
  const h = (height * 72) / SCREEN_PPI;
  return {
    bounds: [0, 0, w, h],
    ppi: SCREEN_PPI,
    draw: (device, ctm) => device.fillImage(image, mupdf.Matrix.concat([w, 0, 0, h, 0, 0], ctm), 1),
    destroy: () => image.destroy(),
  };
}

/** A PDF with a page for each image, in the given order. */
export async function imagesToPdf(files: ImageFile[], paper: Paper): Promise<Uint8Array> {
  if (!files.length) throw new CodedError("No images", "EMPTY");
  const buffer = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buffer, "pdf", "compress");
  try {
    for (const file of files) {
      const sources = readWithMupdf(file) ?? [await readWithBrowser(file)].filter((s) => s !== null);
      if (!sources.length) throw new CodedError(`Cannot read the image ${file.name}`, "IMAGE_UNREADABLE", file.name);
      try {
        for (const source of sources) {
          const { page, ctm } = placement(source, paper);
          const device = writer.beginPage(page);
          source.draw(device, ctm);
          writer.endPage();
        }
      } finally {
        for (const source of sources) source.destroy();
      }
    }
    writer.close();
    return buffer.asUint8Array().slice();
  } finally {
    writer.destroy();
    buffer.destroy();
  }
}
