/**
 * One open document: toolbar, page panel and viewer with its own zoom, page, search
 * and selection. Every tab keeps its DocView mounted, so switching tabs keeps the
 * scroll position; inactive tabs are hidden and release their rendered pages.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PdfEngine } from "./engine/engine";
import type { SearchHit, TextSelection } from "./engine/types";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { ExportDialog } from "./export/ExportDialog";
import { PrintDialog } from "./print/PrintDialog";
import { Viewer, type ViewerHandle } from "./viewer/Viewer";
import { clampScale, CSS_PX_PER_PT_AT_100, fitScale, nextZoomStep, percentToScale } from "./viewer/layout";
import { copyToClipboard } from "./clipboard";
import { errorText } from "./errors";
import { useT } from "./i18n";
import type { OpenDoc } from "./tabs";

type FitMode = "width" | "page" | null;

interface SearchState {
  query: string;
  hits: SearchHit[];
  active: number;
  done: boolean;
  busy: boolean;
}

const NO_SEARCH: SearchState = { query: "", hits: [], active: 0, done: false, busy: false };

interface Props {
  engine: PdfEngine;
  doc: OpenDoc;
  active: boolean;
  sidebarOpen: boolean;
  onToggleSidebar(): void;
  onOpen(): void;
  onSave(asNew: boolean): void;
  onOrganize(): void;
  onToast(message: string): void;
  onError(message: string): void;
}

export function DocView(props: Props) {
  const { engine, doc, active, onToggleSidebar, onToast, onError } = props;
  const info = doc.info;
  const t = useT();
  const viewerRef = useRef<ViewerHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [fit, setFit] = useState<FitMode>("width");
  const [scale, setScale] = useState(CSS_PX_PER_PT_AT_100);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [currentPage, setCurrentPage] = useState(0);
  const [search, setSearch] = useState<SearchState>(NO_SEARCH);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [dialog, setDialog] = useState<"export" | "print" | null>(null);
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;

  // A newly activated tab takes the keyboard (arrows, Page Down…).
  useEffect(() => {
    if (active) requestAnimationFrame(() => viewerRef.current?.focus());
  }, [active]);

  // ---------- Zoom ----------

  useEffect(() => {
    if (!fit || !viewport.width) return;
    setScale(fitScale(info.pages, fit, viewport.width, viewport.height, currentPageRef.current));
  }, [info, fit, viewport]);

  const zoomTo = useCallback((s: number) => {
    setFit(null);
    setScale(clampScale(s));
  }, []);
  const zoomStep = useCallback((dir: 1 | -1) => {
    setFit(null);
    setScale((s) => nextZoomStep(s, dir));
  }, []);
  const onViewport = useCallback((width: number, height: number) => setViewport({ width, height }), []);

  const goToPage = useCallback((i: number) => viewerRef.current?.goToPage(i), []);

  // ---------- Search ----------

  const runSearch = useCallback(
    async (query: string, dir: 1 | -1) => {
      if (!query) return;
      if (query === search.query && search.done) {
        if (!search.hits.length) return;
        const n = search.hits.length;
        setSearch({ ...search, active: (search.active + dir + n) % n });
        return;
      }
      setSearch({ ...NO_SEARCH, query, busy: true });
      try {
        const hits = await engine.search(info.docId, query);
        const from = currentPageRef.current;
        const first = Math.max(0, hits.findIndex((h) => h.page >= from));
        setSearch({ query, hits, active: first, done: true, busy: false });
      } catch (e) {
        setSearch(NO_SEARCH);
        onError(t.app.searchFailed(errorText(e)));
      }
    },
    [engine, info.docId, search, onError, t],
  );

  useEffect(() => {
    const hit = search.hits[search.active];
    if (hit) viewerRef.current?.revealHit(hit);
  }, [search.hits, search.active]);

  // ---------- Keyboard shortcuts (only the active tab) ----------

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      // Dialogs keep the keys for themselves.
      if (document.querySelector(".modal-backdrop")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const key = e.key.toLowerCase();
      if (ctrl && key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (ctrl && key === "e") {
        e.preventDefault();
        setDialog("export");
      } else if (ctrl && key === "p") {
        e.preventDefault();
        setDialog("print");
      } else if (ctrl && key === "c" && !inInput && selection?.text) {
        e.preventDefault();
        copyToClipboard(selection.text).then(
          () => onToast(t.app.copied),
          () => onError(t.app.copyFailed),
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
      } else if (key === "f4" && !ctrl) {
        e.preventDefault();
        onToggleSidebar();
      } else if (key === "escape" && !inInput) {
        setSelection(null);
      } else if (!inInput && !ctrl && (key === "arrowleft" || key === "arrowright")) {
        if (info.pageCount > 1 && fit === "page") {
          e.preventDefault();
          goToPage(currentPageRef.current + (key === "arrowright" ? 1 : -1));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selection, search.query, runSearch, fit, info.pageCount, zoomStep, zoomTo, goToPage, onToggleSidebar, onToast, onError, t]);

  const closeDialog = useCallback(() => {
    setDialog(null);
    viewerRef.current?.focus();
  }, []);

  return (
    <section className={active ? "doc-view" : "doc-view inactive"} inert={!active}>
      <Toolbar
        hasDoc
        dirty={doc.dirty}
        canOrganize={info.isPdf}
        pageCount={info.pageCount}
        currentPage={currentPage}
        scale={scale}
        fit={fit}
        sidebarOpen={props.sidebarOpen}
        searchRef={searchRef}
        searchInfo={{
          query: search.query,
          count: search.hits.length,
          active: search.active,
          done: search.done,
          busy: search.busy,
        }}
        onOpen={props.onOpen}
        onSave={() => props.onSave(false)}
        onSaveAs={() => props.onSave(true)}
        onPrint={() => setDialog("print")}
        onOrganize={props.onOrganize}
        onToggleSidebar={onToggleSidebar}
        onGoToPage={goToPage}
        onZoomStep={zoomStep}
        onZoomPercent={(p) => zoomTo(percentToScale(p))}
        onFit={setFit}
        onSearch={runSearch}
        onSearchClear={() => setSearch(NO_SEARCH)}
        onExport={() => setDialog("export")}
      />

      <main className="workspace">
        {props.sidebarOpen && (
          <Sidebar engine={engine} doc={info} currentPage={currentPage} onGoToPage={goToPage} />
        )}
        <Viewer
          ref={viewerRef}
          engine={engine}
          doc={info}
          active={active}
          scale={scale}
          hits={search.hits}
          activeHit={search.active}
          selection={selection}
          onSelection={setSelection}
          onViewport={onViewport}
          onCurrentPage={setCurrentPage}
          onZoom={zoomTo}
        />
      </main>

      {active && dialog === "export" && (
        <ExportDialog
          engine={engine}
          doc={info}
          fileName={doc.name}
          defaultDir={doc.dir}
          currentPage={currentPage}
          onClose={closeDialog}
        />
      )}
      {active && dialog === "print" && (
        <PrintDialog engine={engine} doc={info} currentPage={currentPage} onClose={closeDialog} />
      )}
    </section>
  );
}
