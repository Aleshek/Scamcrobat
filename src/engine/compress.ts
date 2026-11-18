/**
 * Making a PDF smaller ("Reduce file size"): images drawn at a higher resolution than
 * needed are scaled down and stored as JPEG, data only other programs use is dropped,
 * fonts are subset and the file is written again with compressed object streams.
 *
 * It works on an instance of the document opened only for this, never on the one shown,
 * so the user's document stays as it is.
 */
import * as mupdf from "mupdf";
import type { CompressPreset, Progress } from "./types";

interface ImageSettings {
  /** Images drawn at more than 1.5 times this resolution (pixels per inch) are scaled down to it */
  dpi: number;
  /** JPEG quality 0–100 */
  quality: number;
}

/** Like Acrobat and Ghostscript: screen, e-book and print. "lossless" leaves images as they are. */
const IMAGE_PRESETS: Record<Exclude<CompressPreset, "lossless">, ImageSettings> = {
  small: { dpi: 100, quality: 50 },
  balanced: { dpi: 150, quality: 70 },
  high: { dpi: 300, quality: 85 },
};

/** Images are scaled down only when drawn above this multiple of the target resolution. */
const DOWNSAMPLE_ABOVE = 1.5;
/** Images smaller than this are not worth recompressing (unless they are scaled down). */
const MIN_RECOMPRESS = 16 * 1024;

/**
 * Write options for the smaller file: unused objects removed, duplicates merged (also
 * streams), content streams cleaned up (the same drawing, fewer bytes), everything
 * compressed and small objects packed into compressed object streams.
 * An encrypted document stays encrypted with its passwords.
 */
const OPTIMIZED_SAVE = JSON.stringify({
  garbage: 4,
  clean: true,
  compress: true,
  "compress-images": true,
  "compress-fonts": true,
  objstms: true,
  "compression-effort": 100,
});

interface ImageUse {
  /** Indirect reference of the image XObject */
  ref: mupdf.PDFObject;
  image: mupdf.Image;
  /** The lowest resolution it is drawn at anywhere (pixels per inch); Infinity = not drawn */
  dpi: number;
}

/**
 * All image XObjects of a document with the resolution each is drawn at. The images are
 * loaded first and kept, so the page interpreter finds the same objects in MuPDF's
 * resource store – that is how a drawn image is matched with its PDF object.
 */
function collectImages(pdf: mupdf.PDFDocument): ImageUse[] {
  const byPointer = new Map<number, ImageUse>();
  const count = pdf.countObjects();
  for (let num = 1; num < count; num++) {
    const ref = pdf.newIndirect(num);
    try {
      if (!ref.isStream()) continue;
      const subtype = ref.get("Subtype");
      if (!subtype.isName() || subtype.asName() !== "Image") continue;
      const image = pdf.loadImage(ref);
      byPointer.set(image.pointer, { ref, image, dpi: Infinity });
    } catch {
      /* a broken object is left as it is */
    }
  }

  const device = new mupdf.Device({
    fillImage(image: mupdf.Image, ctm: mupdf.Matrix) {
      const use = byPointer.get(image.pointer);
      if (!use) return; // an inline image
      const width = Math.hypot(ctm[0], ctm[1]) / 72;
      const height = Math.hypot(ctm[2], ctm[3]) / 72;
      if (!width || !height) return;
      use.dpi = Math.min(use.dpi, image.getWidth() / width, image.getHeight() / height);
    },
  });
  try {
    const pages = pdf.countPages();
    for (let i = 0; i < pages; i++) {
      const page = pdf.loadPage(i);
      try {
        page.run(device, mupdf.Matrix.identity); // content, comments and form fields
      } catch {
        /* a broken page keeps its images as they are */
      } finally {
        page.destroy();
      }
    }
    device.close();
  } finally {
    device.destroy();
  }
  return [...byPointer.values()];
}

const isSubtractive = (cs: mupdf.ColorSpace) => cs.getType() === "CMYK";

/** Scales a pixmap to w × h with MuPDF's renderer (it filters, so text in scans stays smooth). */
function resample(pix: mupdf.Pixmap, w: number, h: number): mupdf.Pixmap {
  const cs = pix.getColorSpace()!;
  const source = new mupdf.Image(pix);
  const out = new mupdf.Pixmap(cs, [0, 0, w, h], false);
  out.clear(isSubtractive(cs) ? 0 : 255);
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, out);
  try {
    device.fillImage(source, [w, 0, 0, h, 0, 0], 1);
    device.close();
  } finally {
    device.destroy();
    source.destroy();
  }
  return out;
}

/**
 * The same samples in DeviceGray, DeviceRGB or DeviceCMYK: MuPDF's JPEG writer stores
 * pixmaps in other color spaces (ICC based ones) as RGB. The PDF keeps the image's own
 * color space (and its ICC profile), only the JPEG needs this.
 */
function withDeviceColorSpace(pix: mupdf.Pixmap): mupdf.Pixmap {
  const type = pix.getColorSpace()!.getType();
  const device =
    type === "Gray" ? mupdf.ColorSpace.DeviceGray : type === "CMYK" ? mupdf.ColorSpace.DeviceCMYK : mupdf.ColorSpace.DeviceRGB;
  const w = pix.getWidth();
  const h = pix.getHeight();
  const out = new mupdf.Pixmap(device, [0, 0, w, h], false);
  const rowBytes = w * out.getNumberOfComponents();
  const srcStride = pix.getStride();
  const dstStride = out.getStride();
  // (both views right before copying: the WASM heap may grow and move with any allocation)
  const src = pix.getPixels();
  const dst = out.getPixels();
  if (srcStride === dstStride) dst.set(src.subarray(0, dstStride * h));
  else for (let y = 0; y < h; y++) dst.set(src.subarray(y * srcStride, y * srcStride + rowBytes), y * dstStride);
  return out;
}

/** Samples of a gray pixmap without row padding (for an uncompressed image stream). */
function graySamples(pix: mupdf.Pixmap): Uint8Array {
  const w = pix.getWidth();
  const h = pix.getHeight();
  const stride = pix.getStride();
  const src = pix.getPixels();
  if (stride === w) return new Uint8Array(src.subarray(0, w * h));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(src.subarray(y * stride, y * stride + w), y * w);
  return out;
}

const isDct = (image: mupdf.PDFObject) => {
  const filter = image.get("Filter");
  const last = filter.isArray() ? filter.get(filter.length - 1) : filter;
  return last.isName() && last.asName() === "DCTDecode";
};

/** Scales down the soft mask (transparency) of an image scaled to w × h, losslessly. */
function shrinkSoftMask(pdf: mupdf.PDFDocument, owner: mupdf.PDFObject, oldW: number, oldH: number, w: number, h: number) {
  const mask = owner.get("SMask");
  if (!mask.isIndirect() || !mask.isStream()) return;
  if (!mask.get("Matte").isNull()) return; // premultiplied – must keep the image's exact size
  if (mask.get("Width").asNumber() !== oldW || mask.get("Height").asNumber() !== oldH) return;
  const image = pdf.loadImage(mask);
  const pix = image.toPixmap();
  let small: mupdf.Pixmap | undefined;
  try {
    if (pix.getColorSpace()?.getType() !== "Gray" || pix.getAlpha()) return;
    small = resample(pix, w, h);
    mask.writeStream(graySamples(small)); // compressed when the file is written
  } finally {
    small?.destroy();
    pix.destroy();
    image.destroy();
  }
  mask.delete("Filter");
  mask.delete("DecodeParms");
  mask.delete("Decode");
  mask.put("Width", w);
  mask.put("Height", h);
  mask.put("BitsPerComponent", 8);
  mask.put("ColorSpace", "DeviceGray");
}

/**
 * Scales an image down to the target resolution (when it is drawn above 1.5 times that)
 * and stores it as JPEG – only when that makes it smaller. Bilevel images (scans of
 * text, usually CCITT or JBIG2 already), stencil masks, palette images that need no
 * scaling and images with color key masking are left as they are.
 */
function shrinkImage(pdf: mupdf.PDFDocument, use: ImageUse, settings: ImageSettings): boolean {
  const { ref, image } = use;
  if (image.getImageMask() || image.getBitsPerComponent() < 8 || ref.get("Mask").isArray()) return false;
  const cs = image.getColorSpace();
  if (!cs) return false;
  const length = ref.get("Length");
  const oldSize = length.isNumber() ? length.asNumber() : ref.readRawStream().getLength();
  const scale = use.dpi > settings.dpi * DOWNSAMPLE_ABOVE ? settings.dpi / use.dpi : 1;
  if (scale === 1 && (cs.isIndexed() || oldSize < MIN_RECOMPRESS)) return false;

  const oldW = image.getWidth();
  const oldH = image.getHeight();
  const w = Math.max(1, Math.round(oldW * scale));
  const h = Math.max(1, Math.round(oldH * scale));

  // (pixmaps are freed right away: images can be large and the WASM memory is limited)
  const pixmaps: mupdf.Pixmap[] = [];
  const own = (p: mupdf.Pixmap) => (pixmaps.push(p), p);
  let keepColorSpace: boolean;
  let cmyk: boolean;
  let jpeg: Uint8Array;
  try {
    let pix = own(image.toPixmap());
    if (pix.getAlpha()) return false;
    // JPEG holds gray, RGB or CMYK; anything else (palette, Lab, spot colors) becomes RGB.
    const type = pix.getColorSpace()?.getType();
    keepColorSpace = type === "Gray" || type === "RGB" || type === "CMYK";
    if (!keepColorSpace) pix = own(pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB));
    if (scale < 1) pix = own(resample(pix, w, h));
    cmyk = isSubtractive(pix.getColorSpace()!);
    // CMYK the way Photoshop writes it (inverted) with a Decode array, as most PDF tools do.
    jpeg = own(withDeviceColorSpace(pix)).asJPEG(settings.quality, cmyk).slice();
  } finally {
    for (const p of pixmaps) p.destroy();
  }

  // Recompressing a JPEG again costs quality, so it has to pay off.
  const limit = scale < 1 ? oldSize : isDct(ref) ? oldSize * 0.75 : oldSize * 0.9;
  if (jpeg.length >= limit) return false;

  ref.writeRawStream(jpeg);
  ref.put("Filter", "DCTDecode");
  ref.delete("DecodeParms");
  if (cmyk) ref.put("Decode", [1, 0, 1, 0, 1, 0, 1, 0]);
  else ref.delete("Decode");
  if (!keepColorSpace) ref.put("ColorSpace", "DeviceRGB");
  ref.put("Width", w);
  ref.put("Height", h);
  ref.put("BitsPerComponent", 8);
  if (scale < 1) {
    try {
      shrinkSoftMask(pdf, ref, oldW, oldH, w, h);
    } catch {
      /* the mask stays as it is – a mask of another size is allowed */
    }
  }
  return true;
}

/**
 * Scales down and recompresses the images of a document. `progress` gets the number
 * of images done and their total. Returns how many images there are and how many changed.
 */
function shrinkImages(
  pdf: mupdf.PDFDocument,
  settings: ImageSettings,
  progress: (done: number, total: number) => void,
): { images: number; changed: number } {
  const uses = collectImages(pdf);
  const drawn = uses.filter((u) => Number.isFinite(u.dpi));
  let changed = 0;
  drawn.forEach((use, i) => {
    progress(i, drawn.length);
    try {
      if (shrinkImage(pdf, use, settings)) changed++;
    } catch {
      /* an image that cannot be decoded stays as it is */
    }
  });
  for (const use of uses) use.image.destroy();
  return { images: drawn.length, changed };
}

/**
 * Drops what only other programs use and no reader shows: private data of the
 * application that made the file (PieceInfo, e.g. Illustrator's editable copy of the
 * whole document) and embedded page thumbnails (readers draw their own).
 */
function dropPrivateData(pdf: mupdf.PDFDocument) {
  pdf.getTrailer().get("Root").delete("PieceInfo");
  const pages = pdf.countPages();
  for (let i = 0; i < pages; i++) {
    const page = pdf.findPage(i);
    page.delete("PieceInfo");
    page.delete("Thumb");
  }
}

/** Does the document have form fields? (Their fonts must keep every glyph for typing.) */
function hasFormFields(pdf: mupdf.PDFDocument): boolean {
  const fields = pdf.getTrailer().get("Root", "AcroForm", "Fields");
  return fields.isArray() && fields.length > 0;
}

/** Is the document digitally signed? (SigFlags bit 1: the document contains signatures) */
function isSigned(pdf: mupdf.PDFDocument): boolean {
  const flags = pdf.getTrailer().get("Root", "AcroForm", "SigFlags");
  return flags.isNumber() && (flags.asNumber() & 1) !== 0;
}

function openPdf(bytes: Uint8Array, password?: string): mupdf.PDFDocument {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  if (password && doc.needsPassword()) doc.authenticatePassword(password);
  const pdf = doc.asPDF();
  if (!pdf) {
    doc.destroy();
    throw new Error("Not a PDF");
  }
  return pdf;
}

export interface Compressed {
  data: Uint8Array;
  images: number;
  changed: number;
  signed: boolean;
}

/**
 * A smaller copy of a PDF. `password` opens it (an encrypted document stays encrypted
 * with the same passwords and permissions).
 */
export function compressPdf(
  bytes: Uint8Array,
  password: string | undefined,
  preset: CompressPreset,
  progress: (p: Progress) => void,
): Compressed {
  let plain: Uint8Array;
  let stats = { images: 0, changed: 0 };
  let signed = false;
  const pdf = openPdf(bytes, password);
  try {
    signed = isSigned(pdf);
    if (preset !== "lossless") {
      stats = shrinkImages(pdf, IMAGE_PRESETS[preset], (done, total) => progress({ stage: "images", done, total }));
    }
    progress({ stage: "writing", done: 0, total: 1 });
    dropPrivateData(pdf);
    if (!hasFormFields(pdf)) {
      try {
        pdf.subsetFonts();
      } catch {
        /* the fonts stay whole */
      }
    }
    // Written once as it is first: MuPDF 1.28 can lose the data of a stream when a
    // document with changes is written with renumbered objects (garbage collection)
    // while a stream's dictionary is held. A freshly opened copy has neither.
    plain = pdf.saveToBuffer("").asUint8Array().slice();
  } finally {
    pdf.destroy();
  }

  const copy = openPdf(plain, password);
  try {
    const data = copy.saveToBuffer(OPTIMIZED_SAVE).asUint8Array().slice();
    return { data, ...stats, signed };
  } finally {
    copy.destroy();
  }
}
