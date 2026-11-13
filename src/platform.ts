/**
 * Differences between the desktop (Electron) and the web version.
 * The desktop app provides `window.scamcrobat` from electron/preload.cjs.
 */
import { msg } from "./i18n";

export interface OpenedFile {
  name: string;
  path?: string;
  data: ArrayBuffer;
}

type BridgeFile = { name: string; path: string; data: Uint8Array };

interface DesktopBridge {
  platform: string;
  takePendingFiles(): Promise<BridgeFile[]>;
  onFilesPending(callback: () => void): () => void;
  openFilesDialog(title?: string): Promise<BridgeFile[]>;
  openPath(path: string): Promise<BridgeFile | null>;
  saveFile(path: string, data: Uint8Array): Promise<string>;
  saveFileAs(suggestedName: string, defaultDir: string | undefined, data: Uint8Array): Promise<string | null>;
  onSaveAndClose(callback: () => void): () => void;
  pickFolder(defaultPath?: string): Promise<string | null>;
  writeFile(folder: string, name: string, data: Uint8Array): Promise<string>;
  showInFolder(path: string): Promise<void>;
  getPathForFile(file: File): string;
  setLanguage(lang: string): void;
  print(): Promise<void>;
}

declare global {
  interface Window {
    scamcrobat?: DesktopBridge;
    showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle>;
    showSaveFilePicker?: (opts?: {
      suggestedName?: string;
      id?: string;
      types?: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
  }
}

const bridge = window.scamcrobat ?? null;
export const isDesktop = bridge !== null;

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength && u8.buffer instanceof ArrayBuffer) {
    return u8.buffer;
  }
  return u8.slice().buffer as ArrayBuffer;
}

function fromBridge(f: BridgeFile): OpenedFile {
  return { name: f.name, path: f.path, data: toArrayBuffer(f.data) };
}

/**
 * Desktop: files the app was asked to open (double click on a PDF in Explorer, also while
 * the app is already running). `onFiles` is called for the files waiting at startup and
 * then whenever new ones arrive.
 */
export function watchIncomingFiles(onFiles: (files: OpenedFile[]) => void): () => void {
  if (!bridge) return () => {};
  const take = () => {
    bridge
      .takePendingFiles()
      .then((files) => files.length && onFiles(files.map(fromBridge)))
      .catch((e) => console.error(e));
  };
  const unsubscribe = bridge.onFilesPending(take);
  take();
  return unsubscribe;
}

/** Lets the user pick one or more PDF files. */
export async function openFilesDialog(title?: string): Promise<OpenedFile[]> {
  if (bridge) return (await bridge.openFilesDialog(title)).map(fromBridge);
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.multiple = true;
    input.onchange = async () => resolve(await Promise.all([...(input.files ?? [])].map(fileFromDrop)));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function fileFromDrop(file: File): Promise<OpenedFile> {
  let path: string | undefined;
  try {
    path = bridge?.getPathForFile(file) || undefined;
  } catch {
    path = undefined;
  }
  // On the desktop the main process reads the file – then it can also be saved back in place.
  if (bridge && path && isPdfName(path)) {
    const opened = await bridge.openPath(path);
    if (opened) return fromBridge(opened);
  }
  return { name: file.name, path, data: await file.arrayBuffer() };
}

export const isPdfName = (name: string) => /\.pdf$/i.test(name);

/** Overwrites an existing file (desktop only, only a file the user opened or saved). */
export async function savePdf(path: string, data: Uint8Array): Promise<void> {
  if (!bridge) throw new Error(msg().errors.saveInPlaceDesktopOnly);
  await bridge.saveFile(path, data);
}

/**
 * Saves a PDF under a new name: on the desktop through the system dialog, in the browser
 * through the file picker (Chrome, Edge) or as a download.
 * Returns null when the user cancels.
 */
export async function savePdfAs(
  data: Uint8Array,
  suggestedName: string,
  defaultDir?: string,
): Promise<{ name: string; path?: string } | null> {
  if (bridge) {
    const path = await bridge.saveFileAs(suggestedName, defaultDir, data);
    return path ? { name: basename(path), path } : null;
  }
  if (window.showSaveFilePicker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName,
        id: "scamcrobat-save",
        types: [{ description: msg().common.pdfDocument, accept: { "application/pdf": [".pdf"] } }],
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return null;
      throw e;
    }
    const w = await handle.createWritable();
    await w.write(data as Uint8Array<ArrayBuffer>);
    await w.close();
    return { name: handle.name };
  }
  download(suggestedName, data);
  return { name: suggestedName };
}

function download(name: string, data: Uint8Array) {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Desktop: the main process asks to save before the window closes. */
export function onSaveAndClose(callback: () => void): () => void {
  return bridge ? bridge.onSaveAndClose(callback) : () => {};
}

/** Opens the system print dialog for the current page content (see print/print.ts). */
export async function printWindow(): Promise<void> {
  if (bridge) return bridge.print();
  window.print();
}

export function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : path;
}

/** Same file? Windows paths are case insensitive. */
export function samePath(a?: string, b?: string): boolean {
  return !!a && !!b && a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

/** Where exported files go – a folder on disk (desktop), a folder picked in the browser, or downloads. */
export interface ExportTarget {
  /** Description for the user, e.g. the folder path */
  label: string;
  write(name: string, data: Uint8Array): Promise<void>;
  /** Desktop: shows the folder in Explorer */
  reveal?: () => void;
}

export async function chooseExportTarget(suggestedDir?: string): Promise<ExportTarget | null> {
  if (bridge) {
    const folder = await bridge.pickFolder(suggestedDir);
    if (!folder) return null;
    let last: string | null = null;
    return {
      label: folder,
      async write(name, data) {
        last = await bridge.writeFile(folder, name, data);
      },
      reveal: () => {
        if (last) void bridge.showInFolder(last);
      },
    };
  }

  if (window.showDirectoryPicker) {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await window.showDirectoryPicker({ mode: "readwrite", id: "scamcrobat-export" });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return null;
      throw e;
    }
    return {
      label: dir.name,
      async write(name, data) {
        const handle = await dir.getFileHandle(name, { create: true });
        const w = await handle.createWritable();
        await w.write(data as Uint8Array<ArrayBuffer>);
        await w.close();
      },
    };
  }

  return {
    label: msg().common.downloads,
    async write(name, data) {
      download(name, data);
      // Browsers block rapid bulk downloads, hence a short pause.
      await new Promise((r) => setTimeout(r, 250));
    },
  };
}
