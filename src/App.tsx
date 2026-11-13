import { useCallback, useEffect, useRef, useState } from "react";
import { Combine, FileUp, FolderOpen, LoaderCircle, Lock } from "lucide-react";
import { PdfEngine } from "./engine/engine";
import { EngineError, type DocInfo, type SearchHit, type TextSelection } from "./engine/types";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { Modal } from "./components/Modal";
import { ChoiceDialog, type ChoiceRequest } from "./components/ChoiceDialog";
import { ExportDialog } from "./export/ExportDialog";
import { Organizer, type OrganizeResult, type OrganizerHandle } from "./organize/Organizer";
import { pagesFromDoc, type OrgPage, type OrgSource } from "./organize/model";
import { Viewer, type ViewerHandle } from "./viewer/Viewer";
import { clampScale, CSS_PX_PER_PT_AT_100, fitScale, nextZoomStep, percentToScale } from "./viewer/layout";
import {
  dirname,
  fileFromDrop,
  getInitialFile,
  isDesktop,
  onSaveAndClose,
  openFileDialog,
  openFilesDialog,
  savePdf,
  savePdfAs,
  type OpenedFile,
} from "./platform";
import { copyToClipboard } from "./clipboard";

interface OpenDoc {
  info: DocInfo;
  name: string;
  /** Cesta k souboru na disku (jen desktop) – kam se ukládá */
  path?: string;
  /** Výchozí složka pro dialogy Uložit jako / Export */
  dir?: string;
  /** Dokument má neuložené změny */
  dirty: boolean;
}

interface OrganizeSession {
  id: number;
  sources: OrgSource[];
  pages: OrgPage[];
  isNew: boolean;
  title: string;
  baseName: string;
  baseDir?: string;
}

type FitMode = "width" | "page" | null;

interface SearchState {
  query: string;
  hits: SearchHit[];
  active: number;
  done: boolean;
  busy: boolean;
}

const NO_SEARCH: SearchState = { query: "", hits: [], active: 0, done: false, busy: false };
const SIDEBAR_KEY = "scamcrobat.sidebar";
const stem = (name: string) => name.replace(/\.pdf$/i, "");
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readSidebarPref() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "0";
  } catch {
    return true;
  }
}

// Jedno PDF jádro (Web Worker) pro celé okno.
let sharedEngine: PdfEngine | null = null;
const getEngine = () => (sharedEngine ??= new PdfEngine());

export function App() {
  const [engine] = useState(getEngine);
  if (import.meta.env.DEV) (window as unknown as { __engine: PdfEngine }).__engine = engine;
  const viewerRef = useRef<ViewerHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const organizerRef = useRef<OrganizerHandle>(null);

  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [passwordAsk, setPasswordAsk] = useState<{
    name: string;
    wrong: boolean;
    resolve(value: string | null): void;
  } | null>(null);
  const [choice, setChoice] = useState<(ChoiceRequest & { resolve(value: string): void }) | null>(null);
  const [fit, setFit] = useState<FitMode>("width");
  const [scale, setScale] = useState(CSS_PX_PER_PT_AT_100);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [currentPage, setCurrentPage] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarPref);
  const [search, setSearch] = useState<SearchState>(NO_SEARCH);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [organize, setOrganize] = useState<OrganizeSession | null>(null);
  const [organizeDirty, setOrganizeDirty] = useState(false);

  const docRef = useRef(doc);
  docRef.current = doc;
  const organizeRef = useRef(organize);
  organizeRef.current = organize;
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  /** Po uložení při zavírání okna už beforeunload nesmí zavření blokovat. */
  const allowClose = useRef(false);

  // ---------- Dialogy jako sliby ----------

  const ask = useCallback(
    (request: ChoiceRequest) => new Promise<string>((resolve) => setChoice({ ...request, resolve })),
    [],
  );

  const askPassword = useCallback(
    (name: string, wrong: boolean) =>
      new Promise<string | null>((resolve) => setPasswordAsk({ name, wrong, resolve })),
    [],
  );

  // ---------- Otevírání dokumentů ----------

  /** Otevře soubor v jádře; u zaheslovaných se ptá na heslo. Vrací null, když uživatel zruší. */
  const openInEngine = useCallback(
    async (file: OpenedFile): Promise<DocInfo | null> => {
      let password: string | undefined;
      for (;;) {
        try {
          // Kopie dat: originál si necháváme pro případný další pokus s heslem.
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

  const showDoc = useCallback((d: OpenDoc) => {
    setDoc(d);
    setCurrentPage(0);
    setSearch(NO_SEARCH);
    setSelection(null);
    setExportOpen(false);
    setFit("width");
    requestAnimationFrame(() => viewerRef.current?.focus());
  }, []);

  // ---------- Ukládání ----------

  const saveDoc = useCallback(
    async (asNew: boolean, target?: OpenDoc): Promise<boolean> => {
      const d = target ?? docRef.current;
      if (!d) return false;
      try {
        const data = await engine.getBytes(d.info.docId);
        let { name, path } = d;
        if (!asNew && path && isDesktop) {
          setBusy("Ukládám…");
          await savePdf(path, data);
        } else {
          const suggested = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
          const saved = await savePdfAs(data, suggested, d.dir);
          if (!saved) return false;
          name = saved.name;
          path = saved.path;
        }
        setDoc((cur) =>
          cur && cur.info.docId === d.info.docId
            ? { ...cur, name, path, dir: path ? dirname(path) : cur.dir, dirty: false }
            : cur,
        );
        setToast(`Uloženo – ${name}`);
        return true;
      } catch (e) {
        setError(`Uložení se nepovedlo: ${errorText(e)}`);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [engine],
  );

  /** Před zahozením dokumentu s neuloženými změnami se zeptá. Vrací true = pokračovat. */
  const confirmDiscard = useCallback(async (): Promise<boolean> => {
    const d = docRef.current;
    if (!d?.dirty) return true;
    const answer = await ask({
      title: "Neuložené změny",
      message: (
        <p>
          Dokument <strong>{d.name}</strong> má neuložené změny. Chcete je uložit?
        </p>
      ),
      options: [
        { value: "cancel", label: "Zrušit" },
        { value: "discard", label: "Neukládat" },
        { value: "save", label: "Uložit", kind: "primary" },
      ],
    });
    if (answer === "save") return saveDoc(false);
    return answer === "discard";
  }, [ask, saveDoc]);

  const openFile = useCallback(
    async (file: OpenedFile, skipConfirm = false) => {
      if (!skipConfirm && !(await confirmDiscard())) return;
      setLoading(true);
      setError(null);
      try {
        const info = await openInEngine(file);
        if (!info) return;
        const old = docRef.current;
        if (old) void engine.close(old.info.docId);
        showDoc({ info, name: file.name, path: file.path, dir: file.path ? dirname(file.path) : undefined, dirty: false });
      } catch (e) {
        setError(`Soubor „${file.name}“ se nepodařilo otevřít: ${errorText(e)}`);
      } finally {
        setLoading(false);
      }
    },
    [engine, openInEngine, confirmDiscard, showDoc],
  );

  const openDialog = useCallback(async () => {
    try {
      if (!(await confirmDiscard())) return;
      const file = await openFileDialog();
      if (file) await openFile(file, true);
    } catch (e) {
      setError(errorText(e));
    }
  }, [openFile, confirmDiscard]);

  // Soubor předaný při spuštění (dvojklik na PDF ve Windows).
  useEffect(() => {
    getInitialFile()
      .then((f) => f && openFile(f, true))
      .catch((e) => setError(String(e)));
  }, [openFile]);

  // ---------- Uspořádání stránek ----------

  /** Otevře soubory jako zdroje stránek pro organizér. Chyby hlásí, nepovedené soubory přeskočí. */
  const openSources = useCallback(
    async (files: OpenedFile[]) => {
      const opened: { info: DocInfo; file: OpenedFile }[] = [];
      const failed: string[] = [];
      for (const file of files) {
        try {
          const info = await openInEngine(file);
          if (!info) continue;
          if (!info.isPdf) {
            void engine.close(info.docId);
            failed.push(`„${file.name}“ není PDF`);
            continue;
          }
          opened.push({ info, file });
        } catch (e) {
          failed.push(`„${file.name}“: ${errorText(e)}`);
        }
      }
      if (failed.length) setError(`Některé soubory nešlo načíst – ${failed.join("; ")}`);
      return opened;
    },
    [engine, openInEngine],
  );

  const startOrganize = useCallback(() => {
    const d = docRef.current;
    if (!d?.info.isPdf) return;
    setSelection(null);
    setExportOpen(false);
    setOrganize({
      id: Date.now(),
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
      const files = await openFilesDialog("Vyberte PDF soubory ke sloučení");
      if (!files.length) return;
      setLoading(true);
      const opened = await openSources(files);
      setLoading(false);
      if (!opened.length) return;
      const firstPath = opened.find((o) => o.file.path)?.file.path;
      setOrganize({
        id: Date.now(),
        sources: opened.map(({ info, file }) => ({ docId: info.docId, name: file.name, path: file.path, owned: true })),
        pages: opened.flatMap((o) => pagesFromDoc(o.info)),
        isNew: true,
        title: "Sloučení PDF",
        baseName: opened.length === 1 ? stem(opened[0].file.name) : "Sloučený dokument",
        baseDir: firstPath ? dirname(firstPath) : undefined,
      });
    } catch (e) {
      setLoading(false);
      setError(errorText(e));
    }
  }, [openSources]);

  const endOrganize = useCallback(
    (owned: number[]) => {
      for (const id of owned) void engine.close(id);
      setOrganize(null);
      setOrganizeDirty(false);
      requestAnimationFrame(() => viewerRef.current?.focus());
    },
    [engine],
  );

  /** Použije změny z organizéru: sestaví nové PDF a zobrazí ho. Vrací true při úspěchu. */
  const applyOrganize = useCallback(
    async (result: OrganizeResult, opts: { save?: boolean } = {}): Promise<boolean> => {
      const session = organizeRef.current;
      if (!session) return false;
      const old = docRef.current;
      if (!result.changed) {
        endOrganize(result.owned);
        return opts.save && old?.dirty ? saveDoc(false, old) : true;
      }
      setBusy("Sestavuji dokument…");
      let next: OpenDoc;
      try {
        const info = await engine.compose(result.pages, result.base);
        if (old) void engine.close(old.info.docId);
        next = {
          info,
          name: old ? old.name : `${session.baseName}.pdf`,
          path: old?.path,
          dir: old?.dir ?? session.baseDir,
          dirty: true,
        };
        endOrganize(result.owned);
        showDoc(next);
      } catch (e) {
        setError(`Úpravy se nepodařilo použít: ${errorText(e)}`);
        return false;
      } finally {
        setBusy(null);
      }
      return opts.save ? saveDoc(false, next) : true;
    },
    [engine, endOrganize, showDoc, saveDoc],
  );

  const cancelOrganize = useCallback(
    async (result: OrganizeResult) => {
      if (result.changed) {
        const answer = await ask({
          title: "Zahodit úpravy?",
          message: <p>Změny v uspořádání stránek se neuloží.</p>,
          options: [
            { value: "cancel", label: "Pokračovat v úpravách" },
            { value: "discard", label: "Zahodit", kind: "danger" },
          ],
        });
        if (answer !== "discard") return;
      }
      endOrganize(result.owned);
    },
    [ask, endOrganize],
  );

  // ---------- Neuložené změny při zavírání okna ----------

  const hasUnsaved = !!doc?.dirty || (!!organize && organizeDirty);
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

  // Desktop: uživatel v dialogu při zavírání okna zvolil „Uložit“.
  useEffect(
    () =>
      onSaveAndClose(async () => {
        const result = organizeRef.current ? organizerRef.current?.result() : null;
        const ok = result ? await applyOrganize(result, { save: true }) : await saveDoc(false);
        if (ok) {
          allowClose.current = true;
          window.close();
        }
      }),
    [applyOrganize, saveDoc],
  );

  useEffect(() => {
    if (organize) document.title = `Uspořádat stránky – ${organize.title} – Scamcrobat`;
    else document.title = doc ? `${doc.dirty ? "• " : ""}${doc.name} – Scamcrobat` : "Scamcrobat";
  }, [doc, organize]);

  // ---------- Přetažení souboru do okna ----------

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      // V režimu uspořádání ukazuje místo vložení přímo mřížka.
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
      const file = files.find((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf") ?? files[0];
      await openFile(await fileFromDrop(file));
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
  }, [openFile]);

  // ---------- Zoom ----------

  useEffect(() => {
    if (!doc || !fit || !viewport.width) return;
    setScale(fitScale(doc.info.pages, fit, viewport.width, viewport.height, currentPageRef.current));
  }, [doc?.info, fit, viewport]);

  const zoomTo = useCallback((s: number) => {
    setFit(null);
    setScale(clampScale(s));
  }, []);
  const zoomStep = useCallback((dir: 1 | -1) => {
    setFit(null);
    setScale((s) => nextZoomStep(s, dir));
  }, []);
  const onViewport = useCallback((width: number, height: number) => setViewport({ width, height }), []);

  // ---------- Navigace ----------

  const goToPage = useCallback((i: number) => viewerRef.current?.goToPage(i), []);

  // ---------- Hledání ----------

  const runSearch = useCallback(
    async (query: string, dir: 1 | -1) => {
      const d = docRef.current;
      if (!d || !query) return;
      if (query === search.query && search.done) {
        if (!search.hits.length) return;
        const n = search.hits.length;
        setSearch({ ...search, active: (search.active + dir + n) % n });
        return;
      }
      setSearch({ ...NO_SEARCH, query, busy: true });
      try {
        const hits = await engine.search(d.info.docId, query);
        if (docRef.current?.info !== d.info) return;
        const from = currentPageRef.current;
        const first = Math.max(0, hits.findIndex((h) => h.page >= from));
        setSearch({ query, hits, active: first, done: true, busy: false });
      } catch (e) {
        setSearch(NO_SEARCH);
        setError(`Hledání selhalo: ${errorText(e)}`);
      }
    },
    [engine, search],
  );

  useEffect(() => {
    const hit = search.hits[search.active];
    if (hit) viewerRef.current?.revealHit(hit);
  }, [search.hits, search.active]);

  // ---------- Klávesové zkratky ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // V režimu uspořádání má vlastní zkratky organizér; dialogy mají přednost.
      if (organizeRef.current || choice || passwordAsk) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const key = e.key.toLowerCase();
      if (ctrl && key === "o") {
        e.preventDefault();
        void openDialog();
      } else if (ctrl && key === "s") {
        e.preventDefault();
        if (docRef.current && !busy) void saveDoc(e.shiftKey);
      } else if (!docRef.current) {
        return;
      } else if (ctrl && key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (ctrl && key === "e") {
        e.preventDefault();
        setExportOpen(true);
      } else if (ctrl && key === "c" && !inInput && selection?.text) {
        e.preventDefault();
        copyToClipboard(selection.text).then(
          () => setToast("Text zkopírován"),
          () => setError("Do schránky se nepodařilo zapsat"),
        );
      } else if (ctrl && (key === "+" || key === "=" || e.code === "NumpadAdd")) {
        e.preventDefault();
        zoomStep(1);
      } else if (ctrl && (key === "-" || e.code === "NumpadSubtract")) {
        e.preventDefault();
        zoomStep(-1);
      } else if (ctrl && key === "0") {
        e.preventDefault();
        setFit("page");
      } else if (ctrl && key === "1") {
        e.preventDefault();
        zoomTo(percentToScale(100));
      } else if (ctrl && key === "2") {
        e.preventDefault();
        setFit("width");
      } else if (key === "f3" && search.query) {
        e.preventDefault();
        void runSearch(search.query, e.shiftKey ? -1 : 1);
      } else if (key === "f4") {
        e.preventDefault();
        setSidebarOpen((o) => !o);
      } else if (key === "escape" && !inInput) {
        setSelection(null);
      } else if (!inInput && !ctrl && (key === "arrowleft" || key === "arrowright")) {
        const d = docRef.current;
        if (d && d.info.pageCount > 1 && fit === "page") {
          e.preventDefault();
          goToPage(currentPageRef.current + (key === "arrowright" ? 1 : -1));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openDialog, saveDoc, busy, choice, passwordAsk, selection, zoomStep, zoomTo, search.query, runSearch, fit, goToPage]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "1" : "0");
    } catch {
      /* nevadí */
    }
  }, [sidebarOpen]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  // ---------- Vykreslení ----------

  const info = doc?.info;

  return (
    <div className="app">
      {!organize && (
        <Toolbar
          docKey={info?.docId ?? 0}
          hasDoc={!!info}
          dirty={!!doc?.dirty}
          canOrganize={!!info?.isPdf}
          pageCount={info?.pageCount ?? 0}
          currentPage={currentPage}
          scale={scale}
          fit={fit}
          sidebarOpen={sidebarOpen}
          searchRef={searchRef}
          searchInfo={{
            query: search.query,
            count: search.hits.length,
            active: search.active,
            done: search.done,
            busy: search.busy,
          }}
          onOpen={openDialog}
          onSave={() => void saveDoc(false)}
          onSaveAs={() => void saveDoc(true)}
          onOrganize={startOrganize}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          onGoToPage={goToPage}
          onZoomStep={zoomStep}
          onZoomPercent={(p) => zoomTo(percentToScale(p))}
          onFit={setFit}
          onSearch={runSearch}
          onSearchClear={() => setSearch(NO_SEARCH)}
          onExport={() => setExportOpen(true)}
        />
      )}

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button className="btn small" onClick={() => setError(null)}>
            Zavřít
          </button>
        </div>
      )}

      <main className="workspace">
        {organize ? (
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
        ) : (
          <>
            {info && sidebarOpen && (
              <Sidebar engine={engine} doc={info} currentPage={currentPage} onGoToPage={goToPage} />
            )}
            {info ? (
              <Viewer
                ref={viewerRef}
                engine={engine}
                doc={info}
                scale={scale}
                hits={search.hits}
                activeHit={search.active}
                selection={selection}
                onSelection={setSelection}
                onViewport={onViewport}
                onCurrentPage={setCurrentPage}
                onZoom={zoomTo}
              />
            ) : (
              <EmptyState loading={loading} onOpen={openDialog} onMerge={startMerge} />
            )}
          </>
        )}
      </main>

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <FileUp size={40} />
            <p>Pusťte PDF pro otevření</p>
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

      {exportOpen && doc && !organize && (
        <ExportDialog
          engine={engine}
          doc={doc.info}
          fileName={doc.name}
          defaultDir={doc.dir}
          currentPage={currentPage}
          onClose={() => {
            setExportOpen(false);
            viewerRef.current?.focus();
          }}
        />
      )}

      {passwordAsk && (
        <PasswordDialog
          key={`${passwordAsk.name}:${passwordAsk.wrong}`}
          fileName={passwordAsk.name}
          wrong={passwordAsk.wrong}
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

function EmptyState({ loading, onOpen, onMerge }: { loading: boolean; onOpen(): void; onMerge(): void }) {
  return (
    <div className="empty">
      <div className="empty-card">
        <img src="./logo.svg" alt="" width={72} height={72} />
        <h1>Scamcrobat</h1>
        <p className="muted">Svobodný prohlížeč PDF bez předplatného.</p>
        <button className="btn primary large" onClick={onOpen} disabled={loading}>
          <FolderOpen size={18} /> {loading ? "Otevírám…" : "Otevřít PDF"}
        </button>
        <p className="muted small">nebo soubor přetáhněte sem · Ctrl+O</p>
        <button className="btn empty-secondary" onClick={onMerge} disabled={loading}>
          <Combine size={16} /> Sloučit více PDF do jednoho
        </button>
        {!isDesktop && (
          <p className="muted small">Soubory se nikam neodesílají, vše se zpracovává ve vašem prohlížeči.</p>
        )}
      </div>
    </div>
  );
}

function PasswordDialog(props: { fileName: string; wrong: boolean; onSubmit(password: string): void; onClose(): void }) {
  const [value, setValue] = useState("");
  return (
    <Modal
      title="Dokument je chráněný heslem"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Zrušit
          </button>
          <button className="btn primary" disabled={!value} onClick={() => props.onSubmit(value)}>
            Otevřít
          </button>
        </>
      }
    >
      <div className="password-row">
        <Lock size={20} className="muted" />
        <p>
          Zadejte heslo k souboru <strong>{props.fileName}</strong>.
        </p>
      </div>
      <input
        className={props.wrong ? "input wide invalid" : "input wide"}
        type="password"
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && value && props.onSubmit(value)}
        aria-label="Heslo"
      />
      {props.wrong && <p className="hint error">Nesprávné heslo, zkuste to znovu.</p>}
    </Modal>
  );
}
