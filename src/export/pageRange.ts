/**
 * Rozparsuje rozsah stránek typu "1-3, 5, 8-" (číslováno od 1) na indexy od 0.
 * Vrací null, pokud zápis není platný.
 */
export function parsePageRange(text: string, pageCount: number): number[] | null {
  const parts = text
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const result = new Set<number>();
  for (const part of parts) {
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part);
    if (m) {
      const from = m[1] ? parseInt(m[1], 10) : 1;
      const to = m[2] ? parseInt(m[2], 10) : pageCount;
      if (from < 1 || to > pageCount || from > to) return null;
      for (let i = from; i <= to; i++) result.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n < 1 || n > pageCount) return null;
      result.add(n - 1);
    } else {
      return null;
    }
  }
  return [...result].sort((a, b) => a - b);
}

/** Název souboru bez diakritiky, mezer a speciálních znaků – vhodný do URL. */
export function webSafeName(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "dokument"
  );
}

/** Odstraní znaky, které Windows v názvu souboru nedovolí. */
export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "") || "dokument";
}
