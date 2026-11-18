/**
 * "Reduce file size": makes a smaller copy of the document (images scaled down and
 * recompressed, unused data removed) and offers to save it or open it in a new tab.
 */
import { useState } from "react";
import { AlertTriangle, CheckCircle2, FolderOpen, Save } from "lucide-react";
import type { PdfEngine } from "../engine/engine";
import type { CompressPreset, CompressResult, Progress } from "../engine/types";
import { Modal } from "../components/Modal";
import { savePdfAs } from "../platform";
import { errorText } from "../errors";
import { useLang, useT } from "../i18n";

interface Props {
  engine: PdfEngine;
  docId: number;
  fileName: string;
  /** Default folder for saving the copy */
  defaultDir?: string;
  /** The document has unsaved changes (they go into the copy) */
  dirty: boolean;
  /** The document was written again with its changes (a new edit history) */
  onReopened(): void;
  /** Opens the copy in a new tab */
  onOpenCopy(data: Uint8Array, name: string): void;
  onSaved(name: string): void;
  onClose(): void;
}

const PRESETS: CompressPreset[] = ["small", "balanced", "high", "lossless"];
const STORAGE_KEY = "scamcrobat.compress";

function loadPreset(): CompressPreset {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as CompressPreset | null;
    if (saved && PRESETS.includes(saved)) return saved;
  } catch {
    /* localStorage may be unavailable */
  }
  return "balanced";
}

function savePreset(preset: CompressPreset) {
  try {
    localStorage.setItem(STORAGE_KEY, preset);
  } catch {
    /* not critical */
  }
}

/** File size as Windows Explorer shows it (1 KB = 1024 bytes). */
export function formatSize(bytes: number, lang: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

type Phase =
  | { kind: "setup"; error?: string }
  | { kind: "running"; progress: Progress | null }
  | { kind: "done"; result: CompressResult };

export function CompressDialog(props: Props) {
  const { engine, docId, fileName, defaultDir, onClose } = props;
  const t = useT();
  const lang = useLang();
  const [preset, setPreset] = useState<CompressPreset>(loadPreset);
  const [phase, setPhase] = useState<Phase>({ kind: "setup" });
  const [dirty, setDirty] = useState(props.dirty);

  const copyName = `${fileName.replace(/\.pdf$/i, "")}_${t.compress.suffix}.pdf`;

  async function run() {
    savePreset(preset);
    setPhase({ kind: "running", progress: null });
    try {
      const result = await engine.compress(docId, preset, (progress) => setPhase({ kind: "running", progress }));
      if (result.reopened) {
        setDirty(false); // (the changes are still unsaved, but they are in the engine's copy now)
        props.onReopened();
      }
      setPhase({ kind: "done", result });
    } catch (e) {
      setPhase({ kind: "setup", error: t.compress.failed(errorText(e)) });
    }
  }

  async function saveAs(data: Uint8Array) {
    try {
      const saved = await savePdfAs(data, copyName, defaultDir);
      if (!saved) return;
      props.onSaved(saved.name);
      onClose();
    } catch (e) {
      setPhase({ kind: "setup", error: t.compress.failed(errorText(e)) });
    }
  }

  if (phase.kind === "running") {
    const p = phase.progress;
    const images = p?.stage === "images" && p.total > 0;
    return (
      <Modal title={t.compress.title} onClose={() => {}} locked>
        <p>{images ? t.compress.progressImages(Math.min(p.done + 1, p.total), p.total) : p ? t.compress.writing : t.compress.working}</p>
        <div className="progress">
          {images ? (
            <div className="progress-bar" style={{ width: `${(p.done / p.total) * 100}%` }} />
          ) : (
            <div className="progress-bar indeterminate" />
          )}
        </div>
      </Modal>
    );
  }

  if (phase.kind === "done") {
    const { result } = phase;
    const smaller = result.after < result.before;
    const percent = new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(
      Math.max(1, Math.floor((1 - result.after / result.before) * 100)),
    );
    const change = (
      <button className="btn" onClick={() => setPhase({ kind: "setup" })}>
        {t.compress.change}
      </button>
    );
    return (
      <Modal
        title={t.compress.title}
        onClose={onClose}
        footer={
          smaller ? (
            <>
              {change}
              <button className="btn" onClick={() => props.onOpenCopy(result.data, copyName)}>
                <FolderOpen size={16} /> {t.compress.openCopy}
              </button>
              <button className="btn primary" onClick={() => void saveAs(result.data)} data-autofocus>
                <Save size={16} /> {t.compress.saveAs}
              </button>
            </>
          ) : (
            <>
              {change}
              <button className="btn primary" onClick={onClose} data-autofocus>
                {t.common.close}
              </button>
            </>
          )
        }
      >
        <div className="compress-result">
          {smaller ? <CheckCircle2 size={28} className="ok-icon" /> : <AlertTriangle size={28} className="warn-icon" />}
          <div>
            <p className="compress-sizes">
              {formatSize(result.before, lang)} → <strong>{formatSize(result.after, lang)}</strong>
              {smaller && <span className="compress-percent">{t.compress.smaller(percent)}</span>}
            </p>
            {!smaller && <p>{t.compress.notSmaller}</p>}
            {smaller && preset !== "lossless" && (
              <p className="muted">
                {result.images ? t.compress.imagesChanged(result.changed, result.images) : t.compress.noImages}
              </p>
            )}
          </div>
        </div>
        {smaller && result.signed && <div className="alert warn">{t.compress.signed}</div>}
      </Modal>
    );
  }

  return (
    <Modal
      title={t.compress.title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button className="btn primary" onClick={() => void run()}>
            {t.compress.start}
          </button>
        </>
      }
    >
      {phase.error && <div className="alert">{phase.error}</div>}
      <p className="compress-intro">{t.compress.intro}</p>
      <fieldset className="field">
        <legend>{t.compress.images}</legend>
        {PRESETS.map((id) => {
          const [label, hint] = t.compress.presets[id];
          return (
            <label key={id} className="radio compress-option">
              <input
                type="radio"
                name="compress-preset"
                checked={preset === id}
                onChange={() => setPreset(id)}
                data-autofocus={preset === id ? true : undefined}
              />
              <span>
                {label}
                <span className="hint">{hint}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {dirty && <p className="hint">{t.compress.unsaved}</p>}
    </Modal>
  );
}
