/** A small picture of a page with the watermark or page number as it will be written. */
import { useEffect, useRef, useState } from "react";
import { isAbortError, PRIORITY_VISIBLE, type PdfEngine } from "../engine/engine";
import { stampMatrix, stampSize } from "../engine/stampLayout";
import type { PageInfo, Rect, Stamp } from "../engine/types";
import { cssColor } from "../annotate/tools";

/** The longer side of the preview (CSS px) */
const BOX = 220;

export type PreviewStamp = Omit<Stamp, "texts"> & { text: string };

let measureCtx: CanvasRenderingContext2D | null = null;

/** Width of a text at font size 1 in Helvetica (Arial has the same widths). */
function emWidth(text: string, bold: boolean): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 0.55;
  measureCtx.font = `${bold ? "bold " : ""}100px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(text).width / 100;
}

export function StampPreview(props: { engine: PdfEngine; docId: number; page: number; info: PageInfo; stamp: PreviewStamp }) {
  const { engine, docId, page, info, stamp } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);
  const fit = BOX / Math.max(info.width, info.height);
  const width = Math.round(info.width * fit);
  const height = Math.round(info.height * fit);

  useEffect(() => {
    const ctrl = new AbortController();
    engine
      .render(docId, page, fit * (window.devicePixelRatio || 1), { priority: PRIORITY_VISIBLE, signal: ctrl.signal })
      .then(({ bitmap }) => {
        const canvas = canvasRef.current;
        if (!canvas) return bitmap.close();
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        bitmap.close();
        setLoaded(true);
      })
      .catch((e) => {
        if (!isAbortError(e)) console.error(e);
      });
    return () => ctrl.abort();
  }, [engine, docId, page, fit]);

  const bounds: Rect = [info.x0, info.y0, info.x0 + info.width, info.y0 + info.height];
  const text = stamp.text.replace(/\s+/g, " ").trim();
  const bold = stamp.kind === "watermark";
  const em = emWidth(text, bold);
  const size = stampSize(stamp, bounds, em);
  // Text space has y up, SVG text y down: the matrix flips it.
  const [a, b, c, d, e, f] = stampMatrix(stamp, bounds, em * size, size);

  return (
    <div className="stamp-preview" style={{ width, height }}>
      <canvas ref={canvasRef} className={loaded ? undefined : "pending"} style={{ width, height }} />
      {text && (
        <svg
          viewBox={`${bounds[0]} ${bounds[1]} ${info.width} ${info.height}`}
          width={width}
          height={height}
          className={stamp.under ? "under" : undefined}
          aria-hidden
        >
          <text
            transform={`matrix(${a} ${b} ${-c} ${-d} ${e} ${f})`}
            fontSize={size}
            fontFamily="Helvetica, Arial, sans-serif"
            fontWeight={bold ? 700 : 400}
            fill={cssColor(stamp.color)}
            fillOpacity={stamp.opacity}
          >
            {text}
          </text>
        </svg>
      )}
    </div>
  );
}
