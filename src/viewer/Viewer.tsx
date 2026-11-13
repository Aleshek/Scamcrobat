import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { PRIORITY_NEARBY, PRIORITY_VISIBLE, type PdfEngine } from "../engine/engine";
import type { DocInfo, Point, Quad, SearchHit, TextSelection } from "../engine/types";
import { clampScale, computeLayout, pageAtY, visibleRange, type Layout } from "./layout";
import { PageView } from "./PageView";

export interface ViewerHandle {
  goToPage(index: number): void;
  revealHit(hit: SearchHit): void;
  focus(): void;
}

interface Props {
  ref?: Ref<ViewerHandle>;
  engine: PdfEngine;
  doc: DocInfo;
  scale: number;
  hits: SearchHit[];
  activeHit: number;
  selection: TextSelection | null;
  onSelection(sel: TextSelection | null): void;
  onViewport(width: number, height: number): void;
  onCurrentPage(index: number): void;
  onZoom(scale: number): void;
}

/** Která část výšky okna určuje „aktuální“ stránku. */
const CURRENT_PAGE_LINE = 0.4;

export function Viewer(props: Props) {
  const { engine, doc, scale, hits, activeHit, selection, onSelection, onViewport, onCurrentPage, onZoom } =
    props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const lastScroll = useRef({ top: 0, left: 0 });
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const prevLayout = useRef<{ docId: number; layout: Layout } | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const layout = useMemo(
    () => computeLayout(doc.pages, scale, viewport.width),
    [doc.pages, scale, viewport.width],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Velikost okna prohlížeče (kvůli „přizpůsobit šířce“ a virtualizaci).
  useLayoutEffect(() => {
    const el = containerRef.current!;
    const ro = new ResizeObserver(() => {
      setViewport({ width: el.clientWidth, height: el.clientHeight });
      onViewport(el.clientWidth, el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [onViewport]);

  // Po změně zoomu udržíme na místě bod pod kurzorem (nebo střed okna).
  useLayoutEffect(() => {
    const el = containerRef.current!;
    const prev = prevLayout.current;
    prevLayout.current = { docId: doc.docId, layout };
    if (!prev || prev.docId !== doc.docId) {
      if (prev) {
        el.scrollTop = 0;
        el.scrollLeft = 0;
        lastScroll.current = { top: 0, left: 0 };
        setScroll({ top: 0, left: 0 });
      }
      return;
    }
    const old = prev.layout;
    if (old.scale === layout.scale || !old.tops.length) return;
    // Na začátku dokumentu (např. hned po otevření) zůstáváme nahoře, pokud nejde o zoom kolečkem.
    if (!anchorRef.current && lastScroll.current.top === 0) {
      el.scrollLeft = Math.max(0, (layout.contentWidth - el.clientWidth) / 2);
      lastScroll.current = { top: 0, left: el.scrollLeft };
      setScroll(lastScroll.current);
      return;
    }
    const ax = anchorRef.current?.x ?? el.clientWidth / 2;
    const ay = anchorRef.current?.y ?? el.clientHeight / 2;
    anchorRef.current = null;
    const cx = lastScroll.current.left + ax;
    const cy = lastScroll.current.top + ay;
    const i = pageAtY(old, cy);
    const fy = (cy - old.tops[i]) / old.heights[i];
    const fx = (cx - old.lefts[i]) / old.widths[i];
    el.scrollTop = layout.tops[i] + fy * layout.heights[i] - ay;
    el.scrollLeft = layout.lefts[i] + fx * layout.widths[i] - ax;
    lastScroll.current = { top: el.scrollTop, left: el.scrollLeft };
    setScroll(lastScroll.current);
  }, [layout, doc.docId]);

  // Posouvání: rAF, aby se React nepřekresloval častěji než obrazovka.
  useEffect(() => {
    const el = containerRef.current!;
    let frame = 0;
    const onScroll = () => {
      lastScroll.current = { top: el.scrollTop, left: el.scrollLeft };
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setScroll(lastScroll.current);
        });
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  // Ctrl + kolečko (a gesto sevření na touchpadu) = zoom kolem kurzoru.
  useEffect(() => {
    const el = containerRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      anchorRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      const next = clampScale(scaleRef.current * Math.exp(-delta * 0.0025));
      scaleRef.current = next;
      onZoom(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onZoom]);

  // Aktuální stránka = ta, přes kterou vede linka ve 40 % výšky okna.
  // Čteme skutečnou pozici z DOM (po změně zoomu může být stav o snímek pozadu).
  const lastReportedPage = useRef(-1);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !layout.tops.length) return;
    const page = pageAtY(layout, el.scrollTop + el.clientHeight * CURRENT_PAGE_LINE);
    if (page !== lastReportedPage.current) {
      lastReportedPage.current = page;
      onCurrentPage(page);
    }
  }, [scroll, layout, viewport.height, onCurrentPage]);

  useImperativeHandle(
    props.ref,
    () => ({
      goToPage(index) {
        const el = containerRef.current;
        const l = layoutRef.current;
        if (!el || index < 0 || index >= l.tops.length) return;
        el.scrollTop = l.tops[index] - 8;
      },
      revealHit(hit) {
        const el = containerRef.current;
        const l = layoutRef.current;
        const info = doc.pages[hit.page];
        if (!el || !info || !hit.quads.length) return;
        const q = hit.quads[0];
        const y = l.tops[hit.page] + (Math.min(q[1], q[3]) - info.y0) * l.scale;
        const x = l.lefts[hit.page] + (Math.min(q[0], q[4]) - info.x0) * l.scale;
        if (y < el.scrollTop + 40 || y > el.scrollTop + el.clientHeight - 60) {
          el.scrollTop = y - el.clientHeight / 3;
        }
        if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) {
          el.scrollLeft = x - el.clientWidth / 3;
        }
      },
      focus() {
        containerRef.current?.focus({ preventScroll: true });
      },
    }),
    [doc.pages],
  );

  // Výběr textu tažením myši (v rámci jedné stránky).
  const selectionGen = useRef(0);
  const onPageMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, index: number) => {
      if (e.button !== 0) return;
      e.preventDefault();
      containerRef.current?.focus({ preventScroll: true });
      const pageEl = e.currentTarget;
      const info = doc.pages[index];
      const toPdf = (clientX: number, clientY: number): Point => {
        const r = pageEl.getBoundingClientRect();
        const s = r.width / info.width;
        const x = Math.min(Math.max((clientX - r.left) / s, 0), info.width);
        const y = Math.min(Math.max((clientY - r.top) / s, 0), info.height);
        return [x + info.x0, y + info.y0];
      };
      const gen = ++selectionGen.current;
      const from = toPdf(e.clientX, e.clientY);
      let inFlight = false;
      let queued: { to: Point; mode: "chars" | "words" } | null = null;
      const request = (to: Point, mode: "chars" | "words") => {
        if (inFlight) {
          queued = { to, mode };
          return;
        }
        inFlight = true;
        engine
          .selectText(doc.docId, index, from, to, mode)
          .then((r) => {
            if (gen !== selectionGen.current) return;
            onSelection(r.quads.length ? { page: index, quads: r.quads, text: r.text } : null);
          })
          .catch((err) => console.error(err))
          .finally(() => {
            inFlight = false;
            if (queued) {
              const q = queued;
              queued = null;
              request(q.to, q.mode);
            }
          });
      };

      if (e.detail === 2) {
        request(from, "words");
        return;
      }
      let moved = false;
      const move = (ev: MouseEvent) => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
        moved = true;
        request(toPdf(ev.clientX, ev.clientY), "chars");
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        if (!moved) {
          selectionGen.current++;
          onSelection(null);
        }
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [doc, engine, onSelection],
  );

  // Výsledky hledání seskupené podle stránek.
  const hitsByPage = useMemo(() => {
    const map = new Map<number, Quad[][]>();
    for (const h of hits) {
      const list = map.get(h.page);
      if (list) list.push(h.quads);
      else map.set(h.page, [h.quads]);
    }
    return map;
  }, [hits]);
  const active = hits[activeHit];

  // Vykreslujeme jen stránky v okně a kousek okolo (virtualizace).
  const vh = viewport.height || 800;
  const [first, last] = visibleRange(layout, scroll.top - vh, scroll.top + 2 * vh);
  const pages = [];
  for (let i = first; i <= last; i++) {
    const inView = layout.tops[i] < scroll.top + vh && layout.tops[i] + layout.heights[i] > scroll.top;
    pages.push(
      <PageView
        key={`${doc.docId}:${i}`}
        engine={engine}
        docId={doc.docId}
        index={i}
        info={doc.pages[i]}
        scale={scale}
        top={layout.tops[i]}
        left={layout.lefts[i]}
        width={layout.widths[i]}
        height={layout.heights[i]}
        priority={inView ? PRIORITY_VISIBLE : PRIORITY_NEARBY}
        hits={hitsByPage.get(i)}
        activeHit={active?.page === i ? active.quads : undefined}
        selection={selection?.page === i ? selection.quads : undefined}
        onMouseDown={onPageMouseDown}
      />,
    );
  }

  return (
    <div ref={containerRef} className="viewer" tabIndex={0}>
      <div className="viewer-content" style={{ width: layout.contentWidth, height: layout.contentHeight }}>
        {pages}
      </div>
    </div>
  );
}
