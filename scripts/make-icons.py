"""Generates Windows icons (.ico) and PNG from SVG.

Usage: python scripts/make-icons.py
  public/logo.svg     -> build/icon.ico, build/icon.png
  build/file-pdf.svg  -> build/file-pdf.ico
"""
import io
from pathlib import Path

import pymupdf
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def render(svg: Path, size: int) -> Image.Image:
    with pymupdf.open(svg) as doc:
        page = doc[0]
        zoom = size / max(page.rect.width, page.rect.height)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=True)
        return Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGBA")


def make_ico(svg: Path, out: Path) -> None:
    images = [render(svg, s) for s in SIZES]
    images[-1].save(out, format="ICO", sizes=[(s, s) for s in SIZES], append_images=images[:-1])
    print(f"{out.relative_to(ROOT)}  ({out.stat().st_size // 1024} kB)")


build = ROOT / "build"
build.mkdir(exist_ok=True)
make_ico(ROOT / "public" / "logo.svg", build / "icon.ico")
make_ico(build / "file-pdf.svg", build / "file-pdf.ico")
render(ROOT / "public" / "logo.svg", 512).save(build / "icon.png")
print("build/icon.png")
