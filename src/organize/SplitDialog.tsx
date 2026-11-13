import { useMemo, useRef, useState } from "react";
import { CheckCircle2, FolderOpen } from "lucide-react";
import type { PdfEngine } from "../engine/engine";
import { Modal } from "../components/Modal";
import { chooseExportTarget, isDesktop, type ExportTarget } from "../platform";
import { safeFileName } from "../export/pageRange";
import { chunkGroups, groupLabel, pageCountLabel, parseRangeGroups, toRefs, type OrgPage } from "./model";

interface Props {
  engine: PdfEngine;
  pages: OrgPage[];
  /** Původní dokument (záložky, metadata) */
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

const filesLabel = (n: number) => (n === 1 ? "1 soubor" : n >= 2 && n <= 4 ? `${n} soubory` : `${n} souborů`);

export function SplitDialog({ engine, pages, base, baseName, baseDir, onClose }: Props) {
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
  const nameFor = (group: number[]) => `${stem}_${groupLabel(group)}.pdf`;

  async function run() {
    if (!groups?.length) return;
    let target: ExportTarget | null;
    try {
      target = await chooseExportTarget(baseDir);
    } catch (e) {
      setPhase({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
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
      setPhase({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }

  if (phase.kind === "running") {
    return (
      <Modal title="Rozdělit PDF" onClose={() => (cancelled.current = true)} locked>
        <p>
          Ukládám soubor {Math.min(phase.done + 1, phase.total)} z {phase.total}…
        </p>
        <div className="progress">
          <div className="progress-bar" style={{ width: `${(phase.done / phase.total) * 100}%` }} />
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => (cancelled.current = true)}>
            Zastavit
          </button>
        </div>
      </Modal>
    );
  }

  if (phase.kind === "finished") {
    const { count: saved, target } = phase;
    return (
      <Modal
        title="Rozdělení dokončeno"
        onClose={onClose}
        footer={
          <>
            {target.reveal && (
              <button className="btn" onClick={target.reveal}>
                <FolderOpen size={16} /> Otevřít složku
              </button>
            )}
            <button className="btn primary" onClick={onClose}>
              Hotovo
            </button>
          </>
        }
      >
        <div className="export-done">
          <CheckCircle2 size={28} className="ok-icon" />
          <p>
            Uloženo: {filesLabel(saved)}
            <br />
            <span className="muted">{target.label}</span>
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Rozdělit PDF"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Zrušit
          </button>
          <button className="btn primary" disabled={!groups?.length} onClick={run}>
            {isDesktop ? "Vybrat složku a rozdělit" : "Rozdělit"}
          </button>
        </>
      }
    >
      {phase.kind === "failed" && <div className="alert">Rozdělení selhalo: {phase.message}</div>}

      <fieldset className="field">
        <legend>Jak rozdělit</legend>
        <label className="radio">
          <input type="radio" checked={mode === "each"} onChange={() => setMode("each")} />
          Každou stránku zvlášť
        </label>
        <label className="radio">
          <input type="radio" checked={mode === "chunk"} onChange={() => setMode("chunk")} />
          Po
          <input
            className="input split-num"
            type="number"
            min={1}
            max={count}
            value={chunk}
            onFocus={() => setMode("chunk")}
            onChange={(e) => setChunk(parseInt(e.target.value, 10) || 0)}
            aria-label="Počet stránek v jednom souboru"
          />
          stránkách
        </label>
        <label className="radio">
          <input type="radio" checked={mode === "ranges"} onChange={() => setMode("ranges")} />
          Podle rozsahů
          <input
            className={mode === "ranges" && !groups ? "input invalid" : "input"}
            value={rangesText}
            onFocus={() => setMode("ranges")}
            onChange={(e) => setRangesText(e.target.value)}
            placeholder="např. 1-3, 4-6, 7-"
          />
        </label>
        <p className="hint">
          {mode === "ranges"
            ? "Každý rozsah oddělený čárkou bude samostatný soubor."
            : `Dokument má ${pageCountLabel(count)}.`}
        </p>
      </fieldset>

      <fieldset className="field">
        <legend>Výsledek</legend>
        {groups?.length ? (
          <>
            <p className="hint">{filesLabel(groups.length)}:</p>
            <p className="hint mono">
              {groups.slice(0, 3).map(nameFor).join(", ")}
              {groups.length > 3 && `, … ${nameFor(groups[groups.length - 1])}`}
            </p>
          </>
        ) : (
          <p className="hint error">Zadejte platné rozsahy stránek (1–{count}).</p>
        )}
      </fieldset>
    </Modal>
  );
}
