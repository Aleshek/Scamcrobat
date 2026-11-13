import { memo, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { isAbortError, PRIORITY_THUMBNAIL, type PdfEngine } from "../engine/engine";
import type { DocInfo, OutlineNode } from "../engine/types";
import { useT } from "../i18n";

const THUMB_WIDTH = 132;

interface Props {
  engine: PdfEngine;
  doc: DocInfo;
  currentPage: number;
  onGoToPage(index: number): void;
  /** Render revision of a page – thumbnails are redrawn when it changes. */
  pageRev?(index: number): number;
}

export function Sidebar({ engine, doc, currentPage, onGoToPage, pageRev }: Props) {
  const t = useT();
  const hasOutline = doc.outline.length > 0;
  const [tab, setTab] = useState<"thumbs" | "outline">("thumbs");
  const activeTab = hasOutline ? tab : "thumbs";

  return (
    <aside className="sidebar">
      {hasOutline && (
        <div className="sidebar-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === "thumbs"}
            className={activeTab === "thumbs" ? "active" : ""}
            onClick={() => setTab("thumbs")}
          >
            {t.sidebar.pages}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "outline"}
            className={activeTab === "outline" ? "active" : ""}
            onClick={() => setTab("outline")}
          >
            {t.sidebar.bookmarks}
          </button>
        </div>
      )}
      {activeTab === "thumbs" ? (
        <Thumbnails engine={engine} doc={doc} currentPage={currentPage} onGoToPage={onGoToPage} pageRev={pageRev} />
      ) : (
        <div className="outline">
          <OutlineList items={doc.outline} onGoToPage={onGoToPage} />
        </div>
      )}
    </aside>
  );
}

function Thumbnails({ engine, doc, currentPage, onGoToPage, pageRev }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the current page visible in the list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-thumb="${currentPage}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [currentPage]);

  return (
    <div className="thumbs" ref={listRef}>
      {doc.pages.map((p, i) => (
        <Thumb
          key={`${doc.docId}:${i}`}
          engine={engine}
          docId={doc.docId}
          index={i}
          label={p.label}
          width={THUMB_WIDTH}
          height={Math.round((THUMB_WIDTH * p.height) / p.width)}
          pageWidth={p.width}
          active={i === currentPage}
          rev={pageRev?.(i) ?? 0}
          root={listRef}
          onClick={onGoToPage}
        />
      ))}
    </div>
  );
}

interface ThumbProps {
  engine: PdfEngine;
  docId: number;
  index: number;
  label: string;
  width: number;
  height: number;
  pageWidth: number;
  active: boolean;
  rev: number;
  root: React.RefObject<HTMLDivElement | null>;
  onClick(index: number): void;
}

const Thumb = memo(function Thumb(props: ThumbProps) {
  const { engine, docId, index, width, height, pageWidth, rev } = props;
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  /** Revision the canvas shows; -1 = nothing yet */
  const [shownRev, setShownRev] = useState(-1);

  useEffect(() => {
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: props.root.current,
      rootMargin: "300px 0px",
    });
    io.observe(ref.current!);
    return () => io.disconnect();
  }, [props.root]);

  useEffect(() => {
    if (!visible || shownRev === rev) return;
    const ctrl = new AbortController();
    const scale = (width / pageWidth) * (window.devicePixelRatio || 1);
    engine
      .render(docId, index, scale, { priority: PRIORITY_THUMBNAIL, signal: ctrl.signal })
      .then(({ bitmap }) => {
        const c = canvasRef.current;
        if (!c) return bitmap.close();
        c.width = bitmap.width;
        c.height = bitmap.height;
        c.getContext("2d")!.drawImage(bitmap, 0, 0);
        bitmap.close();
        setShownRev(rev);
      })
      .catch((e) => {
        if (!isAbortError(e)) console.error(e);
      });
    return () => ctrl.abort();
  }, [visible, shownRev, rev, engine, docId, index, width, pageWidth]);

  return (
    <button
      ref={ref}
      data-thumb={index}
      className={props.active ? "thumb active" : "thumb"}
      onClick={() => props.onClick(index)}
      title={t.common.pageN(props.label)}
    >
      <span className="thumb-frame" style={{ width, height }}>
        <canvas ref={canvasRef} style={{ width, height }} />
      </span>
      <span className="thumb-label">{props.label}</span>
    </button>
  );
});

function OutlineList({ items, onGoToPage }: { items: OutlineNode[]; onGoToPage(i: number): void }) {
  return (
    <ul>
      {items.map((item, i) => (
        <OutlineItem key={i} item={item} onGoToPage={onGoToPage} />
      ))}
    </ul>
  );
}

function OutlineItem({ item, onGoToPage }: { item: OutlineNode; onGoToPage(i: number): void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hasChildren = item.children.length > 0;
  return (
    <li>
      <div className="outline-row">
        {hasChildren ? (
          <button className="outline-toggle" onClick={() => setOpen(!open)} aria-label={open ? t.sidebar.collapse : t.sidebar.expand}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="outline-toggle" />
        )}
        <button
          className="outline-title"
          disabled={item.page === null}
          onClick={() => item.page !== null && onGoToPage(item.page)}
          title={item.title}
        >
          {item.title || t.sidebar.untitled}
        </button>
      </div>
      {open && hasChildren && <OutlineList items={item.children} onGoToPage={onGoToPage} />}
    </li>
  );
}
