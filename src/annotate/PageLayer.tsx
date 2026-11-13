/**
 * Interactive layer above a rendered page: links, form fields, selecting, moving and
 * resizing annotations, drawing, and writing notes and text boxes. The annotations
 * themselves are drawn by MuPDF into the page image; this layer only adds what the
 * user interacts with.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Pencil, Trash } from "lucide-react";
import type { AnnotInfo, PageExtras, PageInfo, Point, Quad, Rect, WidgetInfo } from "../engine/types";
import { useT } from "../i18n";
import { useEdit, type Draft, type EditApi } from "./context";
import { colorOf, cssColor, PALETTE, rectAround, sameColor, TEXT_LINE_HEIGHT, textBoxRect } from "./tools";

const MARKUP_TYPES = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly"]);
const RESIZABLE = new Set(["FreeText", "Stamp", "Square", "Circle"]);
const COLORABLE = new Set([
  "Highlight",
  "Underline",
  "StrikeOut",
  "Squiggly",
  "Ink",
  "FreeText",
  "Text",
  "Square",
  "Circle",
  "Line",
  "Polygon",
  "PolyLine",
]);
/** Mouse movement (CSS px) that still counts as a click */
const CLICK_SLOP = 4;
/** Default width of a placed signature (points); the height follows the image. */
const SIGNATURE_WIDTH = 150;
const SIGNATURE_MAX_HEIGHT = 70;
const NOTE_SIZE = 20;
const MIN_SIZE = 8;

interface Props {
  index: number;
  info: PageInfo;
  scale: number;
  extras: PageExtras | null;
  /** Changes when the page image and extras both show the latest edit */
  settled: number;
}

interface Drag {
  id: number;
  rect: Rect;
  /** The edit was sent; the preview stays until the page shows the result. */
  committed?: boolean;
}

interface Stroke {
  points: Point[];
  done?: boolean;
}

const quadRect = (q: Quad): Rect => [
  Math.min(q[0], q[2], q[4], q[6]),
  Math.min(q[1], q[3], q[5], q[7]),
  Math.max(q[0], q[2], q[4], q[6]),
  Math.max(q[1], q[3], q[5], q[7]),
];

function resizeRect(base: Rect, corner: number, dx: number, dy: number, aspect: number): Rect {
  let [x0, y0, x1, y1] = base;
  const left = corner === 0 || corner === 3;
  const top = corner === 0 || corner === 1;
  if (left) x0 = Math.min(x0 + dx, x1 - MIN_SIZE);
  else x1 = Math.max(x1 + dx, x0 + MIN_SIZE);
  if (top) y0 = Math.min(y0 + dy, y1 - MIN_SIZE);
  else y1 = Math.max(y1 + dy, y0 + MIN_SIZE);
  if (aspect) {
    const h = (x1 - x0) / aspect;
    if (top) y0 = y1 - h;
    else y1 = y0 + h;
  }
  return [x0, y0, x1, y1];
}

/** Drops points closer than `min` to the previous one. */
function simplify(points: Point[], min: number): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= min) out.push(p);
  }
  if (out.length === 1) out.push([out[0][0] + 0.1, out[0][1] + 0.1]);
  return out;
}

export function PageLayer({ index, info, scale, extras, settled }: Props) {
  const ctx = useEdit();
  const t = useT();
  const layerRef = useRef<HTMLDivElement>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const drawing = useRef<Point[] | null>(null);
  const [ghost, setGhost] = useState<Point | null>(null);

  // The page shows the result: drop previews of edits that are already done.
  useEffect(() => {
    if (settled < 0) return;
    setDrag((d) => (d?.committed ? null : d));
    setStrokes((list) => (list.some((s) => s.done) ? list.filter((s) => !s.done) : list));
  }, [settled]);

  if (!ctx) return null;
  const { tool } = ctx;

  const X = (x: number) => (x - info.x0) * scale;
  const Y = (y: number) => (y - info.y0) * scale;
  const box = (r: Rect): CSSProperties => ({
    left: X(r[0]),
    top: Y(r[1]),
    width: (r[2] - r[0]) * scale,
    height: (r[3] - r[1]) * scale,
  });
  const toPdf = (clientX: number, clientY: number): Point => {
    const r = layerRef.current!.getBoundingClientRect();
    return [(clientX - r.left) / scale + info.x0, (clientY - r.top) / scale + info.y0];
  };
  const remember = (e: React.MouseEvent) => {
    downAt.current = { x: e.clientX, y: e.clientY };
  };
  const isClick = (e: React.MouseEvent) => {
    const d = downAt.current;
    return !!d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < CLICK_SLOP;
  };

  const annots = extras?.annots ?? [];
  const selected = ctx.selected?.page === index ? annots.find((a) => a.id === ctx.selected!.id) : undefined;
  const draft = ctx.draft?.page === index ? ctx.draft : null;

  // ---------- Moving and resizing ----------

  const startDrag = (e: React.MouseEvent, a: AnnotInfo, corner?: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    ctx.select({ page: index, id: a.id });
    const base = corner === undefined ? a.bounds : (a.rect ?? a.bounds);
    const aspect = a.type === "Stamp" ? (base[2] - base[0]) / (base[3] - base[1]) : 0;
    const start = { x: e.clientX, y: e.clientY };
    let current: Rect | null = null;
    const move = (ev: PointerEvent) => {
      if (!current && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < CLICK_SLOP) return;
      const dx = (ev.clientX - start.x) / scale;
      const dy = (ev.clientY - start.y) / scale;
      current =
        corner === undefined
          ? [base[0] + dx, base[1] + dy, base[2] + dx, base[3] + dy]
          : resizeRect(base, corner, dx, dy, aspect);
      setDrag({ id: a.id, rect: current });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!current) {
        setDrag(null);
        if (a.type === "Text" && corner === undefined) openNote(a);
        return;
      }
      const rect = current;
      setDrag({ id: a.id, rect, committed: true });
      const edit =
        corner === undefined
          ? { op: "move" as const, id: a.id, dx: rect[0] - base[0], dy: rect[1] - base[1] }
          : { op: "setRect" as const, id: a.id, rect };
      void ctx.edit(index, edit).then((r) => {
        if (!r) setDrag(null);
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const openNote = (a: AnnotInfo) =>
    ctx.setDraft({ kind: "note", page: index, at: [a.bounds[2], a.bounds[1]], id: a.id, text: a.contents });

  const editText = (a: AnnotInfo) => {
    if (a.type === "Text") return openNote(a);
    const r = a.rect ?? a.bounds;
    ctx.setDraft({
      kind: "text",
      page: index,
      at: [r[0], r[1]],
      id: a.id,
      text: a.contents,
      size: a.fontSize || 12,
      color: a.color ?? colorOf("black"),
    });
  };

  // ---------- Placing new things (capture surface) ----------

  const onCapturePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || tool !== "ink") return;
    const p = toPdf(e.clientX, e.clientY);
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = [p];
    setStrokes((list) => [...list, { points: [p] }]);
  };

  // Notes, text and signatures are placed on click – after all mouse events of the
  // press, so that nothing takes the focus from the editor that opens.
  const onCaptureClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const p = toPdf(e.clientX, e.clientY);
    if (tool === "note") {
      ctx.setDraft({ kind: "note", page: index, at: [p[0] - NOTE_SIZE / 2, p[1] - NOTE_SIZE / 2], text: "" });
    } else if (tool === "text") {
      const size = ctx.settings.textSize;
      const pad = Math.max(2, size * 0.25);
      ctx.setDraft({
        kind: "text",
        page: index,
        at: [p[0] - pad, p[1] - pad - size * 0.6],
        text: "",
        size,
        color: colorOf(ctx.settings.colors.text),
      });
    } else if (tool === "signature" && ctx.signature) {
      ctx.placeSignature(index, signatureRect(p, ctx.signature.width / ctx.signature.height));
      setGhost(null);
    }
  };

  const onCapturePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (tool === "signature") {
      setGhost(toPdf(e.clientX, e.clientY));
      return;
    }
    const pts = drawing.current;
    if (!pts) return;
    pts.push(toPdf(e.clientX, e.clientY));
    setStrokes((list) => {
      const copy = list.slice();
      copy[copy.length - 1] = { points: pts.slice() };
      return copy;
    });
  };

  const onCapturePointerUp = () => {
    const pts = drawing.current;
    if (!pts) return;
    drawing.current = null;
    const stroke: Stroke = { points: simplify(pts, 1.2 / scale) };
    setStrokes((list) => [...list.slice(0, -1), stroke]);
    void ctx
      .edit(index, {
        op: "create",
        annot: {
          type: "Ink",
          strokes: [stroke.points],
          color: colorOf(ctx.settings.colors.ink),
          width: ctx.settings.inkWidth,
        },
      })
      .then(() => {
        stroke.done = true;
      });
  };

  const capture =
    ctx.canEdit && (tool === "ink" || tool === "note" || tool === "text" || (tool === "signature" && ctx.signature));

  const sigAspect = ctx.signature ? ctx.signature.width / ctx.signature.height : 1;
  const inkColor = cssColor(colorOf(ctx.settings.colors.ink));

  return (
    <div className="page-layer" ref={layerRef}>
      {tool === "select" &&
        extras?.links.map((l, i) => (
          <div
            key={`l${i}`}
            className="pl-link"
            style={box(l.rect)}
            title={
              l.uri ? t.annotate.openLink(l.uri) : l.page !== undefined ? t.annotate.goToPage(ctx.pageLabel(l.page)) : undefined
            }
            onMouseDown={remember}
            onClick={(e) => {
              if (!isClick(e)) return;
              if (l.uri) ctx.openUri(l.uri);
              else if (l.page !== undefined) ctx.goToPage(l.page);
            }}
          />
        ))}

      {tool === "select" &&
        ctx.canEdit &&
        annots.map((a) => {
          if (MARKUP_TYPES.has(a.type) && a.quads) {
            return a.quads.map((q, j) => (
              <div
                key={`a${a.id}-${j}`}
                className="pl-annot markup"
                style={box(quadRect(q))}
                title={a.contents || undefined}
                onMouseDown={remember}
                onClick={(e) => isClick(e) && ctx.select({ page: index, id: a.id })}
              />
            ));
          }
          if (a.ink) return null; // drawn in the SVG below
          return (
            <div
              key={`a${a.id}`}
              className={a.type === "Text" ? "pl-annot box note" : "pl-annot box"}
              style={box(a.bounds)}
              title={a.type === "Text" ? a.contents || undefined : undefined}
              onMouseDown={(e) => startDrag(e, a)}
              onDoubleClick={() => (a.type === "FreeText" || a.type === "Text") && editText(a)}
            />
          );
        })}

      {tool === "select" && ctx.canEdit && annots.some((a) => a.ink) && (
        <svg className="pl-svg">
          {annots
            .filter((a) => a.ink)
            .map((a) => (
              <path
                key={a.id}
                className="pl-ink-hit"
                d={a.ink!.map((s) => s.map((p, i) => `${i ? "L" : "M"}${X(p[0])},${Y(p[1])}`).join("")).join("")}
                strokeWidth={Math.max(10, (a.width ?? 1) * scale + 8)}
                onMouseDown={(e) => startDrag(e, a)}
              />
            ))}
        </svg>
      )}

      {tool === "select" &&
        ctx.canEdit &&
        extras?.widgets.map((w) => <Field key={`w${w.id}:${w.value}`} w={w} index={index} scale={scale} box={box} ctx={ctx} />)}

      {selected && !draft && (
        <Selection
          a={selected}
          rect={drag?.id === selected.id ? drag.rect : selected.bounds}
          box={box}
          index={index}
          ctx={ctx}
          onResize={(e, corner) => startDrag(e, selected, corner)}
          onMove={(e) => startDrag(e, selected)}
          onEdit={() => editText(selected)}
        />
      )}

      {strokes.length > 0 && (
        <svg className="pl-svg preview">
          {strokes.map((s, i) => (
            <polyline
              key={i}
              points={s.points.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}
              stroke={inkColor}
              strokeWidth={Math.max(1, ctx.settings.inkWidth * scale)}
            />
          ))}
        </svg>
      )}

      {capture && (
        <div
          className={`pl-capture tool-${tool}`}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          onPointerDown={onCapturePointerDown}
          onClick={onCaptureClick}
          onPointerMove={onCapturePointerMove}
          onPointerUp={onCapturePointerUp}
          onPointerCancel={onCapturePointerUp}
          onPointerLeave={() => setGhost(null)}
        >
          {tool === "signature" && ghost && ctx.signature && (
            <img className="pl-ghost" src={ctx.signature.url} alt="" style={box(signatureRect(ghost, sigAspect))} />
          )}
        </div>
      )}

      {draft?.kind === "note" && <NotePopup key={`${draft.id ?? "new"}`} draft={draft} index={index} X={X} Y={Y} ctx={ctx} />}
      {draft?.kind === "text" && (
        <TextEditor key={`${draft.id ?? "new"}`} draft={draft} index={index} scale={scale} X={X} Y={Y} ctx={ctx} />
      )}
    </div>
  );
}

function signatureRect(at: Point, aspect: number): Rect {
  let w = SIGNATURE_WIDTH;
  let h = w / aspect;
  if (h > SIGNATURE_MAX_HEIGHT) {
    h = SIGNATURE_MAX_HEIGHT;
    w = h * aspect;
  }
  return rectAround(at, w, h);
}

// ---------- Selected annotation ----------

function Selection(props: {
  a: AnnotInfo;
  rect: Rect;
  box(r: Rect): CSSProperties;
  index: number;
  ctx: EditApi;
  onResize(e: React.MouseEvent, corner: number): void;
  onMove(e: React.MouseEvent): void;
  onEdit(): void;
}) {
  const { a, rect, ctx, index } = props;
  const t = useT();
  const style = props.box(rect);
  const resizable = RESIZABLE.has(a.type) && !!a.rect;
  const movable = !MARKUP_TYPES.has(a.type);
  const top = Number(style.top);
  const stop = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  return (
    <>
      <div
        className={movable ? "pl-sel movable" : "pl-sel"}
        style={style}
        onMouseDown={movable ? props.onMove : undefined}
        onDoubleClick={a.type === "FreeText" ? props.onEdit : undefined}
      >
        {resizable &&
          [0, 1, 2, 3].map((c) => (
            <span key={c} className={`pl-handle h${c}`} onMouseDown={(e) => props.onResize(e, c)} />
          ))}
      </div>
      <div
        className="pl-tools"
        style={{ left: Number(style.left), top: top > 44 ? top - 40 : top + Number(style.height) + 8 }}
        onMouseDown={stop}
      >
        {COLORABLE.has(a.type) &&
          PALETTE.map((p) => (
            <button
              key={p.name}
              className={sameColor(a.color, p.color) ? "pl-swatch active" : "pl-swatch"}
              style={{ background: cssColor(p.color) }}
              title={t.annotate.colors[p.name]}
              aria-label={t.annotate.colors[p.name]}
              onClick={() => void ctx.edit(index, { op: "setColor", id: a.id, color: p.color })}
            />
          ))}
        {(a.type === "FreeText" || a.type === "Text") && (
          <button className="pl-tool" title={t.annotate.edit} aria-label={t.annotate.edit} onClick={props.onEdit}>
            <Pencil size={15} />
          </button>
        )}
        <button
          className="pl-tool danger"
          title={t.annotate.delete}
          aria-label={t.annotate.delete}
          onClick={() => {
            ctx.select(null);
            void ctx.edit(index, { op: "delete", id: a.id });
          }}
        >
          <Trash size={15} />
        </button>
      </div>
    </>
  );
}

// ---------- Form fields ----------

function Field(props: { w: WidgetInfo; index: number; scale: number; box(r: Rect): CSSProperties; ctx: EditApi }) {
  const { w, index, scale, ctx } = props;
  const t = useT();
  if (w.readOnly || w.kind === "button") return null;
  const style = props.box(w.rect);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  if (w.kind === "text") {
    const height = w.rect[3] - w.rect[1];
    const size = (w.fontSize || Math.min(12, (w.multiline ? 12 : height) * 0.7)) * scale;
    const common = {
      className: w.multiline ? "pl-field text multi" : "pl-field text",
      style: { ...style, fontSize: size, lineHeight: w.multiline ? 1.15 : `${style.height}px` },
      defaultValue: w.value,
      title: w.name,
      "aria-label": w.name,
      maxLength: w.maxLen > 0 ? w.maxLen : undefined,
      spellCheck: false,
      onMouseDown: stop,
      onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (e.currentTarget.value !== w.value) void ctx.setField(index, w.id, { value: e.currentTarget.value });
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (e.key === "Escape") {
          e.currentTarget.value = w.value;
          e.currentTarget.blur();
        } else if (e.key === "Enter" && !w.multiline) {
          e.currentTarget.blur();
        }
      },
    };
    return w.multiline ? <textarea {...common} /> : <input {...common} />;
  }

  if (w.kind === "checkbox" || w.kind === "radio") {
    const on = w.value !== "" && w.value !== "Off";
    return (
      <button
        className="pl-field check"
        style={style}
        role={w.kind === "radio" ? "radio" : "checkbox"}
        aria-checked={on}
        aria-label={w.name}
        title={w.name}
        onMouseDown={stop}
        onClick={() => void ctx.setField(index, w.id, { toggle: true })}
      />
    );
  }

  if (w.kind === "combobox" || w.kind === "listbox") {
    const options = w.options ?? [];
    return (
      <select
        className="pl-field choice"
        style={{ ...style, fontSize: Math.min(12, (w.rect[3] - w.rect[1]) * 0.6) * scale }}
        value={w.value}
        aria-label={w.name}
        title={w.name}
        onMouseDown={stop}
        onChange={(e) => void ctx.setField(index, w.id, { value: e.target.value })}
      >
        {!options.includes(w.value) && <option value={w.value}>{w.value}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  // Signature field: place a signature image into it.
  return (
    <button className="pl-field sign" style={style} onMouseDown={stop} onClick={() => ctx.signField(index, w.rect)}>
      {t.annotate.signField}
    </button>
  );
}

// ---------- Notes and text boxes ----------

function NotePopup(props: {
  draft: Extract<Draft, { kind: "note" }>;
  index: number;
  X(x: number): number;
  Y(y: number): number;
  ctx: EditApi;
}) {
  const { draft, index, ctx } = props;
  const t = useT();
  const [text, setText] = useState(draft.text);
  const done = useRef(false);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    ctx.setDraft(null);
    const value = text.trimEnd();
    if (draft.id !== undefined) {
      if (value !== draft.text) void ctx.edit(index, { op: "setContents", id: draft.id, text: value });
    } else if (value) {
      const [x, y] = draft.at;
      void ctx.edit(index, {
        op: "create",
        annot: {
          type: "Text",
          rect: [x, y, x + NOTE_SIZE, y + NOTE_SIZE],
          text: value,
          color: colorOf(ctx.settings.colors.note),
        },
      });
    }
  };
  const cancel = () => {
    done.current = true;
    ctx.setDraft(null);
  };

  return (
    <div
      className="pl-popup note-popup"
      style={{ left: props.X(draft.at[0]) + (draft.id === undefined ? NOTE_SIZE : 4), top: props.Y(draft.at[1]) }}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit();
      }}
    >
      <textarea
        autoFocus
        value={text}
        placeholder={t.annotate.notePlaceholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            cancel();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            commit();
          }
        }}
      />
      <div className="note-actions">
        {draft.id !== undefined && (
          <button
            className="pl-tool danger"
            title={t.annotate.delete}
            aria-label={t.annotate.delete}
            onClick={() => {
              done.current = true;
              ctx.setDraft(null);
              ctx.select(null);
              void ctx.edit(index, { op: "delete", id: draft.id! });
            }}
          >
            <Trash size={15} />
          </button>
        )}
        <button className="pl-tool" title={t.common.done} aria-label={t.common.done} onClick={commit}>
          <Check size={16} />
        </button>
      </div>
    </div>
  );
}

function TextEditor(props: {
  draft: Extract<Draft, { kind: "text" }>;
  index: number;
  scale: number;
  X(x: number): number;
  Y(y: number): number;
  ctx: EditApi;
}) {
  const { draft, index, scale, ctx } = props;
  const t = useT();
  const done = useRef(false);
  const pad = Math.max(2, draft.size * 0.25);

  const commit = (value: string) => {
    if (done.current) return;
    done.current = true;
    ctx.setDraft(null);
    const text = value.replace(/\s+$/, "");
    if (draft.id !== undefined) {
      if (!text) {
        ctx.select(null);
        void ctx.edit(index, { op: "delete", id: draft.id });
      } else if (text !== draft.text) {
        void ctx.edit(index, { op: "setContents", id: draft.id, text, rect: textBoxRect(draft.at, text, draft.size) });
      }
    } else if (text) {
      void ctx
        .edit(index, {
          op: "create",
          annot: { type: "FreeText", rect: textBoxRect(draft.at, text, draft.size), text, color: draft.color, size: draft.size },
        })
        .then((r) => {
          if (r?.id !== undefined) ctx.select({ page: index, id: r.id });
        });
    }
  };

  return (
    <textarea
      className="pl-popup text-editor"
      autoFocus
      defaultValue={draft.text}
      placeholder={t.annotate.textPlaceholder}
      style={{
        left: props.X(draft.at[0]),
        top: props.Y(draft.at[1]),
        fontSize: draft.size * scale,
        lineHeight: TEXT_LINE_HEIGHT,
        padding: pad * scale,
        color: cssColor(draft.color),
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          done.current = true;
          ctx.setDraft(null);
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          commit(e.currentTarget.value);
        }
      }}
    />
  );
}
