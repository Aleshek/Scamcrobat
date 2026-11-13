"""Převod PDF stránek na JPG (PyMuPDF).

Použití:
    python pdf2jpg.py <soubor.pdf | složka> [--dpi 200] [--quality 85] [--out JPG]

Jednostránkové PDF -> nazev.jpg, vícestránkové -> nazev_p1.jpg, nazev_p2.jpg, ...
"""
import argparse
import sys
from pathlib import Path

import pymupdf as fitz


def convert(pdf: Path, out_dir: Path, dpi: int, quality: int) -> list[Path]:
    written = []
    with fitz.open(pdf) as doc:
        for i, page in enumerate(doc, start=1):
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            suffix = "" if doc.page_count == 1 else f"_p{i}"
            target = out_dir / f"{pdf.stem}{suffix}.jpg"
            pix.save(target, jpg_quality=quality)
            written.append(target)
    return written


def main() -> int:
    ap = argparse.ArgumentParser(description="Převod PDF na JPG")
    ap.add_argument("source", type=Path, help="PDF soubor nebo složka s PDF")
    ap.add_argument("--dpi", type=int, default=200, help="rozlišení (výchozí 200)")
    ap.add_argument("--quality", type=int, default=85, help="kvalita JPG 1-100 (výchozí 85)")
    ap.add_argument("--out", type=Path, default=None, help="výstupní složka (výchozí: <zdroj>/JPG)")
    args = ap.parse_args()

    src = args.source
    pdfs = sorted(src.glob("*.pdf")) if src.is_dir() else [src]
    if not pdfs:
        print(f"Žádné PDF v {src}", file=sys.stderr)
        return 1

    out_dir = args.out or ((src if src.is_dir() else src.parent) / "JPG")
    out_dir.mkdir(parents=True, exist_ok=True)

    for pdf in pdfs:
        for f in convert(pdf, out_dir, args.dpi, args.quality):
            print(f"{f.name}  ({f.stat().st_size // 1024} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
