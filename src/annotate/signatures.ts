/**
 * Signature images: drawn or loaded from a file, trimmed to their content and
 * optionally remembered in this browser / app (localStorage – never uploaded).
 */

export interface Signature {
  id: string;
  /** PNG data URL – shown in the UI and stored */
  url: string;
  width: number;
  height: number;
}

const STORE_KEY = "scamcrobat.signatures";
const MAX_SAVED = 4;

export function loadSignatures(): Signature[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as Signature[];
    return Array.isArray(list) ? list.filter((s) => typeof s?.url === "string" && s.width > 0 && s.height > 0) : [];
  } catch {
    return [];
  }
}

function store(list: Signature[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
  } catch {
    /* storage full or blocked – the signature just is not remembered */
  }
}

export function rememberSignature(sig: Signature) {
  store([sig, ...loadSignatures().filter((s) => s.id !== sig.id && s.url !== sig.url)]);
}

export function forgetSignature(id: string) {
  store(loadSignatures().filter((s) => s.id !== id));
}

export function signatureBytes(sig: Signature): Uint8Array {
  const base64 = sig.url.slice(sig.url.indexOf(",") + 1);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Crops a canvas to its non-transparent content; null when it is empty. */
function trim(canvas: HTMLCanvasElement, pad = 4): Signature | null {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return {
    id: `sig-${Date.now().toString(36)}`,
    url: out.toDataURL("image/png"),
    width: out.width,
    height: out.height,
  };
}

/** A signature from the drawing pad. */
export function signatureFromCanvas(canvas: HTMLCanvasElement): Signature | null {
  return trim(canvas);
}

/** Largest side of a signature loaded from an image (enough for print, small for storage). */
const MAX_IMAGE_SIDE = 900;

/** A signature from a photo or scan; `removeBackground` makes light pixels transparent. */
export async function signatureFromFile(file: Blob, removeBackground: boolean): Promise<Signature | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * k));
    canvas.height = Math.max(1, Math.round(bitmap.height * k));
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (removeBackground) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        // Paper (light) becomes transparent, ink stays; a soft edge between 150 and 215.
        const alpha = lum >= 215 ? 0 : lum <= 150 ? 1 : (215 - lum) / 65;
        d[i + 3] = Math.round(d[i + 3] * alpha);
      }
      ctx.putImageData(img, 0, 0);
    }
    return trim(canvas, 2);
  } finally {
    bitmap.close();
  }
}
