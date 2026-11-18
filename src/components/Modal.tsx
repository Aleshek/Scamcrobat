import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useT } from "../i18n";

interface Props {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  /** Prevents closing (e.g. while exporting) */
  locked?: boolean;
  /** A wider dialog (fields with a preview next to them) */
  wide?: boolean;
  /** At the side, without dimming the window (what it changes stays visible) */
  side?: boolean;
}

export function Modal({ title, onClose, children, footer, locked, wide, side }: Props) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // An element marked data-autofocus wins, otherwise the first field or button.
    const first =
      dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      dialogRef.current?.querySelector<HTMLElement>("input, select, button:not(.modal-close)");
    first?.focus();
    return () => prev?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !locked) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, locked]);

  return (
    <div className={side ? "modal-backdrop side" : "modal-backdrop"} onMouseDown={(e) => e.target === e.currentTarget && !locked && onClose()}>
      <div className={wide ? "modal wide" : "modal"} role="dialog" aria-modal="true" aria-label={title} ref={dialogRef}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} disabled={locked} aria-label={t.common.close}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
