import { useMemo, useRef, useState } from "react";
import { CheckCircle2, FolderOpen } from "lucide-react";
import type { PdfEngine } from "../engine/engine";
import type { DocInfo, ImageFormat } from "../engine/types";
import { Modal } from "../components/Modal";
import { PageScopeField, usePageScope } from "../components/PageScope";
import { chooseExportTarget, isDesktop, type ExportTarget } from "../platform";
import { errorText } from "../errors";
import { useT } from "../i18n";
import { safeFileName, webSafeName } from "./pageRange";

interface Props {
  engine: PdfEngine;
  doc: DocInfo;
  fileName: string;
  /** Default folder offered when choosing the export destination */
  defaultDir?: string;
  currentPage: number;
  onClose(): void;
}

interface Settings {
  format: ImageFormat;
  dpi: number;
  quality: number;
  webNames: boolean;
}

const STORAGE_KEY = "scamcrobat.export";
const DEFAULTS: Settings = { format: "jpg", dpi: 200, quality: 85, webNames: false };
const DPI_PRESETS = [72, 150, 200, 300];
const FORMATS: { id: ImageFormat; label: string }[] = [
  { id: "jpg", label: "JPG" },
  { id: "png", label: "PNG" },
  { id: "webp", label: "WebP" },
];

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* localStorage may be unavailable */
  }
  return DEFAULTS;
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* not critical */
  }
}

type Phase =
  | { kind: "setup" }
  | { kind: "running"; done: number; total: number }
  | { kind: "finished"; count: number; target: ExportTarget }
  | { kind: "failed"; message: string };

export function ExportDialog({ engine, doc, fileName, defaultDir, currentPage, onClose }: Props) {
  const t = useT();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const scope = usePageScope(doc.pageCount, currentPage);
  const pages = scope.pages;
  const [phase, setPhase] = useState<Phase>({ kind: "setup" });
  const cancelled = useRef(false);

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  };

  const sample = doc.pages[pages?.[0] ?? 0];
  const pxW = Math.round((sample.width * settings.dpi) / 72);
  const pxH = Math.round((sample.height * settings.dpi) / 72);
  const dpiValid = settings.dpi >= 36 && settings.dpi <= 1200;
  const canExport = !!pages?.length && dpiValid;

  const baseName = useMemo(() => {
    const stem = fileName.replace(/\.pdf$/i, "");
    return settings.webNames ? webSafeName(stem) : safeFileName(stem);
  }, [fileName, settings.webNames]);
  const digits = String(doc.pageCount).length;
  const nameFor = (page: number) =>
    doc.pageCount === 1 ? `${baseName}.${settings.format}` : `${baseName}_p${String(page + 1).padStart(digits, "0")}.${settings.format}`;

  async function run() {
    if (!pages?.length) return;
    let target: ExportTarget | null;
    try {
      target = await chooseExportTarget(defaultDir);
    } catch (e) {
      setPhase({ kind: "failed", message: errorText(e) });
      return;
    }
    if (!target) return;
    cancelled.current = false;
    setPhase({ kind: "running", done: 0, total: pages.length });
    try {
      let count = 0;
      for (const page of pages) {
        if (cancelled.current) break;
        const { data } = await engine.exportPage(doc.docId, page, settings.dpi, settings.format, settings.quality);
        await target.write(nameFor(page), data);
        count++;
        setPhase({ kind: "running", done: count, total: pages.length });
      }
      setPhase({ kind: "finished", count, target });
    } catch (e) {
      setPhase({ kind: "failed", message: errorText(e) });
    }
  }

  if (phase.kind === "running") {
    return (
      <Modal title={t.export.title} onClose={() => (cancelled.current = true)} locked>
        <p>{t.export.running(Math.min(phase.done + 1, phase.total), phase.total)}</p>
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
    const { count, target } = phase;
    return (
      <Modal
        title={t.export.finishedTitle}
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
            {t.export.saved(count)}
            <br />
            <span className="muted">{target.label}</span>
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={t.export.title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button className="btn primary" disabled={!canExport} onClick={run}>
            {isDesktop ? t.export.chooseAndExport : t.export.export}
          </button>
        </>
      }
    >
      {phase.kind === "failed" && <div className="alert">{t.export.failed(phase.message)}</div>}

      <fieldset className="field">
        <legend>{t.export.format}</legend>
        <div className="segmented">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              className={settings.format === f.id ? "active" : ""}
              onClick={() => update({ format: f.id })}
              aria-pressed={settings.format === f.id}
            >
              {f.label}
            </button>
          ))}
        </div>
        <p className="hint">{t.export.formatHints[settings.format]}</p>
      </fieldset>

      <fieldset className="field">
        <legend>{t.export.resolution}</legend>
        <div className="segmented">
          {DPI_PRESETS.map((dpi) => (
            <button
              key={dpi}
              className={settings.dpi === dpi ? "active" : ""}
              onClick={() => update({ dpi })}
              aria-pressed={settings.dpi === dpi}
            >
              {dpi}
              <small>{t.export.dpiHints[dpi]}</small>
            </button>
          ))}
          <input
            className="input dpi-input"
            type="number"
            min={36}
            max={1200}
            value={settings.dpi}
            onChange={(e) => update({ dpi: parseInt(e.target.value, 10) || 0 })}
            aria-label={t.export.customDpi}
          />
        </div>
        <p className="hint">
          {dpiValid ? (
            <>
              {t.export.resultSize}{" "}
              <strong>
                {pxW} × {pxH} px
              </strong>
              {pages && pages.length > 1 ? t.export.firstPage : ""}
            </>
          ) : (
            t.export.dpiInvalid
          )}
        </p>
      </fieldset>

      {settings.format !== "png" && (
        <fieldset className="field">
          <legend>{t.export.quality}</legend>
          <div className="range-row">
            <input
              type="range"
              min={40}
              max={100}
              value={settings.quality}
              onChange={(e) => update({ quality: parseInt(e.target.value, 10) })}
              aria-label={t.export.quality}
            />
            <span className="range-value">{settings.quality}</span>
          </div>
        </fieldset>
      )}

      {doc.pageCount > 1 && <PageScopeField state={scope} pageCount={doc.pageCount} currentPage={currentPage} />}

      <fieldset className="field">
        <legend>{t.export.fileNames}</legend>
        <label className="checkbox">
          <input type="checkbox" checked={settings.webNames} onChange={(e) => update({ webNames: e.target.checked })} />
          {t.export.webNames}
        </label>
        <p className="hint mono">{pages?.length ? nameFor(pages[0]) : "–"}</p>
      </fieldset>
    </Modal>
  );
}
