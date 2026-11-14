#!/usr/bin/env python3
"""Render 3.Fingerstyle/*.pdf into WebP pages for the protected shelf.

Output is a staging folder (never committed):

    .secure_staging/
        <id>/p1.webp, p2.webp ...   full-size pages
        <id>/t1.webp                grid thumbnail (page 1)
        manifest.json               plaintext titles, consumed by build_secure.mjs

Usage:
    python scripts/build_secure.py
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import sys
from pathlib import Path

import pymupdf
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "3.Fingerstyle"
STAGE = ROOT / ".secure_staging"

PAGE_WIDTH = 1500      # px, long edge is derived from the page ratio
THUMB_WIDTH = 520
QUALITY = 85
THUMB_QUALITY = 80


def parse_name(stem: str) -> tuple[str, str]:
    """'0.River flows in you【元子】' -> ('River flows in you', '元子')"""
    text = re.sub(r"^\d{1,3}\s*[.\-、]\s*", "", stem).strip()
    arranger = ""
    match = re.search(r"[【\[](.+?)[】\]]\s*$", text)
    if match:
        arranger = match.group(1).strip()
        text = text[: match.start()].strip()
    return text or stem, arranger


def item_id(name: str) -> str:
    return "fs_" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:12]


def render(pdf: Path, out_dir: Path) -> list[dict]:
    doc = pymupdf.open(pdf)
    out_dir.mkdir(parents=True, exist_ok=True)
    pages = []
    try:
        for index, page in enumerate(doc, start=1):
            rect = page.rect
            zoom = PAGE_WIDTH / rect.width if rect.width else 1
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

            buffer = io.BytesIO()
            img.save(buffer, "WEBP", quality=QUALITY, method=6)
            full_rel = f"{item_id(pdf.name)}/p{index}.webp"
            (out_dir / f"p{index}.webp").write_bytes(buffer.getvalue())

            page_entry = {"full": full_rel, "w": img.width, "h": img.height}

            if index == 1:
                ratio = THUMB_WIDTH / img.width
                thumb = img.resize((THUMB_WIDTH, max(1, round(img.height * ratio))), Image.LANCZOS)
                thumb_buffer = io.BytesIO()
                thumb.save(thumb_buffer, "WEBP", quality=THUMB_QUALITY, method=6)
                thumb_rel = f"{item_id(pdf.name)}/t1.webp"
                (out_dir / "t1.webp").write_bytes(thumb_buffer.getvalue())
                page_entry["thumb"] = thumb_rel

            pages.append(page_entry)
    finally:
        doc.close()
    return pages


def main() -> int:
    if not SOURCE.is_dir():
        print(f"! missing folder: {SOURCE}")
        return 1

    pdfs = sorted(p for p in SOURCE.iterdir() if p.is_file() and p.suffix.lower() == ".pdf")
    if not pdfs:
        print("! no PDFs found")
        return 1

    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)

    items = []
    for order, pdf in enumerate(pdfs):
        title, arranger = parse_name(pdf.stem)
        folder = STAGE / item_id(pdf.name)
        pages = render(pdf, folder)
        items.append(
            {
                "id": item_id(pdf.name),
                "title": title,
                "arranger": arranger,
                "order": order,
                "pages": pages,
            }
        )
        print(f"  {pdf.name}  ->  {title}  ({len(pages)} pages)")

    (STAGE / "manifest.json").write_text(
        json.dumps({"items": items}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    total = sum(len(i["pages"]) for i in items)
    print(f"rendered {len(items)} PDFs / {total} pages -> {STAGE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
