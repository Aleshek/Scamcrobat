import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";
import {
  Check,
  FileOutput,
  FilePlus,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  SquareCheckBig,
  Trash,
  Undo2,
} from "lucide-react";
import { isAbortError, PRIORITY_THUMBNAIL, type PdfEngine } from "../engine/engine";
import type { DocInfo, OutlineFile, PageRef } from "../engine/types";
import { fileFromDrop, openFilesDialog, savePdfAs, type OpenedFile } from "../platform";
import { errorText } from "../errors";
import { useT } from "../i18n";
import { useFitLabels } from "../components/fitLabels";
import {
  deletePages,
  groupLabel,
  historyReducer,
  insertPages,
  movePages,
  outlineFiles,
  pagesFromDoc,
  rotatePages,
  samePages,
  toRefs,
  type OrgPage,
  type OrgSource,
} from "./model";
import { SplitDialog } from "./SplitDialog";

export interface OrganizeResult {
  pages: PageRef[];
  /** Does the result differ from the original document? */
  changed: boolean;
  /** Documents opened by the organizer that must be closed */
  owned: number[];
  /** The original document – its bookmarks and metadata take precedence */
  base?: number;
  /** Files whose bookmarks go under a bookmark named after the file */
  files: OutlineFile[];
}

export interface OrganizerHandle {
  /** Inserts files dropped outside the grid (after the selection, otherwise at the end). */
  insertFiles(files: OpenedFile[]): void;
  result(): OrganizeResult;
}

interface Props {
  ref?: Ref<OrganizerHandle>;
  engine: PdfEngine;
  sources: OrgSource[];
  pages: OrgPage[];
  /** A new document (merging) – the result counts as a change even without edits. */
  isNew: boolean;
  /** Base of output file names (without extension) */
  baseName: string;
  baseDir?: string;
  /** Opens files as page sources (asking for passwords); reports errors itself. */
  openSources(files: OpenedFile[]): Promise<{ info: DocInfo; file: OpenedFile }[]>;
  onApply(result: OrganizeResult, opts?: { save?: boolean }): void;
  onCancel(result: OrganizeResult): void;
  onDirtyChange(dirty: boolean): void;
  onToast(message: string): void;
  onError(message: string): void;
}

const INTERNAL_DRAG = "application/x-scamcrobat-pages";
const SIZE_KEY = "scamcrobat.organizeSize";
const SIZE_MIN = 90;
const SIZE_MAX = 280;
const GRID_GAP = 18;
const SOURCE_COLORS = ["#0d9488", "#2563eb", "#d97706", "#db2777", "#7c3aed", "#65a30d", "#dc2626", "#0891b2"];

function readSize() {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    if (n >= SIZE_MIN && n <= SIZE_MAX) return n;
  } catch {
    /* not critical */
  }
  return 150;
}

interface DropMarker {
  index: number;
  x: number;
  top: number;
  height: number;
}

export function Organizer(props: Props) {
  const { engine } = props;
  const t = useT();
  const [history, dispatch] = useReducer(historyReducer, null, () => ({
    past: [],
    present: props.pages,
    future: [],
  }));
  const pages = history.present;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const initialPages = useRef(props.pages).current;

  const [sources, setSources] = useState<OrgSource[]>(props.sources);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);
  const [size, setSize] = useState(readSize);
  const [drop, setDrop] = useState<DropMarker | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const dragKeys = useRef<Set<string> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useFitLabels(barRef, [t]);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollToKey = useRef<string | null>(null);

  // Selection only of pages that are really in the document (they can disappear after undo).
  const selectedKeys = useMemo(() => {
    const present = new Set(pages.map((p) => p.key));
    return new Set([...selected].filter((k) => present.has(k)));
  }, [pages, selected]);
  const selectedRef = useRef(selectedKeys);
  selectedRef.current = selectedKeys;

  const changed = props.isNew || !samePages(initialPages, pages);
  const { onDirtyChange } = props;
  useEffect(() => onDirtyChange(changed), [changed, onDirtyChange]);

  const setPages = useCallback((next: OrgPage[]) => dispatch({ type: "set", pages: next }), []);

  const result = useCallback(
    (): OrganizeResult => ({
      pages: toRefs(pagesRef.current),
      changed: props.isNew || !samePages(initialPages, pagesRef.current),
      owned: sourcesRef.current.filter((s) => s.owned).map((s) => s.docId),
      base: sourcesRef.current.find((s) => !s.owned)?.docId,
      files: outlineFiles(sourcesRef.current, pagesRef.current, props.isNew),
    }),
    [props.isNew, initialPages],
  );

  const baseDoc = sources.find((s) => !s.owned)?.docId;
  const sourceIndex = useMemo(() => new Map(sources.map((s, i) => [s.docId, i])), [sources]);
  const multiSource = new Set(pages.map((p) => p.docId)).size > 1;

  // ---------- Edits ----------

  const rotateSelected = (delta: number) => {
    if (selectedKeys.size) setPages(rotatePages(pages, selectedKeys, delta));
  };

  const deleteSelected = () => {
    if (!selectedKeys.size) return;
    setPages(deletePages(pages, selectedKeys));
    setSelected(new Set());
  };

  const insertIndex = () => {
    const sel = selectedRef.current;
    if (!sel.size) return pagesRef.current.length;
    let last = -1;
    pagesRef.current.forEach((p, i) => sel.has(p.key) && (last = i));
    return last + 1;
  };

  const insertFiles = useCallback(
    async (files: OpenedFile[], at?: number) => {
      if (!files.length) return;
      setWorking(t.organize.loadingFiles);
      try {
        const opened = await props.openSources(files);
        if (!opened.length) return;
        setSources((s) => [
          ...s,
          ...opened.map((o) => ({
            docId: o.info.docId,
            name: o.file.name,
            path: o.file.path,
            owned: true,
            hasOutline: o.info.outline.length > 0,
          })),
        ]);
        const added = opened.flatMap((o) => pagesFromDoc(o.info));
        const index = Math.min(at ?? insertIndex(), pagesRef.current.length);
        setPages(insertPages(pagesRef.current, added, index));
        setSelected(new Set(added.map((p) => p.key)));
        anchorRef.current = added[0]?.key ?? null;
        scrollToKey.current = added[0]?.key ?? null;
        props.onToast(t.organize.inserted(added.length));
      } finally {
        setWorking(null);
      }
    },
    [props.openSources, props.onToast, setPages, t],
  );

  const insertFromDialog = async () => {
    try {
      await insertFiles(await openFilesDialog(t.organize.insertDialogTitle));
    } catch (e) {
      props.onError(t.organize.loadFailed(errorText(e)));
    }
  };

  useImperativeHandle(props.ref, () => ({ insertFiles: (files) => void insertFiles(files), result }), [
    insertFiles,
    result,
  ]);

  // After inserting, scroll to the first inserted page.
  useEffect(() => {
    const key = scrollToKey.current;
    if (!key) return;
    scrollToKey.current = null;
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-org-key="${CSS.escape(key)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [pages]);

  const extractSelected = async () => {
    const chosen = pages.filter((p) => selectedKeys.has(p.key));
    if (!chosen.length) return;
    setWorking(t.organize.building);
    try {
      const data = await engine.buildPdf(toRefs(chosen), baseDoc);
      const indices = pages.flatMap((p, i) => (selectedKeys.has(p.key) ? [i] : []));
      const name = `${props.baseName}_${groupLabel(indices, t.organize.selectionSuffix)}.pdf`;
      const saved = await savePdfAs(data, name, props.baseDir);
      if (saved) props.onToast(t.app.saved(saved.name));
    } catch (e) {
      props.onError(t.organize.extractFailed(errorText(e)));
    } finally {
      setWorking(null);
    }
  };

  // ---------- Selection ----------

  const onCellClick = useCallback((e: ReactMouseEvent, key: string) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.shiftKey && anchorRef.current) {
      const list = pagesRef.current;
      const a = list.findIndex((p) => p.key === anchorRef.current);
      const b = list.findIndex((p) => p.key === key);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        const range = list.slice(from, to + 1).map((p) => p.key);
        setSelected((s) => new Set(ctrl ? [...s, ...range] : range));
        return;
      }
    }
    anchorRef.current = key;
    if (ctrl) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    } else {
      setSelected(new Set([key]));
    }
  }, []);

  const selectAll = () => {
    if (selectedKeys.size === pages.length) setSelected(new Set());
    else setSelected(new Set(pages.map((p) => p.key)));
  };

  const onCellAction = useCallback(
    (key: string, action: "left" | "right" | "delete") => {
      const keys = new Set([key]);
      const list = pagesRef.current;
      if (action === "delete") setPages(deletePages(list, keys));
      else setPages(rotatePages(list, keys, action === "left" ? -90 : 90));
    },
    [setPages],
  );

  // ---------- Keyboard ----------

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    // An open dialog (split, confirmation…) keeps the keys for itself.
    if (document.querySelector(".modal-backdrop")) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (ctrl && key === "z" && !e.shiftKey) {
      e.preventDefault();
      dispatch({ type: "undo" });
    } else if (ctrl && (key === "y" || (key === "z" && e.shiftKey))) {
      e.preventDefault();
      dispatch({ type: "redo" });
    } else if (ctrl && key === "s") {
      e.preventDefault();
      if (pages.length && !working) props.onApply(result(), { save: true });
    } else if (ctrl && key === "o") {
      e.preventDefault();
      void insertFromDialog();
    } else if (inInput) {
      return;
    } else if (ctrl && key === "a") {
      e.preventDefault();
      setSelected(new Set(pages.map((p) => p.key)));
    } else if (key === "delete" || key === "backspace") {
      e.preventDefault();
      deleteSelected();
    } else if (key === "escape") {
      setSelected(new Set());
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------- Thumbnail size ----------

  const changeSize = (n: number) => {
    const next = Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, n)));
    setSize(next);
    try {
      localStorage.setItem(SIZE_KEY, String(next));
    } catch {
      /* not critical */
    }
  };

  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setSize((s) => {
        const next = Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, s * Math.exp(-e.deltaY * 0.002))));
        try {
          localStorage.setItem(SIZE_KEY, String(next));
        } catch {
          /* not critical */
        }
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ---------- Drag and drop ----------

  const hitTest = (clientX: number, clientY: number): DropMarker => {
    const grid = gridRef.current!;
    const g = grid.getBoundingClientRect();
    const cells = grid.querySelectorAll<HTMLElement>("[data-org-index]");
    if (!cells.length) return { index: 0, x: GRID_GAP / 2, top: GRID_GAP, height: size + 24 };
    let best: { el: HTMLElement; r: DOMRect } | null = null;
    let bestDist = Infinity;
    for (const el of cells) {
      const r = el.getBoundingClientRect();
      const dx = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
      const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
      const d = dy * 10000 + dx; // the row under the cursor wins
      if (d < bestDist) {
        bestDist = d;
        best = { el, r };
      }
    }
    const { el, r } = best!;
    const i = Number(el.dataset.orgIndex);
    const after = clientX > r.left + r.width / 2;
    return {
      index: after ? i + 1 : i,
      x: (after ? r.right + GRID_GAP / 2 : r.left - GRID_GAP / 2) - g.left,
      top: r.top - g.top,
      height: r.height,
    };
  };

  const dragKind = (e: ReactDragEvent) => {
    const types = e.dataTransfer.types;
    if (types.includes(INTERNAL_DRAG)) return "move";
    if (types.includes("Files")) return "files";
    return null;
  };

  const onDragStart = useCallback((e: ReactDragEvent, key: string) => {
    let keys = selectedRef.current;
    if (!keys.has(key)) {
      keys = new Set([key]);
      setSelected(keys);
      anchorRef.current = key;
    }
    dragKeys.current = keys;
    e.dataTransfer.setData(INTERNAL_DRAG, String(keys.size));
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const onDragEnd = useCallback(() => {
    dragKeys.current = null;
    setDrop(null);
  }, []);

  const onDragOver = (e: ReactDragEvent) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = kind === "move" ? "move" : "copy";
    const m = hitTest(e.clientX, e.clientY);
    setDrop((d) => (d && d.index === m.index && d.x === m.x && d.top === m.top ? d : m));
  };

  const onDragLeave = (e: ReactDragEvent) => {
    const next = e.relatedTarget as Node | null;
    if (!next || !scrollRef.current?.contains(next)) setDrop(null);
  };

  const onDrop = async (e: ReactDragEvent) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    e.stopPropagation();
    const index = hitTest(e.clientX, e.clientY).index;
    setDrop(null);
    if (kind === "move" && dragKeys.current) {
      setPages(movePages(pages, dragKeys.current, index));
      dragKeys.current = null;
    } else if (kind === "files") {
      const files = await Promise.all([...e.dataTransfer.files].map(fileFromDrop));
      await insertFiles(files, index);
    }
  };

  // ---------- Rendering ----------

  const count = pages.length;
  const sel = selectedKeys.size;
  const noSel = sel === 0;
  const needSel = noSel ? t.organize.needSelection : undefined;

  return (
    <div className="organizer">
      <div className="toolbar org-bar" ref={barRef}>
        <div className="tb-group">
          <button className="tb-btn" onClick={selectAll} disabled={!count} title={t.organize.selectAllTitle}>
            <SquareCheckBig size={18} />
            <span className="tb-text">{count && sel === count ? t.organize.deselectAll : t.organize.selectAll}</span>
          </button>
        </div>
        <div className="tb-sep" />
        <div className="tb-group">
          <button className="tb-btn" onClick={() => rotateSelected(-90)} disabled={noSel} title={needSel ?? t.organize.rotateLeftSelected}>
            <RotateCcw size={18} />
          </button>
          <button className="tb-btn" onClick={() => rotateSelected(90)} disabled={noSel} title={needSel ?? t.organize.rotateRightSelected}>
            <RotateCw size={18} />
          </button>
          <button className="tb-btn" onClick={deleteSelected} disabled={noSel} title={needSel ?? t.organize.deleteSelected}>
            <Trash size={18} />
            <span className="tb-text">{t.organize.delete}</span>
          </button>
        </div>
        <div className="tb-sep" />
        <div className="tb-group">
          <button className="tb-btn" onClick={insertFromDialog} disabled={!!working} title={t.organize.insertTitle}>
            <FilePlus size={18} />
            <span className="tb-text">{t.organize.insert}</span>
          </button>
          <button
            className="tb-btn"
            onClick={extractSelected}
            disabled={noSel || !!working}
            title={needSel ?? t.organize.extractTitle}
          >
            <FileOutput size={18} />
            <span className="tb-text">{t.organize.extract}</span>
          </button>
          <button className="tb-btn" onClick={() => setSplitOpen(true)} disabled={count < 2} title={t.organize.splitTitle}>
            <Scissors size={18} />
            <span className="tb-text">{t.organize.split}</span>
          </button>
        </div>
        <div className="tb-sep" />
        <div className="tb-group">
          <button className="tb-btn" onClick={() => dispatch({ type: "undo" })} disabled={!history.past.length} title={t.organize.undo}>
            <Undo2 size={18} />
          </button>
          <button className="tb-btn" onClick={() => dispatch({ type: "redo" })} disabled={!history.future.length} title={t.organize.redo}>
            <Redo2 size={18} />
          </button>
        </div>
        <div className="tb-spacer" />
        <button className="tb-btn" onClick={() => props.onCancel(result())}>
          {t.common.cancel}
        </button>
        <button
          className="tb-btn primary"
          onClick={() => props.onApply(result())}
          disabled={!count || !!working}
          title={count ? t.organize.doneTitle : t.organize.needOnePage}
        >
          <Check size={18} />
          <span>{t.common.done}</span>
        </button>
      </div>

      <div
        className="org-scroll"
        ref={scrollRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget || e.target === gridRef.current) setSelected(new Set());
        }}
      >
        <div className="org-grid" ref={gridRef} style={{ gap: GRID_GAP, gridTemplateColumns: `repeat(auto-fill, ${size + 16}px)` }}>
          {pages.map((p, i) => (
            <OrgCell
              key={p.key}
              engine={engine}
              page={p}
              index={i}
              size={size}
              selected={selectedKeys.has(p.key)}
              color={multiSource ? SOURCE_COLORS[(sourceIndex.get(p.docId) ?? 0) % SOURCE_COLORS.length] : null}
              sourceName={multiSource ? sources.find((s) => s.docId === p.docId)?.name : undefined}
              root={scrollRef}
              onClick={onCellClick}
              onAction={onCellAction}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))}
          {drop && <div className="org-drop-marker" style={{ left: drop.x - 2, top: drop.top, height: drop.height }} />}
        </div>
        {!count && (
          <div className="org-empty">
            <p>{t.organize.emptyTitle}</p>
            <p className="muted">{t.organize.emptyHint}</p>
          </div>
        )}
      </div>

      <div className="org-status">
        <span>
          {t.common.pages(count)}
          {sel > 0 && ` · ${t.organize.selected(sel)}`}
          {working && ` · ${working}`}
        </span>
        <span className="org-hint muted">{t.organize.hint}</span>
        <label className="org-size" title={t.organize.thumbSizeTitle}>
          <span className="muted">{t.organize.thumbnails}</span>
          <input
            type="range"
            min={SIZE_MIN}
            max={SIZE_MAX}
            value={size}
            onChange={(e) => changeSize(Number(e.target.value))}
            aria-label={t.organize.thumbSize}
          />
        </label>
      </div>

      {splitOpen && (
        <SplitDialog
          engine={engine}
          pages={pages}
          base={baseDoc}
          baseName={props.baseName}
          baseDir={props.baseDir}
          onClose={() => setSplitOpen(false)}
        />
      )}
    </div>
  );
}

// ---------- One page in the grid ----------

interface CellProps {
  engine: PdfEngine;
  page: OrgPage;
  index: number;
  size: number;
  selected: boolean;
  color: string | null;
  sourceName?: string;
  root: React.RefObject<HTMLDivElement | null>;
  onClick(e: ReactMouseEvent, key: string): void;
  onAction(key: string, action: "left" | "right" | "delete"): void;
  onDragStart(e: ReactDragEvent, key: string): void;
  onDragEnd(): void;
}

const OrgCell = memo(function OrgCell(props: CellProps) {
  const { engine, page, size } = props;
  const t = useT();
  const cellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderedScale = useRef(0);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Thumbnail size without rotation – rotation is applied in CSS so that it can be animated.
  const fit = (size * 0.94) / Math.max(page.width, page.height);
  const w = Math.round(page.width * fit);
  const h = Math.round(page.height * fit);

  useEffect(() => {
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: props.root.current,
      rootMargin: "400px 0px",
    });
    io.observe(cellRef.current!);
    return () => io.disconnect();
  }, [props.root]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!visible) {
      // Release thumbnails far off screen (large documents = lots of memory).
      if (renderedScale.current) {
        canvas.width = canvas.height = 0;
        renderedScale.current = 0;
        setLoaded(false);
      }
      return;
    }
    const scale = fit * (window.devicePixelRatio || 1);
    const have = renderedScale.current;
    if (have >= scale && have < scale * 1.6) return;
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => {
        engine
          .render(page.docId, page.page, scale, { priority: PRIORITY_THUMBNAIL, signal: ctrl.signal })
          .then(({ bitmap }) => {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
            bitmap.close();
            renderedScale.current = scale;
            setLoaded(true);
          })
          .catch((e) => {
            if (!isAbortError(e)) console.error(e);
          });
      },
      have ? 150 : 0,
    );
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [visible, fit, engine, page.docId, page.page]);

  const title = props.sourceName
    ? t.organize.sourcePage(props.sourceName, page.page + 1)
    : t.common.pageN(String(props.index + 1));

  return (
    <div
      ref={cellRef}
      className={props.selected ? "org-cell selected" : "org-cell"}
      data-org-index={props.index}
      data-org-key={page.key}
      draggable
      onDragStart={(e) => props.onDragStart(e, page.key)}
      onDragEnd={props.onDragEnd}
      onClick={(e) => props.onClick(e, page.key)}
      title={title}
    >
      <div className="org-frame" style={{ width: size, height: size }}>
        <canvas
          ref={canvasRef}
          className={loaded ? "org-canvas" : "org-canvas pending"}
          style={{ width: w, height: h, transform: `rotate(${page.rotate}deg)` }}
        />
        {props.selected && (
          <span className="org-check" aria-hidden>
            <Check size={14} strokeWidth={3} />
          </span>
        )}
        <div className="org-actions" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => props.onAction(page.key, "left")} title={t.organize.rotateLeft} aria-label={t.organize.rotateLeft}>
            <RotateCcw size={15} />
          </button>
          <button onClick={() => props.onAction(page.key, "right")} title={t.organize.rotateRight} aria-label={t.organize.rotateRight}>
            <RotateCw size={15} />
          </button>
          <button onClick={() => props.onAction(page.key, "delete")} title={t.organize.deletePage} aria-label={t.organize.deletePage}>
            <Trash size={15} />
          </button>
        </div>
      </div>
      <div className="org-label">
        {props.color && <span className="org-dot" style={{ background: props.color }} />}
        {props.index + 1}
      </div>
    </div>
  );
});
