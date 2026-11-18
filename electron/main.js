// Main process of the desktop app (Electron).
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from "electron";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "dist");
const DEV_URL = process.env.SCAMCROBAT_DEV_URL || null;
const APP_ORIGIN = "app://bundle";

// Custom app:// protocol – loading from file:// does not support fetch() for WASM or module workers.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ---------- Texts of native dialogs (the window tells us its language) ----------

const STRINGS = {
  en: {
    openTitle: "Open PDF",
    pdfAndImages: "PDF documents and images",
    pdfFiles: "PDF documents",
    imageFiles: "Images",
    allFiles: "All files",
    saveTitle: "Save PDF",
    pdfDocument: "PDF document",
    defaultName: "document.pdf",
    pickFolderTitle: "Choose a destination folder",
    pickFolderButton: "Save here",
    unsavedMessage: "Some documents have unsaved changes.",
    unsavedDetail: "Do you want to save them before closing?",
    save: "Save",
    dontSave: "Don't save",
    cancel: "Cancel",
    fileLocked: "The file cannot be overwritten – it may be open in another program or read-only.",
    invalidData: "Invalid data",
    fileNotWritable: "This file cannot be written to",
    folderNotWritable: "This folder cannot be written to",
    invalidName: "Invalid file name",
    printFailed: "Printing failed",
  },
  cs: {
    openTitle: "Otevřít PDF",
    pdfAndImages: "PDF dokumenty a obrázky",
    pdfFiles: "PDF dokumenty",
    imageFiles: "Obrázky",
    allFiles: "Všechny soubory",
    saveTitle: "Uložit PDF",
    pdfDocument: "PDF dokument",
    defaultName: "dokument.pdf",
    pickFolderTitle: "Vyberte cílovou složku",
    pickFolderButton: "Uložit sem",
    unsavedMessage: "Některé dokumenty mají neuložené změny.",
    unsavedDetail: "Chcete změny před zavřením uložit?",
    save: "Uložit",
    dontSave: "Neukládat",
    cancel: "Zrušit",
    fileLocked: "Soubor nejde přepsat – možná je otevřený v jiném programu nebo je jen pro čtení.",
    invalidData: "Neplatná data",
    fileNotWritable: "Do tohoto souboru nelze zapisovat",
    folderNotWritable: "Do této složky nelze zapisovat",
    invalidName: "Neplatný název souboru",
    printFailed: "Tisk selhal",
  },
};

let lang = "en";
const t = () => STRINGS[lang] ?? STRINGS.en;

function systemLanguage() {
  for (const tag of app.getPreferredSystemLanguages()) {
    const base = tag.toLowerCase().split("-")[0];
    if (base === "cs" || base === "sk") return "cs";
    if (base === "en") return "en";
  }
  return "en";
}

// ---------- Files ----------

/** Files waiting to be opened in the window (from the command line or a second launch). */
const pendingPaths = [];
/** Folders the user picked for export – the renderer may only write there. */
const approvedFolders = new Set();
/** PDF files the user opened or saved – the renderer may only overwrite those. */
const approvedFiles = new Set();
const fileKey = (p) => path.resolve(p).toLowerCase();

/** Images the app makes PDFs of (the same list as in src/platform.ts). */
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "jpe", "jfif", "png", "gif", "bmp", "tif", "tiff", "webp"];
const IMAGE_PATTERN = new RegExp(`[.](${IMAGE_EXTENSIONS.join("|")})$`, "i");

const isPdfPath = (p) => typeof p === "string" && /\.pdf$/i.test(p);
const isImagePath = (p) => typeof p === "string" && IMAGE_PATTERN.test(p);

function filesFromArgv(argv) {
  // argv[0] is the executable; in development the app path follows.
  return argv.slice(1).filter((a) => !a.startsWith("-") && (isPdfPath(a) || isImagePath(a)) && existsSync(a));
}

async function readFile(filePath) {
  const resolved = path.resolve(filePath);
  const data = await fs.readFile(resolved);
  // An image becomes a new PDF – only PDFs are ever written back.
  if (isPdfPath(resolved)) approvedFiles.add(fileKey(resolved));
  return { name: path.basename(resolved), path: resolved, data: new Uint8Array(data) };
}

/** Writes through a temporary file – on failure (full disk, file locked) the original stays intact. */
async function writeFileSafely(target, data) {
  if (!(data instanceof Uint8Array)) throw new Error(t().invalidData);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (e && (e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES")) {
      throw new Error(t().fileLocked);
    }
    throw e;
  }
}

// ---------- Window ----------

let mainWindow = null;

let pendingTimer = null;

function queueFiles(paths) {
  if (!paths.length) return;
  pendingPaths.push(...paths);
  // The window takes the files when it is ready (file:take-pending). Explorer starts the app
  // once for each of several selected files ("Open with" on images), so the window is told
  // a moment later – images that come together make one PDF.
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => mainWindow?.webContents.send("app:files-pending"), 400);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: "Scamcrobat",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1d21" : "#f4f5f7",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow = win;
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // External links (web pages, e-mail) open in the system apps, no navigation inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  // A window with unsaved changes (the renderer blocked closing through beforeunload).
  win.webContents.on("will-prevent-unload", (e) => {
    if (SMOKE_SHOT) {
      // The automated test must not ask anything – it only records that the window guards unsaved changes.
      console.log("[smoke] window with unsaved changes – close intercepted");
      return e.preventDefault();
    }
    const s = t();
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      title: "Scamcrobat",
      message: s.unsavedMessage,
      detail: s.unsavedDetail,
      buttons: [s.save, s.dontSave, s.cancel],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice === 1) e.preventDefault(); // close without saving
    else if (choice === 0) win.webContents.send("app:save-and-close");
  });

  // F12 / Ctrl+Shift+I – developer tools (the app has no classic menu).
  win.webContents.on("before-input-event", (_e, input) => {
    const devtools =
      input.type === "keyDown" &&
      (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i"));
    if (devtools) win.webContents.toggleDevTools();
  });

  if (SMOKE_SHOT) attachSmokeTest(win);
  const url = new URL(DEV_URL ?? `${APP_ORIGIN}/index.html`);
  if (process.env.SCAMCROBAT_LANG) url.searchParams.set("lang", process.env.SCAMCROBAT_LANG);
  void win.loadURL(url.toString());
  return win;
}

// Automated test: SCAMCROBAT_SMOKE_SHOT=file.png → after loading, saves a screenshot of the window and quits.
// Optional SCAMCROBAT_SMOKE_SCRIPT=file.js – a script run in the window before the screenshot.
// SCAMCROBAT_SMOKE_THEME=light|dark forces the theme (README screenshots).
// SCAMCROBAT_SMOKE_PRINT=file.pdf – printing saves a PDF there instead of opening the print dialog.
const SMOKE_SHOT = process.env.SCAMCROBAT_SMOKE_SHOT || null;
const SMOKE_SCRIPT = process.env.SCAMCROBAT_SMOKE_SCRIPT || null;
const SMOKE_THEME = process.env.SCAMCROBAT_SMOKE_THEME;
const SMOKE_PRINT = process.env.SCAMCROBAT_SMOKE_PRINT || null;

function attachSmokeTest(win) {
  win.webContents.on("console-message", (e) => console.log(`[renderer:${e.level}] ${e.message}`));
  win.webContents.once("did-finish-load", () => {
    setTimeout(async () => {
      if (SMOKE_SCRIPT) {
        try {
          const code = await fs.readFile(SMOKE_SCRIPT, "utf8");
          const result = await win.webContents.executeJavaScript(code, true);
          console.log(`[smoke] script=${JSON.stringify(result)}`);
        } catch (e) {
          console.log(`[smoke] script failed: ${e}`);
        }
      }
      const image = await win.webContents.capturePage();
      await fs.writeFile(SMOKE_SHOT, image.toPNG());
      console.log(`[smoke] title="${win.getTitle()}" screenshot=${SMOKE_SHOT}`);
      app.quit();
    }, Number(process.env.SCAMCROBAT_SMOKE_DELAY || 4000));
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // A second launch (e.g. double click on another PDF) opens the file in a new tab of the running app.
  app.on("second-instance", (_e, argv) => {
    if (!mainWindow) {
      createWindow();
    } else {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    queueFiles(filesFromArgv(argv));
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    lang = systemLanguage();
    if (SMOKE_SHOT && (SMOKE_THEME === "light" || SMOKE_THEME === "dark")) nativeTheme.themeSource = SMOKE_THEME;

    protocol.handle("app", (request) => {
      const { host, pathname } = new URL(request.url);
      const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
      if (host !== "bundle" || !file.startsWith(DIST + path.sep)) {
        return new Response("Not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(file).toString());
    });

    ipcMain.on("app:set-language", (_e, value) => {
      if (Object.hasOwn(STRINGS, value)) lang = value;
    });

    ipcMain.handle("file:take-pending", async () => {
      const paths = pendingPaths.splice(0);
      const files = [];
      for (const p of paths) {
        try {
          files.push(await readFile(p));
        } catch (e) {
          console.error(`Cannot read ${p}:`, e);
        }
      }
      return files;
    });

    ipcMain.handle("file:open-dialog", async (e, options) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const s = t();
      const result = await dialog.showOpenDialog(win, {
        title: typeof options?.title === "string" ? options.title : s.openTitle,
        properties: ["openFile", "multiSelections"],
        // Images become PDF pages (a new document, or pages inserted in the organizer).
        filters: [
          { name: s.pdfAndImages, extensions: ["pdf", ...IMAGE_EXTENSIONS] },
          { name: s.pdfFiles, extensions: ["pdf"] },
          { name: s.imageFiles, extensions: IMAGE_EXTENSIONS },
          { name: s.allFiles, extensions: ["*"] },
        ],
      });
      if (result.canceled) return [];
      return Promise.all(result.filePaths.map(readFile));
    });

    // A file dropped into the window – the main process reads it so that it can be saved later.
    ipcMain.handle("file:open-path", async (_e, filePath) => {
      if (!isPdfPath(filePath) || !existsSync(filePath)) return null;
      return readFile(filePath);
    });

    ipcMain.handle("file:save", async (_e, filePath, data) => {
      if (!isPdfPath(filePath) || !approvedFiles.has(fileKey(filePath))) {
        throw new Error(t().fileNotWritable);
      }
      await writeFileSafely(path.resolve(filePath), data);
      return path.resolve(filePath);
    });

    ipcMain.handle("file:save-as", async (e, suggestedName, defaultDir, data) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const s = t();
      const dir = typeof defaultDir === "string" && existsSync(defaultDir) ? defaultDir : app.getPath("documents");
      const name = typeof suggestedName === "string" && suggestedName ? path.basename(suggestedName) : s.defaultName;
      const result = await dialog.showSaveDialog(win, {
        title: s.saveTitle,
        defaultPath: path.join(dir, name),
        filters: [{ name: s.pdfDocument, extensions: ["pdf"] }],
        properties: ["showOverwriteConfirmation"],
      });
      if (result.canceled || !result.filePath) return null;
      let target = path.resolve(result.filePath);
      if (!/\.pdf$/i.test(target)) target += ".pdf";
      await writeFileSafely(target, data);
      approvedFiles.add(fileKey(target));
      return target;
    });

    ipcMain.handle("export:pick-folder", async (e, defaultPath) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const s = t();
      const result = await dialog.showOpenDialog(win, {
        title: s.pickFolderTitle,
        buttonLabel: s.pickFolderButton,
        defaultPath: typeof defaultPath === "string" && existsSync(defaultPath) ? defaultPath : app.getPath("pictures"),
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const folder = path.resolve(result.filePaths[0]);
      approvedFolders.add(folder);
      return folder;
    });

    ipcMain.handle("export:write", async (_e, folder, name, data) => {
      const dir = path.resolve(String(folder));
      if (!approvedFolders.has(dir)) throw new Error(t().folderNotWritable);
      if (typeof name !== "string" || !name || name !== path.basename(name) || name.startsWith(".")) {
        throw new Error(t().invalidName);
      }
      const target = path.join(dir, name);
      await writeFileSafely(target, data);
      return target;
    });

    ipcMain.handle("shell:show-in-folder", (_e, filePath) => {
      const resolved = path.resolve(String(filePath));
      if (approvedFolders.has(path.dirname(resolved)) || approvedFiles.has(fileKey(resolved))) {
        shell.showItemInFolder(resolved);
      }
    });

    // Printing: the window has already laid out the pages for print (print media CSS).
    ipcMain.handle("app:print", async (e) => {
      if (SMOKE_PRINT) {
        const pdf = await e.sender.printToPDF({ printBackground: true, preferCSSPageSize: true });
        await fs.writeFile(SMOKE_PRINT, pdf);
        console.log(`[smoke] print=${SMOKE_PRINT} (${pdf.length} bytes)`);
        return;
      }
      await new Promise((resolve, reject) => {
        e.sender.print({ silent: false, printBackground: true }, (success, reason) => {
          if (success || reason === "cancelled") resolve();
          else reject(new Error(`${t().printFailed}${reason ? ` (${reason})` : ""}`));
        });
      });
    });

    queueFiles(filesFromArgv(process.argv));
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
