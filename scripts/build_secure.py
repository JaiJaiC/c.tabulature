#!/usr/bin/env python3
"""Render the locked shelves into WebP pages for the encrypted bundle.

    2.Piano/*.pdf|png   -> type "piano"
    3.Fingerstyle/*.pdf -> type "fingerstyle"

Output is a staging folder (never committed):

    .secure_staging/
        <id>/p1.webp ...   full-size pages
        <id>/t1.webp       grid thumbnail (page 1)
        manifest.json      plaintext titles, consumed by build_secure.mjs

Usage:
    python scripts/build_secure.py
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
from pathlib import Path

import pymupdf
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
STAGE = ROOT / ".secure_staging"

SHELVES = [
    ("2.Piano", "piano", "pi"),
    ("3.Fingerstyle", "fingerstyle", "fs"),
]

PAGE_WIDTH = 1500
THUMB_WIDTH = 520
QUALITY = 85
THUMB_QUALITY = 80

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"}


def parse_name(stem: str) -> tuple[str, str]:
    """'0.River flows in you【元子】' -> ('River flows in you', '元子')"""
    text = re.sub(r"^\d{1,3}\s*[.\-、]\s*", "", stem).strip()
    arranger = ""
    match = re.search(r"[【\[](.+?)[】\]]\s*$", text)
    if match:
        arranger = match.group(1).strip()
        text = text[: match.start()].strip()
    return text or stem, arranger


def make_id(prefix: str, name: str) -> str:
    return f"{prefix}_" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:12]


def to_webp(img: Image.Image, quality: int) -> bytes:
    buffer = io.BytesIO()
    img.save(buffer, "WEBP", quality=quality, method=6)
    return buffer.getvalue()


def render_pdf(pdf: Path, out_dir: Path, prefix: str) -> list[dict]:
    doc = pymupdf.open(pdf)
    pages: list[dict] = []
    try:
        for index, page in enumerate(doc, start=1):
            zoom = PAGE_WIDTH / page.rect.width if page.rect.width else 1
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            (out_dir / f"p{index}.webp").write_bytes(to_webp(img, QUALITY))

            entry = {"full": f"{make_id(prefix, pdf.name)}/p{index}.webp", "w": img.width, "h": img.height}
            if index == 1:
                ratio = THUMB_WIDTH / img.width
                thumb = img.resize((THUMB_WIDTH, max(1, round(img.height * ratio))), Image.LANCZOS)
                (out_dir / "t1.webp").write_bytes(to_webp(thumb, THUMB_QUALITY))
                entry["thumb"] = f"{make_id(prefix, pdf.name)}/t1.webp"
            pages.append(entry)
    finally:
        doc.close()
    return pages


def render_image(path: Path, out_dir: Path, prefix: str) -> list[dict]:
    with Image.open(path) as src:
        img = src.convert("RGB")
        if img.width > PAGE_WIDTH:
            ratio = PAGE_WIDTH / img.width
            img = img.resize((PAGE_WIDTH, max(1, round(img.height * ratio))), Image.LANCZOS)
        (out_dir / "p1.webp").write_bytes(to_webp(img, QUALITY))
        ratio = THUMB_WIDTH / img.width
        thumb = img.resize((THUMB_WIDTH, max(1, round(img.height * ratio))), Image.LANCZOS)
        (out_dir / "t1.webp").write_bytes(to_webp(thumb, THUMB_QUALITY))
        return [{
            "full": f"{make_id(prefix, path.name)}/p1.webp",
            "thumb": f"{make_id(prefix, path.name)}/t1.webp",
            "w": img.width,
            "h": img.height,
        }]


def main() -> int:
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)

    items: list[dict] = []
    order = 0

    for folder_name, kind, prefix in SHELVES:
        folder = ROOT / folder_name
        if not folder.is_dir():
            print(f"- {folder_name}: not found, skipped")
            continue

        files = sorted(
            p for p in folder.iterdir()
            if p.is_file() and (p.suffix.lower() == ".pdf" or p.suffix.lower() in IMAGE_EXT)
        )
        for path in files:
            title, arranger = parse_name(path.stem)
            folder_out = STAGE / make_id(prefix, path.name)
            folder_out.mkdir(parents=True, exist_ok=True)
            pages = render_pdf(path, folder_out, prefix) if path.suffix.lower() == ".pdf" else render_image(path, folder_out, prefix)
            items.append({
                "id": make_id(prefix, path.name),
                "type": kind,
                "title": title,
                "arranger": arranger,
                "order": order,
                "pages": pages,
            })
            order += 1
            print(f"  [{kind}] {path.name} -> {title} ({len(pages)} pages)")

    (STAGE / "manifest.json").write_text(
        json.dumps({"items": items}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    total = sum(len(i["pages"]) for i in items)
    print(f"rendered {len(items)} scores / {total} pages -> {STAGE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
