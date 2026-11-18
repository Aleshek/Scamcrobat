import { useCallback, useEffect, useRef, useState } from "react";
import { FileUp, LoaderCircle } from "lucide-react";
import { PdfEngine } from "./engine/engine";
import { EngineError, type DocInfo, type SecurityInfo } from "./engine/types";
import { TabBar } from "./components/TabBar";
import { ChoiceDialog, type ChoiceRequest } from "./components/ChoiceDialog";
import { PasswordDialog } from "./components/PasswordDialog";
import { Organizer, type OrganizeResult, type OrganizerHandle } from "./organize/Organizer";
import { pagesFromDoc, type OrgPage, type OrgSource } from "./organize/model";
import { DocView } from "./DocView";
import { StartView } from "./StartView";
import {
  cycleTab,
  createTab,
  placeDoc,
  removeTab,
  setTabDoc,
  startTab,
  type OpenDoc,
  type TabsState,
} from "./tabs";
import {
  dirname,
  fileFromDrop,
  isPdfName,
  onSaveAndClose,
  openFilePath,
  openFilesDialog,
  samePath,
  savePdf,
  savePdfAs,
  isDesktop,
  watchIncomingFiles,
  type OpenedFile,
} from "./platform";
import { errorText } from "./errors";
import { forgetRecent, rememberOpened } from "./recent";
import { useT } from "./i18n";

interface OrganizeSession {
  id: number;
  /** Tab whose document is being organized; null = a new document (merge) */
  tabId: number | null;
  sources: OrgSource[];
  pages: OrgPage[];
  isNew: boolean;
  title: string;
  baseName: string;
  baseDir?: string;
}

const SIDEBAR_KEY = "scamcrobat.sidebar";
const stem = (name: string) => name.replace(/\.pdf$/i, "");

function readSidebarPref() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "0";
  } catch {
    return true;
  }
}

// One PDF engine (Web Worker) for the whole window.
let sharedEngine: PdfEngine | null = null;
const getEngine = () => (sharedEngine ??= new PdfEngine());

const initialTabs = (): TabsState => {
  const first = createTab();
  return { tabs: [first], activeId: first.id };
};

export function App() {
  const t = useT();
  const [engine] = useState(getEngine);
  if (import.meta.env.DEV) (window as unknown as { __engine: PdfEngine }).__engine = engine;
  const organizerRef = useRef<OrganizerHandle>(null);

  const [tabsState, setTabsState] = useState<TabsState>(initialTabs);
  /** Always the latest tabs, also inside async flows (updated together with the state). */
  const tabsRef = useRef(tabsState);
  const commit = useCallback((update: (s: TabsState) => TabsState) => {
    const next = update(tabsRef.current);
    if (next === tabsRef.current) return;
    tabsRef.current = next;
    setTabsState(next);
  }, []);
  const { tabs, activeId } = tabsState;
  const activeTab = tabs.find((x) => x.id === activeId) ?? tabs[0];

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [passwordAsk, setPasswordAsk] = useState<{
    name: string;
    wrong: boolean;
    kind: "open" | "permissions";
    resolve(value: string | null): void;
  } | null>(null);
  const [choice, setChoice] = useState<(ChoiceRequest & { resolve(value: string): void }) | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarPref);
  const [dragging, setDragging] = useState(false);
  const [organize, setOrganize] = useState<OrganizeSession | null>(null);
  const [organizeDirty, setOrganizeDirty] = useState(false);

  const organizeRef = useRef(organize);
  organizeRef.current = organize;
  /** After saving while the window closes, beforeunload must no longer block closing. */
  const allowClose = useRef(false);

  // ---------- Dialogs as promises ----------

  const ask = useCallback(
    (request: ChoiceRequest) => new Promise<string>((resolve) => setChoice({ ...request, resolve })),
    [],
  );

  const askPassword = useCallback(
    (name: string, wrong: boolean, kind: "open" | "permissions" = "open") =>
      new Promise<string | null>((resolve) => setPasswordAsk({ name, wrong, kind, resolve })),
    [],
  );

  const activate = useCallback((id: number) => commit((s) => (s.activeId === id ? s : { ...s, activeId: id })), [commit]);

  // ---------- Opening documents ----------

  /** Opens a file in the engine; asks for a password when needed. Returns null when the user cancels. */
  const openInEngine = useCallback(
    async (file: OpenedFile): Promise<DocInfo | null> => {
      let password: string | undefined;
      for (;;) {
        try {
          // A copy of the data: the original is kept for another attempt with a password.
          return await engine.open(file.data.slice(0), file.name, password);
        } catch (e) {
          if (e instanceof EngineError && (e.code === "PASSWORD_REQUIRED" || e.code === "PASSWORD_WRONG")) {
            const p = await askPassword(file.name, e.code === "PASSWORD_WRONG");
            if (p === null) return null;
            password = p;
          } else {
            throw e;
          }
        }
      }
    },
    [engine, askPassword],
  );

  /** Opens files, each in its own tab (an already open file just gets activated). */
  const openFiles = useCallback(
    async (files: OpenedFile[]) => {
      if (!files.length) return;
      setLoading(true);
      setError(null);
      try {
        for (const file of files) {
          const existing = file.path && tabsRef.current.tabs.find((x) => samePath(x.doc?.path, file.path));
          if (existing) {
            activate(existing.id);
            continue;
          }
          try {
            const info = await openInEngine(file);
            if (!info) continue;
            const doc: OpenDoc = {
              info,
              // Known before the document shows, so its restrictions apply from the start.
              security: await engine.security(info.docId),
              name: file.name,
              path: file.path,
              dir: file.path ? dirname(file.path) : undefined,
              dirty: false,
            };
            commit((s) => placeDoc(s, doc)[0]);
            if (file.path) rememberOpened(file.path, file.name);
          } catch (e) {
            setError(t.app.openFailed(file.name, errorText(e)));
          }
        }
      } finally {
        setLoading(false);
      }
    },
    [engine, openInEngine, activate, commit, t],
  );
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;

  const openRecent = useCallback(
    async (path: string, name: string) => {
      try {
        const file = await openFilePath(path);
        if (!file) {
          forgetRecent(path);
          setError(t.app.recentMissing(name));
          return;
        }
        await openFiles([file]);
      } catch (e) {
        setError(t.app.openFailed(name, errorText(e)));
      }
    },
    [openFiles, t],
  );

  const openDialog = useCallback(async () => {
    try {
      await openFiles(await openFilesDialog());
    } catch (e) {
      setError(errorText(e));
    }
  }, [openFiles]);

  // Desktop: files from Explorer (at startup and while running).
  useEffect(() => watchIncomingFiles((files) => void openFilesRef.current(files)), []);

  // ---------- Saving and closing ----------

  const saveDoc = useCallback(
    async (tabId: number, asNew: boolean): Promise<boolean> => {
      const d = tabsRef.current.tabs.find((x) => x.id === tabId)?.doc;
      if (!d) return false;
      if (d.redacted) {
        // Blacked-out content disappears from the file for good.
        const answer = await ask({
          title: t.app.redactSaveTitle,
          message: <p>{t.app.redactSaveMessage}</p>,
          options: [
            { value: "cancel", label: t.common.cancel },
            { value: "save", label: t.common.save, kind: "primary" },
          ],
        });
        if (answer !== "save") return false;
      }
      try {
        const data = await engine.getBytes(d.info.docId);
        // A new protection is applied by now (an entered permissions password stays valid).
        const security = await engine.security(d.info.docId);
        let { name, path } = d;
        if (!asNew && path && isDesktop) {
          setBusy(t.app.saving);
          await savePdf(path, data);
        } else {
          const suggested = isPdfName(name) ? name : `${name}.pdf`;
          const saved = await savePdfAs(data, suggested, d.dir);
          if (!saved) return false;
          name = saved.name;
          path = saved.path;
        }
        commit((s) =>
          setTabDoc(s, tabId, (cur) =>
            cur.info.docId === d.info.docId
              ? { ...cur, security, name, path, dir: path ? dirname(path) : cur.dir, dirty: false, redacted: false }
              : cur,
          ),
        );
        setToast(t.app.saved(name));
        if (path) rememberOpened(path, name);
        return true;
      } catch (e) {
        setError(t.app.saveFailed(errorText(e)));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [engine, ask, commit, t],
  );

  const closeTab = useCallback(
    async (id: number) => {
      if (organizeRef.current) return;
      const s = tabsRef.current;
      const tab = s.tabs.find((x) => x.id === id);
      if (!tab || (!tab.doc && s.tabs.length === 1)) return;
      if (tab.doc?.dirty) {
        activate(id);
        const answer = await ask({
          title: t.app.unsavedTitle,
          message: <p>{t.app.unsavedMessage(<strong>{tab.doc.name}</strong>)}</p>,
          options: [
            { value: "cancel", label: t.common.cancel },
            { value: "discard", label: t.common.dontSave },
            { value: "save", label: t.common.save, kind: "primary" },
          ],
        });
        if (answer === "cancel") return;
        if (answer === "save" && !(await saveDoc(id, false))) return;
      }
      const doc = tabsRef.current.tabs.find((x) => x.id === id)?.doc;
      if (doc) void engine.close(doc.info.docId);
      commit((cur) => removeTab(cur, id));
    },
    [engine, ask, activate, saveDoc, commit, t],
  );

  /** Annotations or form fields of a document were changed. */
  const markEdited = useCallback(
    (tabId: number) =>
      commit((s) => {
        const d = s.tabs.find((x) => x.id === tabId)?.doc;
        return d && !d.dirty ? setTabDoc(s, tabId, (cur) => ({ ...cur, dirty: true })) : s;
      }),
    [commit],
  );

  /** The protection of a document changed, or its restrictions were lifted with the permissions password. */
  const updateSecurity = useCallback(
    (tabId: number, docId: number, security: SecurityInfo) =>
      commit((s) => setTabDoc(s, tabId, (cur) => (cur.info.docId === docId ? { ...cur, security } : cur))),
    [commit],
  );

  /** Something was blacked out in a document. */
  const markRedacted = useCallback(
    (tabId: number) =>
      commit((s) => {
        const d = s.tabs.find((x) => x.id === tabId)?.doc;
        return d && !d.redacted ? setTabDoc(s, tabId, (cur) => ({ ...cur, dirty: true, redacted: true })) : s;
      }),
    [commit],
  );

  // ---------- Organizing pages ----------

  /**
   * Pages of a secured document may go into another one only when its author allows
   * organizing pages and copying, or with its permissions password. False = not allowed.
   */
  const unlockPages = useCallback(
    async (docId: number, name: string) => {
      let security = await engine.security(docId);
      let wrong = false;
      while (!(security.rights.assemble && security.rights.copy)) {
        const password = await askPassword(name, wrong, "permissions");
        if (password === null) return false;
        try {
          security = await engine.unlock(docId, password);
        } catch (e) {
          if (!(e instanceof EngineError && e.code === "PASSWORD_WRONG")) throw e;
          wrong = true;
        }
      }
      return true;
    },
    [engine, askPassword],
  );

  /** Opens files as page sources for the organizer. Reports errors and skips failed files. */
  const openSources = useCallback(
    async (files: OpenedFile[]) => {
      const opened: { info: DocInfo; file: OpenedFile }[] = [];
      const failed: string[] = [];
      for (const file of files) {
        let info: DocInfo | null = null;
        try {
          info = await openInEngine(file);
          if (!info) continue;
          if (!info.isPdf) {
            void engine.close(info.docId);
            failed.push(t.app.notPdf(file.name));
            continue;
          }
          if (!(await unlockPages(info.docId, file.name))) {
            void engine.close(info.docId);
            failed.push(t.restrictions.pagesLocked(file.name));
            continue;
          }
          opened.push({ info, file });
        } catch (e) {
          if (info) void engine.close(info.docId);
          failed.push(`${file.name}: ${errorText(e)}`);
        }
      }
      if (failed.length) setError(t.app.someFailed(failed.join("; ")));
      return opened;
    },
    [engine, openInEngine, unlockPages, t],
  );

  const startOrganize = useCallback(() => {
    const tab = tabsRef.current.tabs.find((x) => x.id === tabsRef.current.activeId);
    const d = tab?.doc;
    if (!tab || !d?.info.isPdf || !d.security.rights.assemble) return;
    setOrganize({
      id: Date.now(),
      tabId: tab.id,
      sources: [{ docId: d.info.docId, name: d.name, path: d.path, owned: false }],
      pages: pagesFromDoc(d.info),
      isNew: false,
      title: d.name,
      baseName: stem(d.name),
      baseDir: d.dir,
    });
  }, []);

  const startMerge = useCallback(async () => {
    try {
      const files = await openFilesDialog(t.app.mergeDialogTitle);
      if (!files.length) return;
      setLoading(true);
      const opened = await openSources(files);
      setLoading(false);
      if (!opened.length) return;
      const firstPath = opened.find((o) => o.file.path)?.file.path;
      setOrganize({
        id: Date.now(),
        tabId: null,
        sources: opened.map(({ info, file }) => ({ docId: info.docId, name: file.name, path: file.path, owned: true })),
        pages: opened.flatMap((o) => pagesFromDoc(o.info)),
        isNew: true,
        title: t.app.mergeTitle,
        baseName: opened.length === 1 ? stem(opened[0].file.name) : t.app.mergedName,
        baseDir: firstPath ? dirname(firstPath) : undefined,
      });
    } catch (e) {
      setLoading(false);
      setError(errorText(e));
    }
  }, [openSources, t]);

  const endOrganize = useCallback(
    (owned: number[]) => {
      for (const id of owned) void engine.close(id);
      setOrganize(null);
      setOrganizeDirty(false);
    },
    [engine],
  );

  /** Applies the organizer's changes: builds the new PDF and shows it. Returns true on success. */
  const applyOrganize = useCallback(
    async (result: OrganizeResult, opts: { save?: boolean } = {}): Promise<boolean> => {
      const session = organizeRef.current;
      if (!session) return false;
      const tab = session.tabId !== null ? tabsRef.current.tabs.find((x) => x.id === session.tabId) : undefined;
      const old = tab?.doc ?? null;
      if (!result.changed) {
        endOrganize(result.owned);
        return opts.save && tab && old?.dirty ? saveDoc(tab.id, false) : true;
      }
      setBusy(t.app.composing);
      let targetId: number;
      try {
        const info = await engine.compose(result.pages, result.base);
        const next: OpenDoc = {
          info,
          security: await engine.security(info.docId),
          name: old ? old.name : `${session.baseName}.pdf`,
          path: old?.path,
          dir: old?.dir ?? session.baseDir,
          dirty: true,
        };
        if (tab && old) {
          void engine.close(old.info.docId);
          commit((s) => setTabDoc(s, tab.id, () => next));
          targetId = tab.id;
        } else {
          let id = 0;
          commit((s) => {
            const [placed, placedId] = placeDoc(s, next);
            id = placedId;
            return placed;
          });
          targetId = id;
        }
        endOrganize(result.owned);
      } catch (e) {
        setError(t.app.applyFailed(errorText(e)));
        return false;
      } finally {
        setBusy(null);
      }
      return opts.save ? saveDoc(targetId, false) : true;
    },
    [engine, endOrganize, saveDoc, commit, t],
  );

  const cancelOrganize = useCallback(
    async (result: OrganizeResult) => {
      if (result.changed) {
        const answer = await ask({
          title: t.app.discardTitle,
          message: <p>{t.app.discardMessage}</p>,
          options: [
            { value: "cancel", label: t.app.keepEditing },
            { value: "discard", label: t.app.discard, kind: "danger" },
          ],
        });
        if (answer !== "discard") return;
      }
      endOrganize(result.owned);
    },
    [ask, endOrganize, t],
  );

  // ---------- Unsaved changes when the window closes ----------

  const hasUnsaved = tabs.some((x) => x.doc?.dirty) || (!!organize && organizeDirty);
  useEffect(() => {
    if (!hasUnsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (allowClose.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsaved]);

  // Desktop: the user chose "Save" in the dialog shown when closing the window.
  useEffect(
    () =>
      onSaveAndClose(async () => {
        const result = organizeRef.current ? organizerRef.current?.result() : null;
        if (result && !(await applyOrganize(result, { save: true }))) return;
        for (const tab of tabsRef.current.tabs) {
          if (!tab.doc?.dirty) continue;
          activate(tab.id);
          if (!(await saveDoc(tab.id, false))) return;
        }
        allowClose.current = true;
        window.close();
      }),
    [applyOrganize, saveDoc, activate],
  );

  useEffect(() => {
    const doc = activeTab.doc;
    if (organize) document.title = `${t.app.organizeWindowTitle(organize.title)} – Scamcrobat`;
    else document.title = doc ? `${doc.dirty ? "• " : ""}${doc.name} – Scamcrobat` : "Scamcrobat";
  }, [activeTab, organize, t]);

  // ---------- Dropping files into the window ----------

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      // While organizing, the grid itself shows where the pages go.
      if (!organizeRef.current) setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      if (organizeRef.current) {
        organizerRef.current?.insertFiles(await Promise.all(files.map(fileFromDrop)));
        return;
      }
      const pdfs = files.filter((f) => isPdfName(f.name) || f.type === "application/pdf");
      // Other formats MuPDF can show (XPS, EPUB, images) open one at a time.
      const chosen = pdfs.length ? pdfs : files.slice(0, 1);
      await openFilesRef.current(await Promise.all(chosen.map(fileFromDrop)));
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // ---------- Window-wide keyboard shortcuts ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The organizer has its own shortcuts; dialogs come first.
      if (organizeRef.current || document.querySelector(".modal-backdrop")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const s = tabsRef.current;
      const current = s.tabs.find((x) => x.id === s.activeId);
      if (ctrl && key === "o") {
        e.preventDefault();
        void openDialog();
      } else if (ctrl && key === "s") {
        e.preventDefault();
        if (current?.doc && !busy) void saveDoc(current.id, e.shiftKey);
      } else if (ctrl && (key === "w" || key === "f4")) {
        e.preventDefault();
        if (current) void closeTab(current.id);
      } else if (ctrl && key === "t") {
        e.preventDefault();
        commit(startTab);
      } else if (ctrl && key === "tab") {
        e.preventDefault();
        commit((st) => cycleTab(st, e.shiftKey ? -1 : 1));
      } else if (ctrl && (key === "pagedown" || key === "pageup")) {
        e.preventDefault();
        commit((st) => cycleTab(st, key === "pagedown" ? 1 : -1));
      } else if (ctrl && key === "p" && !current?.doc) {
        e.preventDefault(); // nothing to print on the start page
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openDialog, saveDoc, closeTab, commit, busy]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "1" : "0");
    } catch {
      /* not critical */
    }
  }, [sidebarOpen]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  const toggleSidebar = useCallback(() => setSidebarOpen((o) => !o), []);
  const openDialogCb = useCallback(() => void openDialog(), [openDialog]);
  const showTabBar = tabs.some((x) => x.doc) || tabs.length > 1;

  // ---------- Rendering ----------

  return (
    <div className="app">
      {showTabBar && (
        <TabBar
          tabs={tabs}
          activeId={activeTab.id}
          disabled={!!organize}
          onActivate={activate}
          onClose={(id) => void closeTab(id)}
          onNew={() => commit(startTab)}
        />
      )}

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button className="btn small" onClick={() => setError(null)}>
            {t.common.close}
          </button>
        </div>
      )}

      <div className="stage">
        {tabs.map((tab) =>
          tab.doc ? (
            <DocView
              key={`${tab.id}:${tab.doc.info.docId}`}
              engine={engine}
              doc={tab.doc}
              active={tab.id === activeTab.id && !organize}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={toggleSidebar}
              onOpen={openDialogCb}
              onSave={(asNew) => void saveDoc(tab.id, asNew)}
              onOrganize={startOrganize}
              onEdited={() => markEdited(tab.id)}
              onRedacted={() => markRedacted(tab.id)}
              onSecurity={(security) => updateSecurity(tab.id, tab.doc!.info.docId, security)}
              onToast={setToast}
              onError={setError}
            />
          ) : (
            <StartView
              key={tab.id}
              active={tab.id === activeTab.id && !organize}
              loading={loading}
              sidebarOpen={sidebarOpen}
              onOpen={openDialogCb}
              onMerge={() => void startMerge()}
              onOpenRecent={(path, name) => void openRecent(path, name)}
            />
          ),
        )}

        {organize && (
          <Organizer
            key={organize.id}
            ref={organizerRef}
            engine={engine}
            sources={organize.sources}
            pages={organize.pages}
            isNew={organize.isNew}
            baseName={organize.baseName}
            baseDir={organize.baseDir}
            openSources={openSources}
            onApply={(r, o) => void applyOrganize(r, o)}
            onCancel={(r) => void cancelOrganize(r)}
            onDirtyChange={setOrganizeDirty}
            onToast={setToast}
            onError={setError}
          />
        )}
      </div>

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <FileUp size={40} />
            <p>{t.app.dropToOpen}</p>
          </div>
        </div>
      )}

      {busy && (
        <div className="busy-overlay">
          <div className="busy-card">
            <LoaderCircle size={20} className="spin" />
            {busy}
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      {passwordAsk && (
        <PasswordDialog
          key={`${passwordAsk.kind}:${passwordAsk.name}:${passwordAsk.wrong}`}
          fileName={passwordAsk.name}
          wrong={passwordAsk.wrong}
          kind={passwordAsk.kind}
          onSubmit={(p) => {
            setPasswordAsk(null);
            passwordAsk.resolve(p);
          }}
          onClose={() => {
            setPasswordAsk(null);
            passwordAsk.resolve(null);
          }}
        />
      )}

      {choice && (
        <ChoiceDialog
          request={choice}
          onChoose={(value) => {
            setChoice(null);
            choice.resolve(value);
          }}
        />
      )}
    </div>
  );
}
