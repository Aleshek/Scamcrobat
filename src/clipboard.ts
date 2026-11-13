/** Zapíše text do schránky; když moderní API selže (chybí oprávnění), použije starší cestu přes textarea. */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* zkusíme záložní způsob */
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
  if (!ok) throw new Error("Schránka není dostupná");
}
