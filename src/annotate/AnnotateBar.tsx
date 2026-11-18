/** Second toolbar row with the annotation tools, or the editing tools (text, redaction). */
import {
  Highlighter,
  MousePointer2,
  PenLine,
  RectangleHorizontal,
  Redo2,
  Signature,
  StickyNote,
  Strikethrough,
  TextCursorInput,
  TextSelect,
  Type,
  Underline,
  Undo2,
  X,
} from "lucide-react";
import { useT } from "../i18n";
import { cssColor, INK_WIDTHS, PALETTE, TEXT_SIZES, type Tool, type ToolSettings } from "./tools";

interface Props {
  mode: "annotate" | "edit";
  tool: Tool;
  settings: ToolSettings;
  canUndo: boolean;
  canRedo: boolean;
  onTool(tool: Tool): void;
  onSettings(settings: ToolSettings): void;
  onUndo(): void;
  onRedo(): void;
  onClose(): void;
}

export function AnnotateBar(props: Props) {
  const { tool, settings } = props;
  const t = useT();
  const a = t.annotate;

  const editing = props.mode === "edit";
  const select = { id: "select" as Tool, icon: <MousePointer2 size={17} />, label: a.select };
  /** Tools, with a separator before each group */
  const tools: { id: Tool; icon: React.ReactNode; label: string; sep?: boolean }[] = editing
    ? [
        select,
        { id: "edittext", icon: <TextCursorInput size={17} />, label: a.editText, sep: true },
        { id: "redact", icon: <TextSelect size={17} />, label: a.redactText, sep: true },
        { id: "redactarea", icon: <RectangleHorizontal size={17} fill="currentColor" />, label: a.redactArea },
      ]
    : [
        select,
        { id: "highlight", icon: <Highlighter size={17} />, label: a.highlight, sep: true },
        { id: "underline", icon: <Underline size={17} />, label: a.underline },
        { id: "strikeout", icon: <Strikethrough size={17} />, label: a.strikeout },
        { id: "note", icon: <StickyNote size={17} />, label: a.note, sep: true },
        { id: "text", icon: <Type size={17} />, label: a.text },
        { id: "ink", icon: <PenLine size={17} />, label: a.draw },
        { id: "signature", icon: <Signature size={17} />, label: a.signature, sep: true },
      ];

  const hasColor = !editing && tool !== "select" && tool !== "signature";
  const color = settings.colors[tool];
  const setColor = (name: string) => props.onSettings({ ...settings, colors: { ...settings.colors, [tool]: name } });

  return (
    <div className="annotate-bar" role="toolbar" aria-label={editing ? t.toolbar.edit : t.toolbar.annotate}>
      <div className="ab-group">
        {tools.map((x) => (
          <span key={x.id} className="ab-item">
            {x.sep && <span className="tb-sep" />}
            <button
              className={tool === x.id ? "tb-btn toggled" : "tb-btn"}
              aria-pressed={tool === x.id}
              title={x.label}
              aria-label={x.label}
              onClick={() => props.onTool(x.id)}
            >
              {x.icon}
            </button>
          </span>
        ))}
      </div>

      {hasColor && (
        <div className="ab-group">
          <span className="tb-sep" />
          {PALETTE.map((p) => (
            <button
              key={p.name}
              className={color === p.name ? "ab-swatch active" : "ab-swatch"}
              style={{ background: cssColor(p.color) }}
              title={a.colors[p.name]}
              aria-label={a.colors[p.name]}
              aria-pressed={color === p.name}
              onClick={() => setColor(p.name)}
            />
          ))}
        </div>
      )}

      {tool === "ink" && (
        <div className="ab-group">
          <span className="tb-sep" />
          {INK_WIDTHS.map((w, i) => {
            const label = [a.thin, a.medium, a.thick][i];
            return (
              <button
                key={w}
                className={settings.inkWidth === w ? "tb-btn toggled" : "tb-btn"}
                title={label}
                aria-label={label}
                aria-pressed={settings.inkWidth === w}
                onClick={() => props.onSettings({ ...settings, inkWidth: w })}
              >
                <span className="ab-line" style={{ height: Math.max(1, w * 1.2) }} />
              </button>
            );
          })}
        </div>
      )}

      {tool === "text" && (
        <div className="ab-group">
          <span className="tb-sep" />
          <select
            className="tb-input ab-size"
            value={settings.textSize}
            title={a.fontSize}
            aria-label={a.fontSize}
            onChange={(e) => props.onSettings({ ...settings, textSize: Number(e.target.value) })}
          >
            {TEXT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s} pt
              </option>
            ))}
          </select>
        </div>
      )}

      <span className={tool === "redact" || tool === "redactarea" ? "ab-hint warn" : "ab-hint"}>
        {a.hints[tool]}
      </span>

      <div className="ab-group">
        <button className="tb-btn" disabled={!props.canUndo} onClick={props.onUndo} title={a.undo} aria-label={a.undo}>
          <Undo2 size={17} />
        </button>
        <button className="tb-btn" disabled={!props.canRedo} onClick={props.onRedo} title={a.redo} aria-label={a.redo}>
          <Redo2 size={17} />
        </button>
        <span className="tb-sep" />
        <button
          className="tb-btn"
          onClick={props.onClose}
          title={editing ? a.closeEdit : a.close}
          aria-label={editing ? a.closeEdit : a.close}
        >
          <X size={17} />
        </button>
      </div>
    </div>
  );
}
