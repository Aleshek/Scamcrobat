import { msg } from "./i18n";

/** Writes text to the clipboard; when the modern API fails (no permission), falls back to a textarea. */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* try the fallback */
  }
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  active?.focus({ preventScroll: true });
  if (!ok) throw new Error(msg().errors.clipboardUnavailable);
}
