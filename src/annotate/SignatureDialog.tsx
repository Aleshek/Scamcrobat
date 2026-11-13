/** Creating a signature (drawing it or loading a photo of it) or picking a saved one. */
import { useEffect, useRef, useState } from "react";
import { ImageUp, X } from "lucide-react";
import { Modal } from "../components/Modal";
import { useT } from "../i18n";
import {
  forgetSignature,
  loadSignatures,
  rememberSignature,
  signatureFromCanvas,
  signatureFromFile,
  type Signature,
} from "./signatures";

interface Props {
  onClose(): void;
  onUse(sig: Signature): void;
}

const INKS = ["#1a1a1a", "#1d3fbf"];
const PAD_WIDTH = 418;
const PAD_HEIGHT = 160;
const PIXEL_RATIO = 2;
const REMEMBER_KEY = "scamcrobat.rememberSignature";

function readRemember() {
  try {
    return localStorage.getItem(REMEMBER_KEY) !== "0";
  } catch {
    return true;
  }
}

export function SignatureDialog({ onClose, onUse }: Props) {
  const t = useT();
  const s = t.signature;
  const [saved, setSaved] = useState(loadSignatures);
  const [mode, setMode] = useState<"draw" | "image">("draw");
  const [ink, setInk] = useState(INKS[0]);
  const [hasDrawing, setHasDrawing] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [removeBg, setRemoveBg] = useState(true);
  const [fromImage, setFromImage] = useState<Signature | null>(null);
  const [imageError, setImageError] = useState(false);
  const [remember, setRemember] = useState(readRemember);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Loading and processing the chosen image.
  useEffect(() => {
    if (!file) return;
    let alive = true;
    setImageError(false);
    signatureFromFile(file, removeBg).then(
      (sig) => {
        if (!alive) return;
        setFromImage(sig);
        setImageError(!sig);
      },
      () => alive && (setFromImage(null), setImageError(true)),
    );
    return () => {
      alive = false;
    };
  }, [file, removeBg]);

  // ---------- Drawing pad ----------

  const last = useRef<{ x: number; y: number; mx: number; my: number } | null>(null);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * e.currentTarget.width, y: ((e.clientY - r.top) / r.height) * e.currentTarget.height };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    last.current = { ...p, mx: p.x, my: p.y };
    const ctx = e.currentTarget.getContext("2d")!;
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.4 * PIXEL_RATIO, 0, Math.PI * 2);
    ctx.fill();
    setHasDrawing(true);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const prev = last.current;
    if (!prev) return;
    const p = point(e);
    const ctx = e.currentTarget.getContext("2d")!;
    const pressure = e.pointerType === "pen" && e.pressure > 0 ? 0.55 + e.pressure * 0.9 : 1;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.6 * PIXEL_RATIO * pressure;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Smooth curve through the midpoints of the movement.
    const mx = (prev.x + p.x) / 2;
    const my = (prev.y + p.y) / 2;
    ctx.beginPath();
    ctx.moveTo(prev.mx, prev.my);
    ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
    ctx.stroke();
    last.current = { ...p, mx, my };
  };

  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const prev = last.current;
    last.current = null;
    if (!prev) return;
    // Finish the stroke from the last midpoint to where the pen was lifted.
    const ctx = e.currentTarget.getContext("2d")!;
    ctx.beginPath();
    ctx.moveTo(prev.mx, prev.my);
    ctx.lineTo(prev.x, prev.y);
    ctx.stroke();
  };

  const clear = () => {
    const c = canvasRef.current;
    c?.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setHasDrawing(false);
  };

  // ---------- Result ----------

  const ready = mode === "draw" ? hasDrawing : !!fromImage;

  const use = () => {
    const sig = mode === "draw" ? (canvasRef.current ? signatureFromCanvas(canvasRef.current) : null) : fromImage;
    if (!sig) return;
    try {
      localStorage.setItem(REMEMBER_KEY, remember ? "1" : "0");
    } catch {
      /* not critical */
    }
    if (remember) rememberSignature(sig);
    onUse(sig);
  };

  return (
    <Modal
      title={s.title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button className="btn primary" disabled={!ready} onClick={use}>
            {s.use}
          </button>
        </>
      }
    >
      {saved.length > 0 && (
        <fieldset className="field">
          <legend>{s.saved}</legend>
          <div className="sig-saved">
            {saved.map((sig) => (
              <div key={sig.id} className="sig-card">
                <button className="sig-pick" onClick={() => onUse(sig)} title={s.useSaved} aria-label={s.useSaved}>
                  <img src={sig.url} alt="" />
                </button>
                <button
                  className="sig-remove"
                  title={s.deleteSaved}
                  aria-label={s.deleteSaved}
                  onClick={() => {
                    forgetSignature(sig.id);
                    setSaved(loadSignatures());
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </fieldset>
      )}

      <div className="segmented sig-modes">
        {(["draw", "image"] as const).map((m) => (
          <button key={m} className={mode === m ? "active" : ""} aria-pressed={mode === m} onClick={() => setMode(m)}>
            {m === "draw" ? s.draw : s.image}
          </button>
        ))}
      </div>

      {mode === "draw" ? (
        <div className="field">
          <div className="sig-pad">
            <canvas
              ref={canvasRef}
              width={PAD_WIDTH * PIXEL_RATIO}
              height={PAD_HEIGHT * PIXEL_RATIO}
              style={{ width: "100%", aspectRatio: `${PAD_WIDTH} / ${PAD_HEIGHT}` }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              data-autofocus
              tabIndex={0}
              aria-label={s.drawHint}
            />
            <span className="sig-baseline" />
          </div>
          <div className="sig-row">
            <span className="hint">{s.drawHint}</span>
            <span className="sig-inks" title={s.inkColor}>
              {INKS.map((c) => (
                <button
                  key={c}
                  className={ink === c ? "ab-swatch active" : "ab-swatch"}
                  style={{ background: c }}
                  aria-label={s.inkColor}
                  aria-pressed={ink === c}
                  onClick={() => setInk(c)}
                />
              ))}
            </span>
            <button className="btn small" onClick={clear} disabled={!hasDrawing}>
              {s.clear}
            </button>
          </div>
        </div>
      ) : (
        <div className="field">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="sig-pad image">
            {fromImage ? (
              <img src={fromImage.url} alt="" />
            ) : (
              <button className="btn" onClick={() => fileRef.current?.click()}>
                <ImageUp size={16} /> {s.chooseImage}
              </button>
            )}
          </div>
          {imageError && <p className="hint error">{s.loadFailed}</p>}
          <div className="sig-row">
            <label className="checkbox">
              <input type="checkbox" checked={removeBg} onChange={(e) => setRemoveBg(e.target.checked)} />
              {s.removeBackground}
            </label>
            {fromImage && (
              <button className="btn small" onClick={() => fileRef.current?.click()}>
                {s.chooseImage}
              </button>
            )}
          </div>
          {!fromImage && <p className="hint">{s.imageHint}</p>}
        </div>
      )}

      <label className="checkbox">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        {s.remember}
      </label>
      <p className="hint">{s.privacy}</p>
    </Modal>
  );
}
