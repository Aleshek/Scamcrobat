/**
 * Rozdíly mezi desktopovou (Electron) a webovou verzí.
 * Desktop poskytuje `window.scamcrobat` z electron/preload.cjs.
 */

export interface OpenedFile {
  name: string;
  path?: string;
  data: ArrayBuffer;
}

type BridgeFile = { name: string; path: string; data: Uint8Array };

interface DesktopBridge {
  platform: string;
  getInitialFile(): Promise<BridgeFile | null>;
  openFileDialog(): Promise<BridgeFile | null>;
  openFilesDialog(title?: string): Promise<BridgeFile[]>;
  openPath(path: string): Promise<BridgeFile | null>;
  saveFile(path: string, data: Uint8Array): Promise<string>;
  saveFileAs(suggestedName: string, defaultDir: string | undefined, data: Uint8Array): Promise<string | null>;
  onSaveAndClose(callback: () => void): () => void;
  pickFolder(defaultPath?: string): Promise<string | null>;
  writeFile(folder: string, name: string, data: Uint8Array): Promise<string>;
  showInFolder(path: string): Promise<void>;
  getPathForFile(file: File): string;
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

function fromBridge(f: BridgeFile | null): OpenedFile | null {
  return f ? { name: f.name, path: f.path, data: toArrayBuffer(f.data) } : null;
}

export async function getInitialFile(): Promise<OpenedFile | null> {
  return bridge ? fromBridge(await bridge.getInitialFile()) : null;
}

export async function openFileDialog(): Promise<OpenedFile | null> {
  if (bridge) return fromBridge(await bridge.openFileDialog());
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? await fileFromDrop(file) : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Výběr více PDF najednou (slučování, vkládání stránek). */
export async function openFilesDialog(title?: string): Promise<OpenedFile[]> {
  if (bridge) return (await bridge.openFilesDialog(title)).map((f) => fromBridge(f)!);
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
  // Na desktopu soubor načte hlavní proces – pak ho jde i uložit zpět na stejné místo.
  if (bridge && path && /\.pdf$/i.test(path)) {
    const opened = fromBridge(await bridge.openPath(path));
    if (opened) return opened;
  }
  return { name: file.name, path, data: await file.arrayBuffer() };
}

export const isPdfName = (name: string) => /\.pdf$/i.test(name);

/** Přepíše existující soubor (jen desktop, jen soubor, který uživatel otevřel nebo uložil). */
export async function savePdf(path: string, data: Uint8Array): Promise<void> {
  if (!bridge) throw new Error("Ukládání na místo je dostupné jen v desktopové aplikaci");
  await bridge.saveFile(path, data);
}

/**
 * Uloží PDF pod novým názvem: na desktopu přes systémový dialog, v prohlížeči
 * přes výběr souboru (Chrome, Edge) nebo jako stažený soubor.
 * Vrací null, pokud uživatel ukládání zrušil.
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
        types: [{ description: "PDF dokument", accept: { "application/pdf": [".pdf"] } }],
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

/** Desktop: hlavní proces žádá o uložení před zavřením okna. */
export function onSaveAndClose(callback: () => void): () => void {
  return bridge ? bridge.onSaveAndClose(callback) : () => {};
}

export function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : path;
}

/** Cíl exportu – složka na disku (desktop), složka vybraná v prohlížeči, nebo stahování. */
export interface ExportTarget {
  /** Popis pro uživatele, např. cesta ke složce */
  label: string;
  write(name: string, data: Uint8Array): Promise<void>;
  /** Na desktopu otevře složku v Průzkumníkovi */
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
    label: "Stažené soubory",
    async write(name, data) {
      download(name, data);
      // Prohlížeče blokují rychlé hromadné stahování, proto malá pauza.
      await new Promise((r) => setTimeout(r, 250));
    },
  };
}
