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
import type { DocInfo, PageRef } from "../engine/types";
import { fileFromDrop, openFilesDialog, savePdfAs, type OpenedFile } from "../platform";
import {
  deletePages,
  groupLabel,
  historyReducer,
  insertPages,
  movePages,
  pageCountLabel,
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
  /** Liší se výsledek od původního dokumentu? */
  changed: boolean;
  /** Dokumenty otevřené organizérem, které je potřeba zavřít */
  owned: number[];
  /** Původní dokument – jeho záložky a metadata mají přednost */
  base?: number;
}

export interface OrganizerHandle {
  /** Vloží soubory přetažené mimo mřížku (za výběr, jinak na konec). */
  insertFiles(files: OpenedFile[]): void;
  result(): OrganizeResult;
}

interface Props {
  ref?: Ref<OrganizerHandle>;
  engine: PdfEngine;
  sources: OrgSource[];
  pages: OrgPage[];
  /** Nový dokument (slučování) – výsledek se počítá jako změna i bez úprav. */
  isNew: boolean;
  /** Základ názvů výstupních souborů (bez přípony) */
  baseName: string;
  baseDir?: string;
  /** Otevře soubory jako zdroje stránek (s dotazem na heslo), chyby hlásí sám. */
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
    /* nevadí */
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
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollToKey = useRef<string | null>(null);

  // Výběr jen ze stránek, které v dokumentu opravdu jsou (po Zpět se mohou ztratit).
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
    }),
    [props.isNew, initialPages],
  );

  const baseDoc = sources.find((s) => !s.owned)?.docId;
  const sourceIndex = useMemo(() => new Map(sources.map((s, i) => [s.docId, i])), [sources]);
  const multiSource = new Set(pages.map((p) => p.docId)).size > 1;

  // ---------- Úpravy ----------

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
      setWorking("Načítám soubory…");
      try {
        const opened = await props.openSources(files);
        if (!opened.length) return;
        setSources((s) => [
          ...s,
          ...opened.map((o) => ({ docId: o.info.docId, name: o.file.name, path: o.file.path, owned: true })),
        ]);
        const added = opened.flatMap((o) => pagesFromDoc(o.info));
        const index = Math.min(at ?? insertIndex(), pagesRef.current.length);
        setPages(insertPages(pagesRef.current, added, index));
        setSelected(new Set(added.map((p) => p.key)));
        anchorRef.current = added[0]?.key ?? null;
        scrollToKey.current = added[0]?.key ?? null;
        props.onToast(
          added.length === 1 ? "Vložena 1 stránka" : added.length < 5 ? `Vloženy ${added.length} stránky` : `Vloženo ${added.length} stránek`,
        );
      } finally {
        setWorking(null);
      }
    },
    [props.openSources, props.onToast, setPages],
  );

  const insertFromDialog = async () => {
    try {
      await insertFiles(await openFilesDialog("Vložit stránky z PDF"));
    } catch (e) {
      props.onError(`Soubory se nepodařilo načíst: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  useImperativeHandle(props.ref, () => ({ insertFiles: (files) => void insertFiles(files), result }), [
    insertFiles,
    result,
  ]);

  // Po vložení posunout na první vloženou stránku.
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
    setWorking("Sestavuji PDF…");
    try {
      const data = await engine.buildPdf(toRefs(chosen), baseDoc);
      const indices = pages.flatMap((p, i) => (selectedKeys.has(p.key) ? [i] : []));
      const saved = await savePdfAs(data, `${props.baseName}_${groupLabel(indices)}.pdf`, props.baseDir);
      if (saved) props.onToast(`Uloženo – ${saved.name}`);
    } catch (e) {
      props.onError(`Extrakce stránek selhala: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setWorking(null);
    }
  };

  // ---------- Výběr ----------

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

  // ---------- Klávesnice ----------

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    // Otevřený dialog (rozdělení, potvrzení…) má klávesy pro sebe.
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

  // ---------- Velikost náhledů ----------

  const changeSize = (n: number) => {
    const next = Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, n)));
    setSize(next);
    try {
      localStorage.setItem(SIZE_KEY, String(next));
    } catch {
      /* nevadí */
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
          /* nevadí */
        }
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ---------- Přetahování ----------

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
      const d = dy * 10000 + dx; // přednost má řádek pod kurzorem
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

  // ---------- Vykreslení ----------

  const count = pages.length;
  const sel = selectedKeys.size;
  const noSel = sel === 0;
  const needSel = noSel ? "Nejdřív vyberte stránky" : undefined;

  return (
    <div className="organizer">
      <div className="toolbar org-bar">
        <div className="tb-group">
          <button className="tb-btn" onClick={selectAll} disabled={!count} title="Vybrat vše (Ctrl+A)">
            <SquareCheckBig size={18} />
            <span className="tb-text">{count && sel === count ? "Zrušit výběr" : "Vybrat vše"}</span>
          </button>
        </div>
        <div className="tb-sep" />
        <div className="tb-group">
          <button className="tb-btn" onClick={() => rotateSelected(-90)} disabled={noSel} title={needSel ?? "Otočit vybrané doleva"}>
            <RotateCcw size={18} />
          </button>
          <button className="tb-btn" onClick={() => rotateSelected(90)} disabled={noSel} title={needSel ?? "Otočit vybrané doprava"}>
            <RotateCw size={18} />
          </button>
          <button className="tb-btn" onClick={deleteSelected} disabled={noSel} title={needSel ?? "Smazat vybrané (Delete)"}>
            <Trash size={18} />
            <span className="tb-text">Smazat</span>
          </button>
        </div>
        <div className="tb-sep" />
        <div className="tb-group">
          <button className="tb-btn" onClick={insertFromDialog} disabled={!!working} title="Vložit stránky z jiného PDF (Ctrl+O)">
            <FilePlus size={18} />
            <span className="tb-text">Vložit PDF</span>
          </button>
          <button
            className="tb-btn"
            onClick={extractSelected}
            disabled={noSel || !!working}
            title={needSel ?? "Uložit vybrané stránky jako nové PDF"}
          >
            <FileOutput size={18} />
            <span className="tb-text">Extrahovat</span>
          </button>
          <button className="tb-btn" onClick={() => setSplitOpen(true)} disabled={count < 2} title="Rozdělit na více PDF">
            <Scissors size={18} />
            <span className="tb-text">Rozdělit</span>
          </button>
        </div>
        <div className="tb-sep" />
        <div className="tb-group">
          <button className="tb-btn" onClick={() => dispatch({ type: "undo" })} disabled={!history.past.length} title="Zpět (Ctrl+Z)">
            <Undo2 size={18} />
          </button>
          <button className="tb-btn" onClick={() => dispatch({ type: "redo" })} disabled={!history.future.length} title="Znovu (Ctrl+Y)">
            <Redo2 size={18} />
          </button>
        </div>
        <div className="tb-spacer" />
        <button className="tb-btn" onClick={() => props.onCancel(result())}>
          Zrušit
        </button>
        <button
          className="tb-btn primary"
          onClick={() => props.onApply(result())}
          disabled={!count || !!working}
          title={count ? "Použít změny a vrátit se k dokumentu" : "Dokument musí mít aspoň jednu stránku"}
        >
          <Check size={18} />
          <span>Hotovo</span>
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
            <p>V dokumentu nezůstala žádná stránka.</p>
            <p className="muted">Vložte stránky z jiného PDF, nebo změny vraťte (Ctrl+Z).</p>
          </div>
        )}
      </div>

      <div className="org-status">
        <span>
          {pageCountLabel(count)}
          {sel > 0 && ` · vybráno ${sel}`}
          {working && ` · ${working}`}
        </span>
        <span className="org-hint muted">
          Klik vybere · Ctrl+klik přidá · Shift+klik rozsah · přetažením změníte pořadí
        </span>
        <label className="org-size" title="Velikost náhledů (Ctrl+kolečko)">
          <span className="muted">Náhledy</span>
          <input
            type="range"
            min={SIZE_MIN}
            max={SIZE_MAX}
            value={size}
            onChange={(e) => changeSize(Number(e.target.value))}
            aria-label="Velikost náhledů"
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

// ---------- Jedna stránka v mřížce ----------

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
  const cellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderedScale = useRef(0);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Velikost náhledu bez otočení – otáčí se až v CSS, aby šlo otočení animovat.
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
      // Náhledy daleko mimo obrazovku uvolníme (velké dokumenty = hodně paměti).
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

  const title = props.sourceName ? `${props.sourceName} – strana ${page.page + 1}` : `Strana ${props.index + 1}`;

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
          <button onClick={() => props.onAction(page.key, "left")} title="Otočit doleva" aria-label="Otočit doleva">
            <RotateCcw size={15} />
          </button>
          <button onClick={() => props.onAction(page.key, "right")} title="Otočit doprava" aria-label="Otočit doprava">
            <RotateCw size={15} />
          </button>
          <button onClick={() => props.onAction(page.key, "delete")} title="Smazat stránku" aria-label="Smazat stránku">
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
