/** The start page shown in an empty tab: open, merge, recent files, language. */
import { Combine, FileText, FolderOpen, Globe, Images, X } from "lucide-react";
import { Toolbar } from "./components/Toolbar";
import { CSS_PX_PER_PT_AT_100 } from "./viewer/layout";
import { dirname, isDesktop } from "./platform";
import { forgetRecent, useRecent } from "./recent";
import { LANGUAGES, setLang, useLang, useT, type Lang } from "./i18n";

interface Props {
  active: boolean;
  loading: boolean;
  sidebarOpen: boolean;
  onOpen(): void;
  onMerge(): void;
  /** Create a PDF from images */
  onImages(): void;
  onOpenRecent(path: string, name: string): void;
}

/** How many recent files the start page shows */
const RECENT_SHOWN = 6;

const noop = () => {};
const NO_SEARCH_INFO = { query: "", count: 0, active: 0, done: false, busy: false };

export function StartView({ active, loading, sidebarOpen, onOpen, onMerge, onImages, onOpenRecent }: Props) {
  const t = useT();
  const lang = useLang();
  const recent = useRecent().slice(0, RECENT_SHOWN);
  return (
    <section className={active ? "doc-view" : "doc-view inactive"} inert={!active}>
      <Toolbar
        hasDoc={false}
        dirty={false}
        canOrganize={false}
        pageCount={0}
        currentPage={0}
        scale={CSS_PX_PER_PT_AT_100}
        fit={null}
        sidebarOpen={sidebarOpen}
        searchRef={null}
        searchInfo={NO_SEARCH_INFO}
        onOpen={onOpen}
        onSave={noop}
        onSaveAs={noop}
        onPrint={noop}
        onOrganize={noop}
        onToggleSidebar={noop}
        onGoToPage={noop}
        onZoomStep={noop}
        onZoomPercent={noop}
        onFit={noop}
        onSearch={noop}
        onSearchClear={noop}
        onExport={noop}
      />
      <main className="workspace">
        <div className="empty">
          <div className="empty-card">
            <img src="./logo.svg" alt="" width={72} height={72} />
            <h1>Scamcrobat</h1>
            <p className="muted">{t.app.tagline}</p>
            <button className="btn primary large" onClick={onOpen} disabled={loading}>
              <FolderOpen size={18} /> {loading ? t.app.opening : t.app.openPdf}
            </button>
            <p className="muted small">{t.app.orDrop}</p>
            <div className="empty-secondary-row">
              <button className="btn empty-secondary" onClick={onMerge} disabled={loading}>
                <Combine size={16} /> {t.app.merge}
              </button>
              <button className="btn empty-secondary" onClick={onImages} disabled={loading}>
                <Images size={16} /> {t.app.fromImages}
              </button>
            </div>
            {!isDesktop && <p className="muted small">{t.app.localOnly}</p>}
            {isDesktop && recent.length > 0 && (
              <nav className="recent" aria-label={t.app.recent}>
                <h2>{t.app.recent}</h2>
                <ul>
                  {recent.map((r) => (
                    <li key={r.path}>
                      <button
                        className="recent-open"
                        onClick={() => onOpenRecent(r.path, r.name)}
                        disabled={loading}
                        title={r.path}
                      >
                        <FileText size={16} />
                        <span className="recent-name">{r.name}</span>
                        <span className="recent-dir">{dirname(r.path)}</span>
                      </button>
                      <button
                        className="recent-remove"
                        onClick={() => forgetRecent(r.path)}
                        title={t.app.removeRecent}
                        aria-label={`${t.app.removeRecent}: ${r.name}`}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
            <label className="lang-select" title={t.app.language}>
              <Globe size={15} />
              <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t.app.language}>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </main>
    </section>
  );
}
