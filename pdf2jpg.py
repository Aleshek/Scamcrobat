"""Converts PDF pages to JPG (PyMuPDF).

Usage:
    python pdf2jpg.py <file.pdf | folder> [--dpi 200] [--quality 85] [--out JPG]

Single page PDF -> name.jpg, multi-page -> name_p1.jpg, name_p2.jpg, ...
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
    ap = argparse.ArgumentParser(description="Convert PDF to JPG")
    ap.add_argument("source", type=Path, help="a PDF file or a folder with PDFs")
    ap.add_argument("--dpi", type=int, default=200, help="resolution (default 200)")
    ap.add_argument("--quality", type=int, default=85, help="JPG quality 1-100 (default 85)")
    ap.add_argument("--out", type=Path, default=None, help="output folder (default: <source>/JPG)")
    args = ap.parse_args()

    src = args.source
    pdfs = sorted(src.glob("*.pdf")) if src.is_dir() else [src]
    if not pdfs:
        print(f"No PDF in {src}", file=sys.stderr)
        return 1

    out_dir = args.out or ((src if src.is_dir() else src.parent) / "JPG")
    out_dir.mkdir(parents=True, exist_ok=True)

    for pdf in pdfs:
        for f in convert(pdf, out_dir, args.dpi, args.quality):
            print(f"{f.name}  ({f.stat().st_size // 1024} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
