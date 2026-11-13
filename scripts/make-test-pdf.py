"""Generates the test PDF (several pages, outline, Czech diacritics, a landscape page).

The text is intentionally Czech: it exercises accented characters in rendering,
search and text selection.

Usage: python scripts/make-test-pdf.py  ->  test/fixtures/sample.pdf
"""
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "fixtures" / "sample.pdf"

FONT_CANDIDATES = [Path(r"C:\Windows\Fonts\arial.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")]
font_file = next((p for p in FONT_CANDIDATES if p.exists()), None)
font = pymupdf.Font(fontfile=str(font_file)) if font_file else pymupdf.Font("helv")

LOREM = "Příliš žluťoučký kůň úpěl ďábelské ódy. Scamcrobat zkouší hledání a výběr textu."

doc = pymupdf.open()
for i in range(6):
    landscape = i == 3
    page = doc.new_page(width=842 if landscape else 595, height=595 if landscape else 842)
    tw = pymupdf.TextWriter(page.rect)
    tw.append((72, 90), f"Kapitola {i + 1}", font=font, fontsize=24)
    y = 130
    for k in range(10 if landscape else 30):
        line = f"Řádek {k + 1}: hledané slovo kopretina na straně {i + 1}." if k % 4 == 0 else LOREM
        tw.append((72, y), line, font=font, fontsize=11)
        y += 18
    tw.write_text(page)

doc.set_toc([[1, "Úvod", 1], [1, "Druhá kapitola", 2], [2, "Podkapitola", 3], [1, "Na šířku", 4], [1, "Závěr", 6]])
doc.set_metadata({"title": "Testovací dokument Scamcrobat"})
OUT.parent.mkdir(parents=True, exist_ok=True)
doc.subset_fonts()
doc.save(OUT, garbage=4, deflate=True)
print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size // 1024} kB, {doc.page_count} stran")
