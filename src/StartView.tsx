/** The start page shown in an empty tab: open, merge, language. */
import { Combine, FolderOpen, Globe } from "lucide-react";
import { Toolbar } from "./components/Toolbar";
import { CSS_PX_PER_PT_AT_100 } from "./viewer/layout";
import { isDesktop } from "./platform";
import { LANGUAGES, setLang, useLang, useT, type Lang } from "./i18n";

interface Props {
  active: boolean;
  loading: boolean;
  sidebarOpen: boolean;
  onOpen(): void;
  onMerge(): void;
}

const noop = () => {};
const NO_SEARCH_INFO = { query: "", count: 0, active: 0, done: false, busy: false };

export function StartView({ active, loading, sidebarOpen, onOpen, onMerge }: Props) {
  const t = useT();
  const lang = useLang();
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
            <button className="btn empty-secondary" onClick={onMerge} disabled={loading}>
              <Combine size={16} /> {t.app.merge}
            </button>
            {!isDesktop && <p className="muted small">{t.app.localOnly}</p>}
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
