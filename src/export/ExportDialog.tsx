import { useMemo, useRef, useState } from "react";
import { CheckCircle2, FolderOpen } from "lucide-react";
import type { PdfEngine } from "../engine/engine";
import type { DocInfo, ImageFormat } from "../engine/types";
import { Modal } from "../components/Modal";
import { chooseExportTarget, isDesktop, type ExportTarget } from "../platform";
import { parsePageRange, safeFileName, webSafeName } from "./pageRange";

interface Props {
  engine: PdfEngine;
  doc: DocInfo;
  fileName: string;
  /** Výchozí složka pro výběr cíle exportu */
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
const DPI_PRESETS = [
  { dpi: 72, label: "72", hint: "náhled" },
  { dpi: 150, label: "150", hint: "web" },
  { dpi: 200, label: "200", hint: "web, ostré" },
  { dpi: 300, label: "300", hint: "tisk" },
];
const FORMATS: { id: ImageFormat; label: string; hint: string }[] = [
  { id: "jpg", label: "JPG", hint: "Nejmenší soubory, ideální pro fotky a skeny" },
  { id: "png", label: "PNG", hint: "Bezeztrátový, ostrý text, větší soubory" },
  { id: "webp", label: "WebP", hint: "Moderní formát pro web, menší než JPG" },
];

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* localStorage nemusí být dostupné */
  }
  return DEFAULTS;
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* nevadí */
  }
}

type Phase =
  | { kind: "setup" }
  | { kind: "running"; done: number; total: number }
  | { kind: "finished"; count: number; target: ExportTarget }
  | { kind: "failed"; message: string };

export function ExportDialog({ engine, doc, fileName, defaultDir, currentPage, onClose }: Props) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [scope, setScope] = useState<"all" | "current" | "range">("all");
  const [rangeText, setRangeText] = useState(`1-${doc.pageCount}`);
  const [phase, setPhase] = useState<Phase>({ kind: "setup" });
  const cancelled = useRef(false);

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  };

  const pages = useMemo(() => {
    if (scope === "all") return doc.pages.map((_, i) => i);
    if (scope === "current") return [currentPage];
    return parsePageRange(rangeText, doc.pageCount);
  }, [scope, rangeText, doc, currentPage]);

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
      setPhase({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
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
      setPhase({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }

  if (phase.kind === "running") {
    return (
      <Modal title="Export do obrázků" onClose={() => (cancelled.current = true)} locked>
        <p>
          Exportuji stránku {Math.min(phase.done + 1, phase.total)} z {phase.total}…
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
    const { count, target } = phase;
    return (
      <Modal
        title="Export dokončen"
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
            {count === 1 ? "Uložen 1 obrázek" : count < 5 ? `Uloženy ${count} obrázky` : `Uloženo ${count} obrázků`}
            <br />
            <span className="muted">{target.label}</span>
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Export do obrázků"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Zrušit
          </button>
          <button className="btn primary" disabled={!canExport} onClick={run}>
            {isDesktop ? "Vybrat složku a exportovat" : "Exportovat"}
          </button>
        </>
      }
    >
      {phase.kind === "failed" && <div className="alert">Export selhal: {phase.message}</div>}

      <fieldset className="field">
        <legend>Formát</legend>
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
        <p className="hint">{FORMATS.find((f) => f.id === settings.format)?.hint}</p>
      </fieldset>

      <fieldset className="field">
        <legend>Rozlišení (DPI)</legend>
        <div className="segmented">
          {DPI_PRESETS.map((p) => (
            <button
              key={p.dpi}
              className={settings.dpi === p.dpi ? "active" : ""}
              onClick={() => update({ dpi: p.dpi })}
              aria-pressed={settings.dpi === p.dpi}
            >
              {p.label}
              <small>{p.hint}</small>
            </button>
          ))}
          <input
            className="input dpi-input"
            type="number"
            min={36}
            max={1200}
            value={settings.dpi}
            onChange={(e) => update({ dpi: parseInt(e.target.value, 10) || 0 })}
            aria-label="Vlastní DPI"
          />
        </div>
        <p className="hint">
          {dpiValid ? (
            <>
              Výsledný obrázek: <strong>{pxW} × {pxH} px</strong>
              {pages && pages.length > 1 ? " (první stránka)" : ""}
            </>
          ) : (
            "Zadejte DPI mezi 36 a 1200."
          )}
        </p>
      </fieldset>

      {settings.format !== "png" && (
        <fieldset className="field">
          <legend>Kvalita</legend>
          <div className="range-row">
            <input
              type="range"
              min={40}
              max={100}
              value={settings.quality}
              onChange={(e) => update({ quality: parseInt(e.target.value, 10) })}
              aria-label="Kvalita"
            />
            <span className="range-value">{settings.quality}</span>
          </div>
        </fieldset>
      )}

      {doc.pageCount > 1 && (
        <fieldset className="field">
          <legend>Stránky</legend>
          <label className="radio">
            <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} />
            Všechny ({doc.pageCount})
          </label>
          <label className="radio">
            <input type="radio" checked={scope === "current"} onChange={() => setScope("current")} />
            Aktuální ({currentPage + 1})
          </label>
          <label className="radio">
            <input type="radio" checked={scope === "range"} onChange={() => setScope("range")} />
            Rozsah
            <input
              className={scope === "range" && !pages ? "input invalid" : "input"}
              value={rangeText}
              onFocus={() => setScope("range")}
              onChange={(e) => setRangeText(e.target.value)}
              placeholder="např. 1-3, 5"
            />
          </label>
        </fieldset>
      )}

      <fieldset className="field">
        <legend>Názvy souborů</legend>
        <label className="checkbox">
          <input type="checkbox" checked={settings.webNames} onChange={(e) => update({ webNames: e.target.checked })} />
          Bez diakritiky a mezer (vhodné pro web)
        </label>
        <p className="hint mono">{pages?.length ? nameFor(pages[0]) : "–"}</p>
      </fieldset>
    </Modal>
  );
}
