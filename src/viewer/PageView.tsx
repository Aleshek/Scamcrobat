import { memo, useEffect, useRef, useState } from "react";
import { isAbortError, type PdfEngine } from "../engine/engine";
import type { PageExtras, PageInfo, Quad } from "../engine/types";
import { useEdit } from "../annotate/context";
import { PageLayer } from "../annotate/PageLayer";

/** Upper limit of a page bitmap size (pixels) – protects memory at high zoom. */
const MAX_PIXELS = 16_000_000;

interface Props {
  engine: PdfEngine;
  docId: number;
  index: number;
  info: PageInfo;
  scale: number;
  top: number;
  left: number;
  width: number;
  height: number;
  priority: number;
  hits?: Quad[][];
  activeHit?: Quad[];
  selection?: Quad[];
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>, index: number) => void;
}

function quadBox(q: Quad, info: PageInfo, scale: number): React.CSSProperties {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return {
    left: (x0 - info.x0) * scale,
    top: (y0 - info.y0) * scale,
    width: (Math.max(...xs) - x0) * scale,
    height: (Math.max(...ys) - y0) * scale,
  };
}

export const PageView = memo(function PageView(props: Props) {
  const { engine, docId, index, info, scale, top, left, width, height } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasImage = useRef(false);
  const priorityRef = useRef(props.priority);
  priorityRef.current = props.priority;
  const [loaded, setLoaded] = useState(false);
  // The page content changes with every annotation or form edit.
  const rev = useEdit()?.pageRev(index) ?? 0;
  const lastScale = useRef(scale);
  const [renderedRev, setRenderedRev] = useState(-1);
  const [extras, setExtras] = useState<{ rev: number; data: PageExtras } | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const dpr = window.devicePixelRatio || 1;
    let renderScale = scale * dpr;
    const pixels = info.width * renderScale * info.height * renderScale;
    if (pixels > MAX_PIXELS) renderScale *= Math.sqrt(MAX_PIXELS / pixels);

    // After a zoom change wait a moment (the stretched old image is good enough meanwhile);
    // after an edit render right away.
    const zoomed = lastScale.current !== scale;
    lastScale.current = scale;
    const timer = setTimeout(
      () => {
        engine
          .render(docId, index, renderScale, { priority: priorityRef.current, signal: ctrl.signal })
          .then(({ bitmap }) => {
            const canvas = canvasRef.current;
            if (!canvas) return bitmap.close();
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
            bitmap.close();
            hasImage.current = true;
            setLoaded(true);
            setRenderedRev(rev);
          })
          .catch((e) => {
            if (!isAbortError(e)) console.error(`Failed to render page ${index + 1}`, e);
          });
      },
      hasImage.current && zoomed ? 150 : 0,
    );
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [engine, docId, index, scale, info.width, info.height, rev]);

  // Links, form fields and annotations of the page.
  useEffect(() => {
    let alive = true;
    engine.pageExtras(docId, index).then(
      (data) => alive && setExtras({ rev, data }),
      (e) => console.error(`Failed to read page ${index + 1}`, e),
    );
    return () => {
      alive = false;
    };
  }, [engine, docId, index, rev]);

  // Both the image and the extras show the latest edit.
  const settled = extras?.rev === renderedRev ? renderedRev : -1;

  return (
    <div
      className="page"
      data-page={index}
      style={{ top, left, width, height }}
      onMouseDown={(e) => props.onMouseDown(e, index)}
    >
      <canvas ref={canvasRef} className={loaded ? "page-canvas" : "page-canvas pending"} />
      {!loaded && <div className="page-placeholder">{info.label}</div>}
      <div className="page-overlay">
        {props.hits?.map((quads, i) =>
          quads.map((q, j) => (
            <div key={`h${i}-${j}`} className="hl-search" style={quadBox(q, info, scale)} />
          )),
        )}
        {props.activeHit?.map((q, j) => (
          <div key={`a${j}`} className="hl-search active" style={quadBox(q, info, scale)} />
        ))}
        {props.selection?.map((q, j) => (
          <div key={`s${j}`} className="hl-select" style={quadBox(q, info, scale)} />
        ))}
      </div>
      <PageLayer index={index} info={info} scale={scale} extras={extras?.data ?? null} settled={settled} />
    </div>
  );
});
