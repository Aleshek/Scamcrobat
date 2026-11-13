// Hlavní proces desktopové aplikace (Electron).
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from "electron";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "dist");
const DEV_URL = process.env.SCAMCROBAT_DEV_URL || null;
const APP_ORIGIN = "app://bundle";

// Vlastní protokol app:// – načítání z file:// nepodporuje fetch() pro WASM ani module workery.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/** Soubor, který má dané okno otevřít po načtení (webContents.id → cesta). */
const pendingFiles = new Map();
/** Složky, které uživatel vybral pro export – jen do nich smí renderer zapisovat. */
const approvedFolders = new Set();
/** PDF soubory, které uživatel otevřel nebo uložil – jen ty smí renderer přepsat. */
const approvedFiles = new Set();
const fileKey = (p) => path.resolve(p).toLowerCase();

function pdfFromArgv(argv) {
  // argv[0] je spustitelný soubor; v režimu vývoje následuje cesta k aplikaci.
  return argv.slice(1).find((a) => !a.startsWith("-") && /\.pdf$/i.test(a) && existsSync(a)) ?? null;
}

async function readPdf(filePath) {
  const resolved = path.resolve(filePath);
  const data = await fs.readFile(resolved);
  approvedFiles.add(fileKey(resolved));
  return { name: path.basename(resolved), path: resolved, data: new Uint8Array(data) };
}

const isPdfPath = (p) => typeof p === "string" && /\.pdf$/i.test(p);

/** Zápis přes dočasný soubor – při chybě (plný disk, soubor zamčený jiným programem) zůstane originál netknutý. */
async function writeFileSafely(target, data) {
  if (!(data instanceof Uint8Array)) throw new Error("Neplatná data");
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (e && (e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES")) {
      throw new Error("Soubor nejde přepsat – možná je otevřený v jiném programu nebo je jen pro čtení.");
    }
    throw e;
  }
}

function createWindow(filePath = null) {
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

  const contentsId = win.webContents.id;
  pendingFiles.set(contentsId, filePath);
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => pendingFiles.delete(contentsId));

  // Odkazy ven otevřeme v prohlížeči, uvnitř aplikace žádná navigace.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  // Okno s neuloženými změnami (renderer zablokoval zavření přes beforeunload).
  win.webContents.on("will-prevent-unload", (e) => {
    if (SMOKE_SHOT) {
      // Automatický test se nemá na nic ptát – jen zaznamená, že okno hlídá neuložené změny.
      console.log("[smoke] okno s neuloženými změnami – zavření zachyceno");
      return e.preventDefault();
    }
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      title: "Scamcrobat",
      message: "Dokument má neuložené změny.",
      detail: "Chcete změny před zavřením uložit?",
      buttons: ["Uložit", "Neukládat", "Zrušit"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice === 1) e.preventDefault(); // zavřít bez uložení
    else if (choice === 0) win.webContents.send("app:save-and-close");
  });

  // F12 / Ctrl+Shift+I – vývojářské nástroje (aplikace nemá klasické menu).
  win.webContents.on("before-input-event", (_e, input) => {
    const devtools =
      input.type === "keyDown" &&
      (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i"));
    if (devtools) win.webContents.toggleDevTools();
  });

  if (SMOKE_SHOT) attachSmokeTest(win);
  void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`);
  return win;
}

// Automatický test: SCAMCROBAT_SMOKE_SHOT=cesta.png → po načtení uloží snímek okna a skončí.
// Volitelně SCAMCROBAT_SMOKE_SCRIPT=soubor.js – skript, který se před snímkem spustí v okně.
// SCAMCROBAT_SMOKE_THEME=light|dark vynutí vzhled (screenshoty do README).
const SMOKE_SHOT = process.env.SCAMCROBAT_SMOKE_SHOT || null;
const SMOKE_SCRIPT = process.env.SCAMCROBAT_SMOKE_SCRIPT || null;
const SMOKE_THEME = process.env.SCAMCROBAT_SMOKE_THEME;

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
          console.log(`[smoke] script selhal: ${e}`);
        }
      }
      const image = await win.webContents.capturePage();
      await fs.writeFile(SMOKE_SHOT, image.toPNG());
      console.log(`[smoke] title="${win.getTitle()}" snímek=${SMOKE_SHOT}`);
      app.quit();
    }, Number(process.env.SCAMCROBAT_SMOKE_DELAY || 4000));
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Druhé spuštění (např. dvojklik na další PDF) otevře nové okno ve stejném procesu.
  app.on("second-instance", (_e, argv) => {
    const file = pdfFromArgv(argv);
    if (file) {
      createWindow(file);
    } else {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      } else {
        createWindow();
      }
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    if (SMOKE_SHOT && (SMOKE_THEME === "light" || SMOKE_THEME === "dark")) nativeTheme.themeSource = SMOKE_THEME;

    protocol.handle("app", (request) => {
      const { host, pathname } = new URL(request.url);
      const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
      if (host !== "bundle" || !file.startsWith(DIST + path.sep)) {
        return new Response("Nenalezeno", { status: 404 });
      }
      return net.fetch(pathToFileURL(file).toString());
    });

    ipcMain.handle("file:initial", async (e) => {
      const filePath = pendingFiles.get(e.sender.id);
      pendingFiles.set(e.sender.id, null);
      return filePath ? readPdf(filePath) : null;
    });

    ipcMain.handle("file:open-dialog", async (e, options) => {
      const multiple = !!options?.multiple;
      const win = BrowserWindow.fromWebContents(e.sender);
      const result = await dialog.showOpenDialog(win, {
        title: typeof options?.title === "string" ? options.title : "Otevřít PDF",
        properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
        filters: [
          { name: "PDF dokumenty", extensions: ["pdf"] },
          { name: "Všechny soubory", extensions: ["*"] },
        ],
      });
      if (result.canceled || !result.filePaths.length) return multiple ? [] : null;
      if (multiple) return Promise.all(result.filePaths.map(readPdf));
      return readPdf(result.filePaths[0]);
    });

    // Soubor přetažený do okna – čte ho hlavní proces, aby ho šlo později uložit.
    ipcMain.handle("file:open-path", async (_e, filePath) => {
      if (!isPdfPath(filePath) || !existsSync(filePath)) return null;
      return readPdf(filePath);
    });

    ipcMain.handle("file:save", async (_e, filePath, data) => {
      if (!isPdfPath(filePath) || !approvedFiles.has(fileKey(filePath))) {
        throw new Error("Do tohoto souboru nelze zapisovat");
      }
      await writeFileSafely(path.resolve(filePath), data);
      return path.resolve(filePath);
    });

    ipcMain.handle("file:save-as", async (e, suggestedName, defaultDir, data) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const dir = typeof defaultDir === "string" && existsSync(defaultDir) ? defaultDir : app.getPath("documents");
      const name = typeof suggestedName === "string" && suggestedName ? path.basename(suggestedName) : "dokument.pdf";
      const result = await dialog.showSaveDialog(win, {
        title: "Uložit PDF",
        defaultPath: path.join(dir, name),
        filters: [{ name: "PDF dokument", extensions: ["pdf"] }],
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
      const result = await dialog.showOpenDialog(win, {
        title: "Kam uložit obrázky",
        buttonLabel: "Uložit sem",
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
      if (!approvedFolders.has(dir)) throw new Error("Do této složky nelze zapisovat");
      if (typeof name !== "string" || !name || name !== path.basename(name) || name.startsWith(".")) {
        throw new Error("Neplatný název souboru");
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

    createWindow(pdfFromArgv(process.argv));

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
