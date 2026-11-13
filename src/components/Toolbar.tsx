import { useEffect, useState, type Ref } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  ImageDown,
  LayoutGrid,
  Maximize,
  MoveHorizontal,
  PanelLeft,
  Save,
  SaveAll,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { scaleToPercent } from "../viewer/layout";

interface Props {
  /** Mění se s každým otevřeným dokumentem (vynuluje pole hledání). */
  docKey: number;
  hasDoc: boolean;
  /** Dokument má neuložené změny */
  dirty: boolean;
  /** Dokument je PDF, takže jde upravovat */
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
  onOrganize(): void;
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

  return (
    <header className="toolbar">
      <div className="tb-group">
        <button className="tb-btn" onClick={props.onOpen} title="Otevřít PDF (Ctrl+O)">
          <FolderOpen size={18} />
          <span className="tb-text">Otevřít</span>
        </button>
        <button
          className={props.dirty ? "tb-btn attention" : "tb-btn"}
          onClick={props.onSave}
          disabled={!props.dirty}
          title={props.dirty ? "Uložit změny (Ctrl+S)" : "Žádné neuložené změny"}
        >
          <Save size={18} />
          <span className="tb-text">Uložit</span>
        </button>
        <button className="tb-btn" onClick={props.onSaveAs} disabled={!hasDoc} title="Uložit jako… (Ctrl+Shift+S)">
          <SaveAll size={18} />
        </button>
        <div className="tb-sep" />
        <button
          className={hasDoc && props.sidebarOpen ? "tb-btn toggled" : "tb-btn"}
          onClick={props.onToggleSidebar}
          disabled={!hasDoc}
          title="Panel stránek (F4)"
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
          title="Předchozí stránka"
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
          title="Další stránka"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="tb-sep" />

      <div className="tb-group">
        <button className="tb-btn" disabled={!hasDoc} onClick={() => props.onZoomStep(-1)} title="Oddálit (Ctrl+−)">
          <ZoomOut size={18} />
        </button>
        <ZoomInput disabled={!hasDoc} percent={scaleToPercent(scale)} onCommit={props.onZoomPercent} />
        <button className="tb-btn" disabled={!hasDoc} onClick={() => props.onZoomStep(1)} title="Přiblížit (Ctrl++)">
          <ZoomIn size={18} />
        </button>
        <button
          className={hasDoc && props.fit === "width" ? "tb-btn toggled" : "tb-btn"}
          disabled={!hasDoc}
          onClick={() => props.onFit("width")}
          title="Přizpůsobit šířce (Ctrl+2)"
        >
          <MoveHorizontal size={18} />
        </button>
        <button
          className={hasDoc && props.fit === "page" ? "tb-btn toggled" : "tb-btn"}
          disabled={!hasDoc}
          onClick={() => props.onFit("page")}
          title="Celá stránka (Ctrl+0)"
        >
          <Maximize size={17} />
        </button>
      </div>

      <div className="tb-spacer" />

      <SearchBox key={props.docKey} {...props} />

      <button
        className="tb-btn"
        disabled={!props.canOrganize}
        onClick={props.onOrganize}
        title={hasDoc && !props.canOrganize ? "Upravovat lze jen PDF" : "Otočit, smazat, přeskládat, vložit nebo rozdělit stránky"}
      >
        <LayoutGrid size={18} />
        <span className="tb-text">Uspořádat stránky</span>
      </button>

      <button className="tb-btn primary" disabled={!hasDoc} onClick={props.onExport} title="Exportovat jako obrázky (Ctrl+E)">
        <ImageDown size={18} />
        <span className="tb-text">Export do obrázků</span>
      </button>
    </header>
  );
}

function PageInput(props: { disabled: boolean; value: number; max: number; onCommit(n: number): void }) {
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
      aria-label="Číslo stránky"
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
      aria-label="Zoom v procentech"
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
  const [text, setText] = useState("");

  let status = "";
  if (searchInfo.busy) status = "Hledám…";
  else if (searchInfo.done && searchInfo.query === text.trim())
    status = searchInfo.count ? `${searchInfo.active + 1} / ${searchInfo.count}` : "Nenalezeno";

  return (
    <div className={hasDoc ? "search" : "search disabled"}>
      <Search size={16} className="search-icon" />
      <input
        ref={props.searchRef}
        className="search-input"
        placeholder="Hledat v dokumentu"
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
        aria-label="Hledat v dokumentu"
      />
      {status && <span className="search-status">{status}</span>}
      {searchInfo.count > 0 && searchInfo.query === text.trim() && (
        <>
          <button className="search-btn" onClick={() => props.onSearch(text.trim(), -1)} title="Předchozí (Shift+F3)">
            <ChevronUp size={16} />
          </button>
          <button className="search-btn" onClick={() => props.onSearch(text.trim(), 1)} title="Další (F3)">
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
          title="Zrušit hledání"
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}
