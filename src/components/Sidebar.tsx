import { memo, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { isAbortError, PRIORITY_THUMBNAIL, type PdfEngine } from "../engine/engine";
import type { DocInfo, OutlineNode } from "../engine/types";

const THUMB_WIDTH = 132;

interface Props {
  engine: PdfEngine;
  doc: DocInfo;
  currentPage: number;
  onGoToPage(index: number): void;
}

export function Sidebar({ engine, doc, currentPage, onGoToPage }: Props) {
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
            Stránky
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "outline"}
            className={activeTab === "outline" ? "active" : ""}
            onClick={() => setTab("outline")}
          >
            Záložky
          </button>
        </div>
      )}
      {activeTab === "thumbs" ? (
        <Thumbnails engine={engine} doc={doc} currentPage={currentPage} onGoToPage={onGoToPage} />
      ) : (
        <div className="outline">
          <OutlineList items={doc.outline} onGoToPage={onGoToPage} />
        </div>
      )}
    </aside>
  );
}

function Thumbnails({ engine, doc, currentPage, onGoToPage }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Aktuální stránka má být v seznamu vidět.
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
  root: React.RefObject<HTMLDivElement | null>;
  onClick(index: number): void;
}

const Thumb = memo(function Thumb(props: ThumbProps) {
  const { engine, docId, index, width, height, pageWidth } = props;
  const ref = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: props.root.current,
      rootMargin: "300px 0px",
    });
    io.observe(ref.current!);
    return () => io.disconnect();
  }, [props.root]);

  useEffect(() => {
    if (!visible || loaded) return;
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
        setLoaded(true);
      })
      .catch((e) => {
        if (!isAbortError(e)) console.error(e);
      });
    return () => ctrl.abort();
  }, [visible, loaded, engine, docId, index, width, pageWidth]);

  return (
    <button
      ref={ref}
      data-thumb={index}
      className={props.active ? "thumb active" : "thumb"}
      onClick={() => props.onClick(index)}
      title={`Strana ${props.label}`}
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
  const [open, setOpen] = useState(false);
  const hasChildren = item.children.length > 0;
  return (
    <li>
      <div className="outline-row">
        {hasChildren ? (
          <button className="outline-toggle" onClick={() => setOpen(!open)} aria-label={open ? "Sbalit" : "Rozbalit"}>
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
          {item.title || "(bez názvu)"}
        </button>
      </div>
      {open && hasChildren && <OutlineList items={item.children} onGoToPage={onGoToPage} />}
    </li>
  );
}
