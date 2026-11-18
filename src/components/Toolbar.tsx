import { useEffect, useRef, useState, type Ref } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FilePenLine,
  FolderOpen,
  Highlighter,
  ImageDown,
  LayoutGrid,
  LockKeyhole,
  Maximize,
  MoveHorizontal,
  PanelLeft,
  Printer,
  Save,
  SaveAll,
  Search,
  Signature,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { scaleToPercent } from "../viewer/layout";
import { useT } from "../i18n";
import { useFitLabels } from "./fitLabels";

interface Props {
  hasDoc: boolean;
  /** The document has unsaved changes */
  dirty: boolean;
  /** The document is a PDF, so it can be edited */
  canOrganize: boolean;
  pageCount: number;
  currentPage: number;
  scale: number;
  fit: "width" | "page" | null;
  sidebarOpen: boolean;
  searchRef: Ref<HTMLInputElement>;
  searchInfo: { query: string; count: number; active: number; done: boolean; busy: boolean };
  onOpen(): void;
  onSave(): void;
  onSaveAs(): void;
  onPrint(): void;
  onOrganize(): void;
  /** The document can be annotated (PDF) */
  canAnnotate?: boolean;
  /** The annotation tools are shown */
  annotating?: boolean;
  onAnnotate?(): void;
  /** The editing tools (text, redaction) are shown */
  editing?: boolean;
  onEdit?(): void;
  onSign?(): void;
  /** Password protection dialog */
  onProtect?(): void;
  onToggleSidebar(): void;
  onGoToPage(index: number): void;
  onZoomStep(dir: 1 | -1): void;
  onZoomPercent(percent: number): void;
  onFit(mode: "width" | "page"): void;
  onSearch(query: string, dir: 1 | -1): void;
  onSearchClear(): void;
  onExport(): void;
}

export function Toolbar(props: Props) {
  const { hasDoc, pageCount, currentPage, scale } = props;
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useFitLabels(ref, [t, hasDoc]);

  return (
    <header className="toolbar" ref={ref}>
      <div className="tb-group">
        <button className="tb-btn" onClick={props.onOpen} title={t.toolbar.openTitle}>
          <FolderOpen size={18} />
          <span className="tb-text l1">{t.toolbar.open}</span>
        </button>
        <button
          className={props.dirty ? "tb-btn attention" : "tb-btn"}
          onClick={props.onSave}
          disabled={!props.dirty}
          title={props.dirty ? t.toolbar.saveTitle : t.toolbar.noChanges}
        >
          <Save size={18} />
          <span className="tb-text l1">{t.toolbar.save}</span>
        </button>
        <button className="tb-btn" onClick={props.onSaveAs} disabled={!hasDoc} title={t.toolbar.saveAs}>
          <SaveAll size={18} />
        </button>
        <button className="tb-btn" onClick={props.onPrint} disabled={!hasDoc} title={t.toolbar.print}>
          <Printer size={18} />
        </button>
        <button
          className="tb-btn"
          onClick={props.onProtect}
          disabled={!props.canAnnotate}
          title={hasDoc && !props.canAnnotate ? t.toolbar.organizePdfOnly : t.toolbar.protect}
        >
          <LockKeyhole size={18} />
        </button>
        <div className="tb-sep" />
        <button
          className={hasDoc && props.sidebarOpen ? "tb-btn toggled" : "tb-btn"}
          onClick={props.onToggleSidebar}
          disabled={!hasDoc}
          title={t.toolbar.sidebar}
          aria-pressed={props.sidebarOpen}
        >
          <PanelLeft size={18} />
        </button>
      </div>

      <div className="tb-sep" />

      <div className="tb-group">
        <button
          className="tb-btn"
          disabled={!hasDoc || currentPage <= 0}
          onClick={() => props.onGoToPage(currentPage - 1)}
          title={t.toolbar.prevPage}
        >
          <ChevronLeft size={18} />
        </button>
        <PageInput
          disabled={!hasDoc}
          value={hasDoc ? currentPage + 1 : 0}
          max={pageCount}
          onCommit={(n) => props.onGoToPage(n - 1)}
        />
        <span className="tb-muted">/ {hasDoc ? pageCount : "–"}</span>
        <button
          className="tb-btn"
          disabled={!hasDoc || currentPage >= pageCount - 1}
          onClick={() => props.onGoToPage(currentPage + 1)}
          title={t.toolbar.nextPage}
        >
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="tb-sep" />

      <div className="tb-group">
        <button className="tb-btn" disabled={!hasDoc} onClick={() => props.onZoomStep(-1)} title={t.toolbar.zoomOut}>
          <ZoomOut size={18} />
        </button>
        <ZoomInput disabled={!hasDoc} percent={scaleToPercent(scale)} onCommit={props.onZoomPercent} />
        <button className="tb-btn" disabled={!hasDoc} onClick={() => props.onZoomStep(1)} title={t.toolbar.zoomIn}>
          <ZoomIn size={18} />
        </button>
        <button
          className={hasDoc && props.fit === "width" ? "tb-btn toggled" : "tb-btn"}
          disabled={!hasDoc}
          onClick={() => props.onFit("width")}
          title={t.toolbar.fitWidth}
        >
          <MoveHorizontal size={18} />
        </button>
        <button
          className={hasDoc && props.fit === "page" ? "tb-btn toggled" : "tb-btn"}
          disabled={!hasDoc}
          onClick={() => props.onFit("page")}
          title={t.toolbar.fitPage}
        >
          <Maximize size={17} />
        </button>
      </div>

      <div className="tb-spacer" />

      <SearchBox {...props} />

      <button
        className={props.annotating ? "tb-btn toggled" : "tb-btn"}
        disabled={!props.canAnnotate}
        onClick={props.onAnnotate}
        aria-pressed={!!props.annotating}
        title={hasDoc && !props.canAnnotate ? t.toolbar.organizePdfOnly : t.toolbar.annotateTitle}
      >
        <Highlighter size={18} />
        <span className="tb-text l3">{t.toolbar.annotate}</span>
      </button>

      <button
        className={props.editing ? "tb-btn toggled" : "tb-btn"}
        disabled={!props.canAnnotate}
        onClick={props.onEdit}
        aria-pressed={!!props.editing}
        title={hasDoc && !props.canAnnotate ? t.toolbar.organizePdfOnly : t.toolbar.editTitle}
      >
        <FilePenLine size={18} />
        <span className="tb-text l3">{t.toolbar.edit}</span>
      </button>

      <button
        className="tb-btn"
        disabled={!props.canAnnotate}
        onClick={props.onSign}
        title={hasDoc && !props.canAnnotate ? t.toolbar.organizePdfOnly : t.toolbar.signTitle}
      >
        <Signature size={18} />
        <span className="tb-text l3">{t.toolbar.sign}</span>
      </button>

      <button
        className="tb-btn"
        disabled={!props.canOrganize}
        onClick={props.onOrganize}
        title={hasDoc && !props.canOrganize ? t.toolbar.organizePdfOnly : t.toolbar.organizeTitle}
      >
        <LayoutGrid size={18} />
        <span className="tb-text l2">{t.toolbar.organize}</span>
      </button>

      <button className="tb-btn primary" disabled={!hasDoc} onClick={props.onExport} title={t.toolbar.exportTitle}>
        <ImageDown size={18} />
        <span className="tb-text">{t.toolbar.export}</span>
      </button>
    </header>
  );
}

function PageInput(props: { disabled: boolean; value: number; max: number; onCommit(n: number): void }) {
  const t = useT();
  const [text, setText] = useState(String(props.value || ""));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(props.value ? String(props.value) : "");
  }, [props.value, editing]);
  const commit = () => {
    const n = parseInt(text, 10);
    if (Number.isFinite(n)) props.onCommit(Math.min(Math.max(n, 1), props.max));
    setEditing(false);
  };
  return (
    <input
      className="tb-input page-input"
      disabled={props.disabled}
      value={text}
      inputMode="numeric"
      aria-label={t.toolbar.pageNumber}
      onFocus={(e) => {
        setEditing(true);
        e.currentTarget.select();
      }}
      onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ""))}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setEditing(false);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function ZoomInput(props: { disabled: boolean; percent: number; onCommit(p: number): void }) {
  const t = useT();
  const [text, setText] = useState(`${props.percent} %`);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(`${props.percent} %`);
  }, [props.percent, editing]);
  return (
    <input
      className="tb-input zoom-input"
      disabled={props.disabled}
      value={props.disabled ? "" : text}
      aria-label={t.toolbar.zoomPercent}
      onFocus={(e) => {
        setEditing(true);
        setText(String(props.percent));
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const n = parseFloat(text.replace(",", "."));
          if (Number.isFinite(n) && n > 0) props.onCommit(n);
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function SearchBox(props: Props) {
  const { searchInfo, hasDoc } = props;
  const t = useT();
  const [text, setText] = useState("");

  let status = "";
  if (searchInfo.busy) status = t.toolbar.searching;
  else if (searchInfo.done && searchInfo.query === text.trim())
    status = searchInfo.count ? `${searchInfo.active + 1} / ${searchInfo.count}` : t.toolbar.notFound;

  return (
    <div className={hasDoc ? "search" : "search disabled"}>
      <Search size={16} className="search-icon" />
      <input
        ref={props.searchRef}
        className="search-input"
        placeholder={t.toolbar.searchPlaceholder}
        disabled={!hasDoc}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "F3") {
            e.preventDefault();
            props.onSearch(text.trim(), e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            setText("");
            props.onSearchClear();
          }
        }}
        aria-label={t.toolbar.searchPlaceholder}
      />
      {status && <span className="search-status">{status}</span>}
      {searchInfo.count > 0 && searchInfo.query === text.trim() && (
        <>
          <button className="search-btn" onClick={() => props.onSearch(text.trim(), -1)} title={t.toolbar.searchPrev}>
            <ChevronUp size={16} />
          </button>
          <button className="search-btn" onClick={() => props.onSearch(text.trim(), 1)} title={t.toolbar.searchNext}>
            <ChevronDown size={16} />
          </button>
        </>
      )}
      {text && (
        <button
          className="search-btn"
          onClick={() => {
            setText("");
            props.onSearchClear();
          }}
          title={t.toolbar.searchClear}
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}
