/**
 * One open document: toolbar, page panel and viewer with its own zoom, page, search,
 * selection and annotation tools. Every tab keeps its DocView mounted, so switching
 * tabs keeps the scroll position; inactive tabs are hidden and release their rendered pages.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, LockKeyhole, Minimize, X } from "lucide-react";
import type { PdfEngine } from "./engine/engine";
import type {
  AnnotEdit,
  DocRights,
  EditState,
  PageInfo,
  PageMode,
  RedactArea,
  Rect,
  SearchHit,
  SecurityInfo,
  TextLine,
  TextSelection,
} from "./engine/types";
import { AnnotateBar } from "./annotate/AnnotateBar";
import { EditContext, type AnnotRef, type Draft, type EditApi } from "./annotate/context";
import { SignatureDialog } from "./annotate/SignatureDialog";
import { signatureBytes, type Signature } from "./annotate/signatures";
import {
  colorOf,
  fitInto,
  isEditTool,
  loadSettings,
  MARKUP,
  saveSettings,
  type Tool,
  type ToolSettings,
} from "./annotate/tools";
import { ProtectDialog } from "./components/ProtectDialog";
import { CompressDialog } from "./compress/CompressDialog";
import { Toolbar, type BlockableAction } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { ExportDialog } from "./export/ExportDialog";
import { CropDialog } from "./pagetools/CropDialog";
import { PageNumbersDialog } from "./pagetools/PageNumbersDialog";
import { WatermarkDialog } from "./pagetools/WatermarkDialog";
import { PrintDialog } from "./print/PrintDialog";
import { Viewer, type ViewerHandle } from "./viewer/Viewer";
import {
  clampScale,
  CSS_PX_PER_PT_AT_100,
  fitScale,
  nextZoomStep,
  normalizeViewRotation,
  percentToScale,
  rotatePages,
  rowStart,
} from "./viewer/layout";
import { copyToClipboard } from "./clipboard";
import { errorText } from "./errors";
import { useT } from "./i18n";
import { isDesktop } from "./platform";
import { lastPage, rememberPage } from "./recent";
import { isRestricted, type OpenDoc } from "./tabs";

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
  /** The document content was changed (annotations, form fields, text). */
  onEdited(): void;
  /** Something was blacked out (saving it removes the content for good). */
  onRedacted(): void;
  /** The protection changed or the restrictions were lifted with the permissions password. */
  onSecurity(security: SecurityInfo): void;
  /** The page sizes changed (cropping, or undoing it). */
  onPages(pages: PageInfo[]): void;
  /** Full screen started / ended (the window hides everything else). */
  onPresenting(on: boolean): void;
  /** Opens a copy of the document (e.g. the smaller one) in a new tab. */
  onOpenCopy(data: Uint8Array, name: string): void;
  onToast(message: string): void;
  onError(message: string): void;
}

/** Opening links from documents: only web pages and e-mail. */
const SAFE_URI = /^(https?:|mailto:)/i;

/** The rights named in the notice of a secured document, in this order. */
const NOTICE_RIGHTS = ["print", "copy", "modify", "annotate", "fillForms", "assemble"] as const;
const CHANGE_RIGHTS = ["modify", "annotate", "fillForms", "assemble"] as const;

export function DocView(props: Props) {
  const { engine, doc, active, onToggleSidebar, onToast, onError } = props;
  const info = doc.info;
  const t = useT();
  /** What the document's restrictions allow (everything once unlocked) */
  const rights: DocRights = doc.security.rights;
  const viewerRef = useRef<ViewerHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [fit, setFit] = useState<FitMode>("width");
  const [scale, setScale] = useState(CSS_PX_PER_PT_AT_100);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [currentPage, setCurrentPage] = useState(0);
  const [search, setSearch] = useState<SearchState>(NO_SEARCH);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [dialog, setDialog] = useState<
    "export" | "print" | "protect" | "unlock" | "crop" | "watermark" | "pageNumbers" | "compress" | null
  >(null);
  /** Rotation of the view (clockwise); the file stays as it is */
  const [rotation, setRotation] = useState(0);
  /** One page per row, or two side by side (as the document asks for, at first) */
  const [pageMode, setPageMode] = useState<PageMode>(info.pageMode ?? "single");
  /** Full screen */
  const [presenting, setPresenting] = useState(false);
  const presentingRef = useRef(presenting);
  presentingRef.current = presenting;
  /** The box drawn with the crop tool, while the crop dialog is open */
  const [crop, setCrop] = useState<{ page: number; rect: Rect; id: number } | null>(null);
  const [noticeHidden, setNoticeHidden] = useState(false);
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  const selectionRef = useRef(selection);
  const handleSelection = useCallback((sel: TextSelection | null) => {
    selectionRef.current = sel;
    setSelection(sel);
  }, []);

  // ---------- Annotations and forms ----------

  const canEdit = info.isPdf;
  const canAnnotate = canEdit && rights.annotate;
  const canModify = canEdit && rights.modify;
  const canFillForms = canEdit && rights.fillForms;
  /** The second toolbar row: annotation tools, or editing tools (text, redaction) */
  const [bar, setBar] = useState<"annotate" | "edit" | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [settings, setSettingsState] = useState<ToolSettings>(loadSettings);
  const [signature, setSignature] = useState<Signature | null>(null);
  const [selected, setSelected] = useState<AnnotRef | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [history, setHistory] = useState<EditState>({ canUndo: false, canRedo: false });
  const [revs, setRevs] = useState<{ all: number; pages: Record<number, number> }>({ all: 0, pages: {} });
  /** Signature dialog; `field` = a signature form field to fill */
  const [sigDialog, setSigDialog] = useState<{ field?: { page: number; rect: Rect } } | null>(null);
  const activeTool: Tool = bar && !presenting ? tool : "select";
  const toolRef = useRef(activeTool);
  toolRef.current = activeTool;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const { onEdited, onRedacted, onPages } = props;

  /** A new edit history; cropping (or undoing it) also changes the page sizes. */
  const applyState = useCallback(
    (state: EditState) => {
      setHistory(state);
      if (state.pages) onPages(state.pages);
    },
    [onPages],
  );

  const bumpPage = useCallback(
    (page: number) => setRevs((r) => ({ all: r.all, pages: { ...r.pages, [page]: (r.pages[page] ?? 0) + 1 } })),
    [],
  );
  const bumpAll = useCallback(() => setRevs((r) => ({ all: r.all + 1, pages: r.pages })), []);

  const edit = useCallback(
    async (page: number, change: AnnotEdit): Promise<EditState | null> => {
      try {
        const state = await engine.editAnnot(info.docId, page, change);
        setHistory(state);
        bumpPage(page);
        onEdited();
        return state;
      } catch (e) {
        onError(t.annotate.editFailed(errorText(e)));
        bumpAll();
        return null;
      }
    },
    [engine, info.docId, bumpPage, bumpAll, onEdited, onError, t],
  );
  const editRef = useRef(edit);
  editRef.current = edit;

  const setField = useCallback(
    async (page: number, id: number, change: { value?: string; toggle?: boolean }) => {
      try {
        setHistory(await engine.setField(info.docId, page, id, change));
        // A field can be shown on several pages (same name), so redraw everything.
        bumpAll();
        onEdited();
      } catch (e) {
        onError(t.annotate.editFailed(errorText(e)));
      }
    },
    [engine, info.docId, bumpAll, onEdited, onError, t],
  );

  const editText = useCallback(
    async (page: number, line: TextLine, text: string): Promise<boolean> => {
      try {
        setHistory(await engine.editText(info.docId, page, line, text));
        bumpPage(page);
        onEdited();
        return true;
      } catch (e) {
        onError(t.annotate.editFailed(errorText(e)));
        bumpAll();
        return false;
      }
    },
    [engine, info.docId, bumpPage, bumpAll, onEdited, onError, t],
  );

  const redact = useCallback(
    async (page: number, area: RedactArea): Promise<boolean> => {
      try {
        setHistory(await engine.redact(info.docId, page, area));
        bumpPage(page);
        onEdited();
        onRedacted();
        return true;
      } catch (e) {
        onError(t.annotate.editFailed(errorText(e)));
        bumpAll();
        return false;
      }
    },
    [engine, info.docId, bumpPage, bumpAll, onEdited, onRedacted, onError, t],
  );
  const redactRef = useRef(redact);
  redactRef.current = redact;

  const undoRedo = useCallback(
    async (redo: boolean) => {
      if (!canEdit) return;
      try {
        const state = redo ? await engine.redo(info.docId) : await engine.undo(info.docId);
        applyState(state);
        setSelected(null);
        setDraftState(null);
        bumpAll();
        onEdited();
      } catch (e) {
        onError(t.annotate.editFailed(errorText(e)));
      }
    },
    [canEdit, engine, info.docId, applyState, bumpAll, onEdited, onError, t],
  );

  // After saving, the engine starts a new edit history (and may renumber objects).
  const wasDirty = useRef(doc.dirty);
  useEffect(() => {
    if (wasDirty.current && !doc.dirty) {
      setSelected(null);
      bumpAll();
      engine.history(info.docId).then(setHistory, () => {});
    }
    wasDirty.current = doc.dirty;
  }, [doc.dirty, engine, info.docId, bumpAll]);

  const setSettings = useCallback((next: ToolSettings) => {
    setSettingsState(next);
    saveSettings(next);
  }, []);

  const chooseTool = useCallback(
    (next: Tool) => {
      setBar((b) => (isEditTool(next) ? "edit" : next === "select" ? (b ?? "annotate") : "annotate"));
      setSelected(null);
      if (next === "signature") {
        setSigDialog({});
        return;
      }
      // Highlighting (or blacking out) text that is already selected.
      const markup = MARKUP[next];
      const sel = selectionRef.current;
      if (sel?.quads.length && toolRef.current === "select") {
        if (markup) {
          void edit(sel.page, { op: "create", annot: { type: markup, quads: sel.quads, color: colorOf(settings.colors[next]) } });
          handleSelection(null);
          return;
        }
        if (next === "redact") {
          void redact(sel.page, { quads: sel.quads });
          handleSelection(null);
        }
      }
      setSignature(null);
      setTool(next);
    },
    [edit, redact, settings, handleSelection],
  );

  const closeBar = useCallback(() => {
    setBar(null);
    setTool("select");
    setSignature(null);
    setSelected(null);
  }, []);

  /** Opens (or closes, when it is open) a toolbar row; the editing row starts with editing text. */
  const toggleBar = useCallback(
    (which: "annotate" | "edit") => {
      if (bar === which) {
        closeBar();
        return;
      }
      setBar(which);
      setSignature(null);
      setSelected(null);
      setTool(which === "edit" ? "edittext" : "select");
    },
    [bar, closeBar],
  );

  const placeSignatureImage = useCallback(
    async (sig: Signature, page: number, rect: Rect) => {
      const state = await edit(page, { op: "create", annot: { type: "Stamp", rect, image: signatureBytes(sig) } });
      if (state?.id !== undefined) setSelected({ page, id: state.id });
    },
    [edit],
  );

  const onSignatureChosen = useCallback(
    (sig: Signature) => {
      const field = sigDialog?.field;
      setSigDialog(null);
      if (field) {
        void placeSignatureImage(sig, field.page, fitInto(field.rect, sig.width / sig.height));
        return;
      }
      setBar("annotate");
      setSignature(sig);
      setTool("signature");
    },
    [sigDialog, placeSignatureImage],
  );

  // Text selected with a markup tool gets highlighted / underlined / struck out (or blacked out).
  const onSelectionEnd = useCallback(() => {
    const markup = MARKUP[toolRef.current];
    const sel = selectionRef.current;
    if (toolRef.current === "redact" && sel?.quads.length) {
      void redactRef.current(sel.page, { quads: sel.quads });
      handleSelection(null);
      return;
    }
    if (!markup || !sel?.quads.length) return;
    void editRef.current(sel.page, {
      op: "create",
      annot: { type: markup, quads: sel.quads, color: colorOf(settingsRef.current.colors[toolRef.current]) },
    });
    handleSelection(null);
  }, [handleSelection]);

  const onPagePress = useCallback(() => setSelected(null), []);

  const editApi = useMemo<EditApi>(
    () => ({
      engine,
      docId: info.docId,
      canAnnotate,
      canModify,
      canFillForms,
      tool: activeTool,
      settings,
      signature,
      selected,
      draft,
      pageRev: (page) => revs.all + (revs.pages[page] ?? 0),
      select: setSelected,
      setDraft: (d) => {
        setDraftState(d);
        if (d) setSelected(null);
        // Notes and text boxes are placed one at a time.
        if (d && (toolRef.current === "note" || toolRef.current === "text")) setTool("select");
      },
      edit,
      setField,
      editText,
      redact,
      placeSignature: (page, rect) => {
        if (!signature) return;
        setSignature(null);
        setTool("select");
        void placeSignatureImage(signature, page, rect);
      },
      signField: (page, rect) => setSigDialog({ field: { page, rect } }),
      crop,
      startCrop: (page, rect) => {
        // (a new box drawn while the dialog is open starts it again)
        setCrop({ page, rect, id: Date.now() });
        setDialog("crop");
      },
      goToPage: (page) => viewerRef.current?.goToPage(page),
      openUri: (uri) => {
        if (SAFE_URI.test(uri)) window.open(uri, "_blank", "noopener,noreferrer");
      },
      pageLabel: (page) => info.pages[page]?.label ?? String(page + 1),
    }),
    [
      engine,
      info,
      canAnnotate,
      canModify,
      canFillForms,
      activeTool,
      settings,
      signature,
      selected,
      draft,
      revs,
      edit,
      setField,
      editText,
      redact,
      placeSignatureImage,
      crop,
    ],
  );

  // Reopened file: continue on the page where it was left.
  const restorePage = useRef(doc.path ? lastPage(doc.path) : 0);
  useEffect(() => {
    const page = restorePage.current;
    if (!page || !viewport.width) return;
    restorePage.current = 0;
    requestAnimationFrame(() => viewerRef.current?.goToPage(Math.min(page, info.pageCount - 1)));
  }, [viewport.width, info.pageCount]);

  useEffect(() => {
    const path = doc.path;
    if (!path || restorePage.current) return;
    const timer = setTimeout(() => rememberPage(path, currentPage), 400);
    return () => clearTimeout(timer);
  }, [doc.path, currentPage]);

  // A newly activated tab takes the keyboard (arrows, Page Down…).
  useEffect(() => {
    if (active) requestAnimationFrame(() => viewerRef.current?.focus());
  }, [active]);

  // ---------- Zoom ----------

  useEffect(() => {
    if (!fit || !viewport.width) return;
    const pages = rotatePages(info.pages, rotation);
    const page = presenting ? -1 : currentPageRef.current;
    setScale(fitScale(pages, fit, viewport.width, viewport.height, page, pageMode));
  }, [info, fit, viewport, rotation, pageMode, presenting]);

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
  /** To the next / previous page (or pair of pages side by side) */
  const stepPage = useCallback((dir: 1 | -1) => viewerRef.current?.step(dir), []);

  // ---------- View: rotation, pages side by side, full screen ----------

  const rotateView = useCallback((dir: 1 | -1) => setRotation((r) => normalizeViewRotation(r + dir * 90)), []);

  const { onPresenting } = props;
  /** Zoom before full screen, restored after it */
  const savedZoom = useRef<{ fit: FitMode; scale: number } | null>(null);

  const startPresenting = useCallback(() => {
    if (presentingRef.current) return;
    savedZoom.current = { fit, scale };
    setFit("page");
    setPresenting(true);
    onPresenting(true);
    setSelected(null);
    setDraftState(null);
    handleSelection(null);
    // (in the web version the browser may refuse; the window is then used as it is)
    document.documentElement.requestFullscreen?.().catch(() => {});
    onToast(t.view.fullscreenHint);
  }, [fit, scale, onPresenting, handleSelection, onToast, t]);

  const stopPresenting = useCallback(() => {
    if (!presentingRef.current) return;
    setPresenting(false);
    onPresenting(false);
    const saved = savedZoom.current;
    savedZoom.current = null;
    if (saved) {
      setFit(saved.fit);
      if (!saved.fit) setScale(saved.scale);
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    requestAnimationFrame(() => viewerRef.current?.focus());
  }, [onPresenting]);

  // Leaving the browser's full screen (Esc, F11) ends it here too; so does leaving the tab.
  useEffect(() => {
    if (!presenting) return;
    const onChange = () => {
      if (!document.fullscreenElement) stopPresenting();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [presenting, stopPresenting]);
  useEffect(() => {
    if (!active) stopPresenting();
  }, [active, stopPresenting]);

  // In full screen the controls show up when the mouse moves and hide after a while.
  const [controlsShown, setControlsShown] = useState(true);
  useEffect(() => {
    if (!presenting) return;
    let timer = 0;
    const show = () => {
      setControlsShown(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => setControlsShown(false), 2500);
    };
    show();
    window.addEventListener("mousemove", show);
    window.addEventListener("mousedown", show);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousemove", show);
      window.removeEventListener("mousedown", show);
    };
  }, [presenting]);

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
      const inInput =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement;
      const key = e.key.toLowerCase();
      const zoomKey =
        ctrl && (key === "+" || key === "=" || key === "-" || key === "0" || e.code === "NumpadAdd" || e.code === "NumpadSubtract");

      // Rotating the view: Ctrl+Shift+Plus / Minus (zooming has the same keys without Shift).
      if (ctrl && e.shiftKey && !e.altKey) {
        const right = key === "+" || key === "=" || e.code === "Equal" || e.code === "NumpadAdd";
        const left = key === "-" || key === "_" || e.code === "Minus" || e.code === "NumpadSubtract";
        if (right || left) {
          e.preventDefault();
          rotateView(right ? 1 : -1);
          return;
        }
      }
      // Full screen: Ctrl+L (as in other PDF viewers), in the desktop app also F11.
      if ((ctrl && !e.shiftKey && !e.altKey && key === "l") || (key === "f11" && isDesktop)) {
        e.preventDefault();
        if (presentingRef.current) stopPresenting();
        else startPresenting();
        return;
      }
      if (presentingRef.current) {
        const back =
          key === "pageup" || key === "arrowup" || key === "arrowleft" || key === "backspace" || (key === " " && e.shiftKey);
        const forward =
          !back && (key === "pagedown" || key === "arrowdown" || key === "arrowright" || key === " " || key === "enter");
        if (key === "escape") stopPresenting();
        else if (forward || back) stepPage(forward ? 1 : -1);
        else if (key === "home") goToPage(0);
        else if (key === "end") goToPage(info.pageCount - 1);
        else if (!zoomKey) return;
        if (!zoomKey) {
          e.preventDefault();
          return;
        }
      }

      if (ctrl && !inInput && key === "z" && canEdit) {
        e.preventDefault();
        void undoRedo(e.shiftKey);
      } else if (ctrl && !inInput && key === "y" && canEdit) {
        e.preventDefault();
        void undoRedo(true);
      } else if (!ctrl && !inInput && (key === "delete" || key === "backspace") && selected) {
        e.preventDefault();
        setSelected(null);
        void edit(selected.page, { op: "delete", id: selected.id });
      } else if (ctrl && key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (ctrl && key === "e") {
        e.preventDefault();
        if (rights.copy) setDialog("export");
        else onToast(t.restrictions.copyBlocked);
      } else if (ctrl && key === "p") {
        // (also keeps the browser from printing the window itself)
        e.preventDefault();
        if (rights.print) setDialog("print");
        else onToast(t.restrictions.printBlocked);
      } else if (ctrl && key === "c" && !inInput && selection?.text) {
        e.preventDefault();
        if (!rights.copy) {
          onToast(t.restrictions.copyBlocked);
          return;
        }
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
        if (toolRef.current !== "select") {
          setTool("select");
          setSignature(null);
        } else if (selected) {
          setSelected(null);
        } else {
          handleSelection(null);
        }
      } else if (!inInput && !ctrl && (key === "arrowleft" || key === "arrowright")) {
        if (info.pageCount > 1 && fit === "page") {
          e.preventDefault();
          stepPage(key === "arrowright" ? 1 : -1);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selection, search.query, runSearch, fit, info.pageCount, zoomStep, zoomTo, goToPage, stepPage, rotateView, startPresenting, stopPresenting, onToggleSidebar, onToast, onError, t, canEdit, undoRedo, selected, edit, handleSelection, rights]);

  const closeDialog = useCallback(() => {
    setDialog(null);
    setCrop(null);
    viewerRef.current?.focus();
  }, []);

  /** Cropping, a watermark or page numbers were applied to pages. */
  const pageToolDone = useCallback(
    (state: EditState, message: string) => {
      applyState(state);
      bumpAll();
      onEdited();
      closeDialog();
      onToast(message);
    },
    [applyState, bumpAll, onEdited, closeDialog, onToast],
  );
  const previewCrop = useCallback((rect: Rect) => setCrop((c) => (c ? { ...c, rect } : c)), []);

  /** The pages in view, as "3" or "3–4" (two side by side) */
  const pagesInView = () => {
    const first = currentPage;
    const last =
      pageMode === "single" || (pageMode === "cover" && first === 0) ? first : Math.min(first + 1, info.pageCount - 1);
    return last > first ? `${first + 1}–${last + 1}` : String(first + 1);
  };

  // ---------- Restrictions of a secured document ----------

  const restricted = isRestricted(doc.security);
  const blocked = useMemo(() => {
    const r = t.restrictions;
    const why = (text: string) => `${text}. ${r.unlockHint}`;
    const list: Partial<Record<BlockableAction, string>> = {};
    if (!rights.print) list.print = why(r.printBlocked);
    if (!rights.copy) list.export = why(r.copyBlocked);
    if (!rights.annotate) list.annotate = list.sign = why(r.annotateBlocked);
    if (!rights.modify) list.edit = list.compress = why(r.modifyBlocked);
    if (!rights.assemble) list.organize = why(r.assembleBlocked);
    return list;
  }, [rights, t]);

  /** What is not allowed, in words ("changes" when no change at all is allowed). */
  const deniedText = () => {
    const r = t.restrictions;
    const noChanges = CHANGE_RIGHTS.every((k) => !rights[k]);
    const shown: readonly (keyof DocRights)[] = noChanges ? ["print", "copy"] : NOTICE_RIGHTS;
    const denied = shown.filter((k) => !rights[k]).map((k) => r[k]);
    if (noChanges) denied.push(t.protect.changes);
    return denied.join(", ");
  };

  return (
    <section
      className={`doc-view${active ? "" : " inactive"}${presenting ? " presenting" : ""}${presenting && !controlsShown ? " idle" : ""}`}
      inert={!active}
    >
      <EditContext value={editApi}>
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
        canAnnotate={canEdit}
        annotating={bar === "annotate"}
        editing={bar === "edit"}
        onAnnotate={() => toggleBar("annotate")}
        onEdit={() => toggleBar("edit")}
        onSign={() => chooseTool("signature")}
        onProtect={() => setDialog("protect")}
        onCompress={() => setDialog("compress")}
        onToggleSidebar={onToggleSidebar}
        onGoToPage={goToPage}
        onStepPage={stepPage}
        atLastPage={rowStart(currentPage, pageMode) >= rowStart(info.pageCount - 1, pageMode)}
        rotation={rotation}
        pageMode={pageMode}
        onRotate={rotateView}
        onPageMode={setPageMode}
        onFullscreen={startPresenting}
        onZoomStep={zoomStep}
        onZoomPercent={(p) => zoomTo(percentToScale(p))}
        onFit={setFit}
        onSearch={runSearch}
        onSearchClear={() => setSearch(NO_SEARCH)}
        onExport={() => setDialog("export")}
        blocked={blocked}
      />

      {restricted && !noticeHidden && (
        <div className="doc-notice" role="status">
          <LockKeyhole size={16} className="muted" />
          <span>{t.restrictions.notice(deniedText())}</span>
          {info.isPdf && (
            <button className="btn small" onClick={() => setDialog("unlock")} title={t.restrictions.unlockTitle}>
              {t.restrictions.unlock}
            </button>
          )}
          <button
            className="doc-notice-close"
            onClick={() => setNoticeHidden(true)}
            title={t.restrictions.hide}
            aria-label={t.restrictions.hide}
          >
            <X size={15} />
          </button>
        </div>
      )}

      {bar && (
        <AnnotateBar
          mode={bar}
          tool={tool}
          settings={settings}
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          onTool={chooseTool}
          onSettings={setSettings}
          onUndo={() => void undoRedo(false)}
          onRedo={() => void undoRedo(true)}
          onWatermark={() => setDialog("watermark")}
          onPageNumbers={() => setDialog("pageNumbers")}
          onClose={closeBar}
        />
      )}

      <main className="workspace">
        {props.sidebarOpen && (
          <Sidebar engine={engine} doc={info} currentPage={currentPage} onGoToPage={goToPage} pageRev={editApi.pageRev} />
        )}
        <Viewer
          ref={viewerRef}
          engine={engine}
          doc={info}
          active={active}
          scale={scale}
          rotation={rotation}
          pageMode={pageMode}
          presenting={presenting}
          hits={search.hits}
          activeHit={search.active}
          selection={selection}
          onSelection={handleSelection}
          onViewport={onViewport}
          onCurrentPage={setCurrentPage}
          onZoom={zoomTo}
          tool={activeTool}
          onSelectionEnd={onSelectionEnd}
          onPagePress={onPagePress}
        />
        {presenting && (
          <div className="present-bar" role="toolbar" aria-label={t.view.fullscreen}>
            <button className="tb-btn" onClick={() => stepPage(-1)} disabled={currentPage <= 0} title={t.toolbar.prevPage}>
              <ChevronLeft size={18} />
            </button>
            <span className="present-page">
              {pagesInView()} / {info.pageCount}
            </span>
            <button
              className="tb-btn"
              onClick={() => stepPage(1)}
              disabled={rowStart(currentPage, pageMode) >= rowStart(info.pageCount - 1, pageMode)}
              title={t.toolbar.nextPage}
            >
              <ChevronRight size={18} />
            </button>
            <button className="tb-btn" onClick={stopPresenting} title={t.view.exitFullscreen}>
              <Minimize size={17} />
              <span className="tb-text">{t.view.exitFullscreen}</span>
            </button>
          </div>
        )}
      </main>
      </EditContext>

      {active && dialog === "export" && rights.copy && (
        <ExportDialog
          engine={engine}
          doc={info}
          fileName={doc.name}
          defaultDir={doc.dir}
          currentPage={currentPage}
          onClose={closeDialog}
        />
      )}
      {active && dialog === "print" && rights.print && (
        <PrintDialog engine={engine} doc={info} currentPage={currentPage} onClose={closeDialog} />
      )}
      {active && dialog === "crop" && crop && (
        <CropDialog
          key={crop.id}
          engine={engine}
          doc={info}
          page={crop.page}
          rect={crop.rect}
          rotation={rotation}
          onPreview={previewCrop}
          onDone={(state, n) => pageToolDone(state, t.crop.done(n))}
          onClose={closeDialog}
        />
      )}
      {active && dialog === "watermark" && canModify && (
        <WatermarkDialog
          engine={engine}
          doc={info}
          currentPage={currentPage}
          onDone={(state, n) => pageToolDone(state, t.watermark.done(n))}
          onClose={closeDialog}
        />
      )}
      {active && dialog === "pageNumbers" && canModify && (
        <PageNumbersDialog
          engine={engine}
          doc={info}
          currentPage={currentPage}
          onDone={(state, n) => pageToolDone(state, t.pageNumbers.done(n))}
          onClose={closeDialog}
        />
      )}
      {active && sigDialog && <SignatureDialog onClose={() => setSigDialog(null)} onUse={onSignatureChosen} />}
      {active && dialog === "compress" && canModify && (
        <CompressDialog
          engine={engine}
          docId={info.docId}
          fileName={doc.name}
          defaultDir={doc.dir}
          dirty={history.canUndo || doc.security.pending !== undefined}
          onReopened={() => {
            // The engine wrote the changes and reopened the document: a new edit history,
            // and a pending protection is applied now.
            setSelected(null);
            bumpAll();
            engine.history(info.docId).then(setHistory, () => {});
            engine.security(info.docId).then(props.onSecurity, () => {});
          }}
          onOpenCopy={(data, name) => {
            closeDialog();
            props.onOpenCopy(data, name);
          }}
          onSaved={(name) => onToast(t.app.saved(name))}
          onClose={closeDialog}
        />
      )}
      {active && (dialog === "protect" || dialog === "unlock") && (
        <ProtectDialog
          engine={engine}
          docId={info.docId}
          unlockOnly={dialog === "unlock"}
          onChanged={(message) => {
            onEdited();
            onToast(message);
          }}
          onSecurity={props.onSecurity}
          onUnlocked={() => {
            if (restricted) onToast(t.restrictions.unlocked);
          }}
          onClose={closeDialog}
        />
      )}
    </section>
  );
}
