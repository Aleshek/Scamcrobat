/** A small notice in the corner when a newer version is out (desktop). */
import { useEffect } from "react";
import { Download, X } from "lucide-react";
import { useT } from "../i18n";
import { checkUpdates, dismissUpdate, useUpdates } from "../updates";

export function UpdateNotice() {
  const t = useT();
  const { available } = useUpdates();

  useEffect(() => {
    // A moment after start, so it does not slow down opening a document.
    const timer = setTimeout(() => void checkUpdates(), 5000);
    return () => clearTimeout(timer);
  }, []);

  if (!available) return null;
  return (
    <div className="update-notice" role="status">
      <span>{t.app.updateAvailable(available.version)}</span>
      <button className="btn small primary" onClick={() => window.open(available.url, "_blank")}>
        <Download size={14} /> {t.app.updateDownload}
      </button>
      <button
        className="update-close"
        onClick={() => dismissUpdate(available.version)}
        title={t.app.updateDismiss}
        aria-label={t.app.updateDismiss}
      >
        <X size={14} />
      </button>
    </div>
  );
}
