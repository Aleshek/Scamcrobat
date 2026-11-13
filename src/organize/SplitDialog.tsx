import { useMemo, useRef, useState } from "react";
import { CheckCircle2, FolderOpen } from "lucide-react";
import type { PdfEngine } from "../engine/engine";
import { Modal } from "../components/Modal";
import { chooseExportTarget, isDesktop, type ExportTarget } from "../platform";
import { safeFileName } from "../export/pageRange";
import { errorText } from "../errors";
import { useT } from "../i18n";
import { chunkGroups, groupLabel, parseRangeGroups, toRefs, type OrgPage } from "./model";

interface Props {
  engine: PdfEngine;
  pages: OrgPage[];
  /** The original document (bookmarks, metadata) */
  base?: number;
  baseName: string;
  baseDir?: string;
  onClose(): void;
}

type Mode = "each" | "chunk" | "ranges";

type Phase =
  | { kind: "setup" }
  | { kind: "running"; done: number; total: number }
  | { kind: "finished"; count: number; target: ExportTarget }
  | { kind: "failed"; message: string };

export function SplitDialog({ engine, pages, base, baseName, baseDir, onClose }: Props) {
  const t = useT();
  const count = pages.length;
  const [mode, setMode] = useState<Mode>("each");
  const [chunk, setChunk] = useState(2);
  const [rangesText, setRangesText] = useState(() => {
    const half = Math.ceil(count / 2);
    return count > 2 ? `1-${half}, ${half + 1}-${count}` : "1, 2";
  });
  const [phase, setPhase] = useState<Phase>({ kind: "setup" });
  const cancelled = useRef(false);

  const groups = useMemo(() => {
    if (mode === "each") return chunkGroups(count, 1);
    if (mode === "chunk") return chunk >= 1 ? chunkGroups(count, chunk) : null;
    return parseRangeGroups(rangesText, count);
  }, [mode, chunk, rangesText, count]);

  const stem = safeFileName(baseName);
  const nameFor = (group: number[]) => `${stem}_${groupLabel(group, t.organize.selectionSuffix)}.pdf`;

  async function run() {
    if (!groups?.length) return;
    let target: ExportTarget | null;
    try {
      target = await chooseExportTarget(baseDir);
    } catch (e) {
      setPhase({ kind: "failed", message: errorText(e) });
      return;
    }
    if (!target) return;
    cancelled.current = false;
    setPhase({ kind: "running", done: 0, total: groups.length });
    try {
      let done = 0;
      for (const group of groups) {
        if (cancelled.current) break;
        const data = await engine.buildPdf(toRefs(group.map((i) => pages[i])), base);
        await target.write(nameFor(group), data);
        done++;
        setPhase({ kind: "running", done, total: groups.length });
      }
      setPhase({ kind: "finished", count: done, target });
    } catch (e) {
      setPhase({ kind: "failed", message: errorText(e) });
    }
  }

  if (phase.kind === "running") {
    return (
      <Modal title={t.split.title} onClose={() => (cancelled.current = true)} locked>
        <p>{t.split.running(Math.min(phase.done + 1, phase.total), phase.total)}</p>
        <div className="progress">
          <div className="progress-bar" style={{ width: `${(phase.done / phase.total) * 100}%` }} />
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => (cancelled.current = true)}>
            {t.common.stop}
          </button>
        </div>
      </Modal>
    );
  }

  if (phase.kind === "finished") {
    const { count: saved, target } = phase;
    return (
      <Modal
        title={t.split.finishedTitle}
        onClose={onClose}
        footer={
          <>
            {target.reveal && (
              <button className="btn" onClick={target.reveal}>
                <FolderOpen size={16} /> {t.common.openFolder}
              </button>
            )}
            <button className="btn primary" onClick={onClose}>
              {t.common.done}
            </button>
          </>
        }
      >
        <div className="export-done">
          <CheckCircle2 size={28} className="ok-icon" />
          <p>
            {t.split.saved(t.common.files(saved))}
            <br />
            <span className="muted">{target.label}</span>
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={t.split.title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button className="btn primary" disabled={!groups?.length} onClick={run}>
            {isDesktop ? t.split.chooseAndSplit : t.split.split}
          </button>
        </>
      }
    >
      {phase.kind === "failed" && <div className="alert">{t.split.failed(phase.message)}</div>}

      <fieldset className="field">
        <legend>{t.split.how}</legend>
        <label className="radio">
          <input type="radio" checked={mode === "each"} onChange={() => setMode("each")} />
          {t.split.each}
        </label>
        <label className="radio">
          <input type="radio" checked={mode === "chunk"} onChange={() => setMode("chunk")} />
          {t.split.chunkBefore}
          <input
            className="input split-num"
            type="number"
            min={1}
            max={count}
            value={chunk}
            onFocus={() => setMode("chunk")}
            onChange={(e) => setChunk(parseInt(e.target.value, 10) || 0)}
            aria-label={t.split.chunkLabel}
          />
          {t.split.chunkAfter}
        </label>
        <label className="radio">
          <input type="radio" checked={mode === "ranges"} onChange={() => setMode("ranges")} />
          {t.split.byRanges}
          <input
            className={mode === "ranges" && !groups ? "input invalid" : "input"}
            value={rangesText}
            onFocus={() => setMode("ranges")}
            onChange={(e) => setRangesText(e.target.value)}
            placeholder={t.split.rangesPlaceholder}
          />
        </label>
        <p className="hint">
          {mode === "ranges" ? t.split.rangesHint : t.split.docHas(t.common.pages(count))}
        </p>
      </fieldset>

      <fieldset className="field">
        <legend>{t.split.result}</legend>
        {groups?.length ? (
          <>
            <p className="hint">{t.common.files(groups.length)}:</p>
            <p className="hint mono">
              {groups.slice(0, 3).map(nameFor).join(", ")}
              {groups.length > 3 && `, … ${nameFor(groups[groups.length - 1])}`}
            </p>
          </>
        ) : (
          <p className="hint error">{t.split.invalid(count)}</p>
        )}
      </fieldset>
    </Modal>
  );
}
