#!/usr/bin/env python3
"""Build data/library.json + thumbs/*.webp from the public shelves.

    1.Guitar/       -> type "guitar" (public)
    2.Piano/        -> NOT handled here (locked, encrypted)
    3.Fingerstyle/  -> NOT handled here (locked, encrypted)

Safe to run repeatedly: entries published from the website (source ==
"cloud") are preserved, while seeded entries are regenerated from disk.

Usage:
    python scripts/build_library.py
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: python -m pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "library.json"
MANIFEST = ROOT / "data"
THUMBS = ROOT / "thumbs"

SECTIONS = [
    ("1.Guitar", "guitar"),
    # 2.Piano and 3.Fingerstyle are locked: they are rendered + encrypted by
    # build_secure.py / build_secure.mjs and never touch the public manifest.
]

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"}
THUMB_WIDTH = 560
THUMB_QUALITY = 82


def title_from_filename(name: str) -> str:
    base = os.path.splitext(name)[0]
    base = re.sub(r"_+", " ", base)
    base = re.sub(r"\s+", " ", base).strip()
    # "01 - Song", "03. Song", "1) Song" -> "Song"
    base = re.sub(r"^\d{1,3}\s*[-.)]\s*", "", base)
    return base or "Untitled"


def split_artist_title(name: str) -> tuple[str, str]:
    base = title_from_filename(name)
    match = re.match(r"^(.+?)\s+[-\u2013\u2014]\s+(.+)$", base)
    if match:
        return match.group(1).strip(), match.group(2).strip()
    return "", base


def seed_id(section: str, name: str) -> str:
    digest = hashlib.sha1(f"{section}/{name}".encode("utf-8")).hexdigest()[:10]
    return f"seed_{digest}"


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def make_thumb(path: Path, out: Path) -> tuple[int, int]:
    with Image.open(path) as img:
        width, height = img.size
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            canvas = Image.new("RGB", img.size, (255, 255, 255))
            canvas.paste(img, mask=img.split()[-1])
            img = canvas
        else:
            img = img.convert("RGB")

        ratio = min(1.0, THUMB_WIDTH / width)
        size = (max(1, round(width * ratio)), max(1, round(height * ratio)))
        thumb = img.resize(size, Image.LANCZOS)
        out.parent.mkdir(parents=True, exist_ok=True)
        thumb.save(out, "WEBP", quality=THUMB_QUALITY, method=6)
    return width, height


def load_cloud() -> list[dict]:
    if not DATA.exists():
        return []
    try:
        payload = json.loads(DATA.read_text(encoding="utf-8"))
        return [i for i in payload.get("items", []) if isinstance(i, dict) and i.get("source") == "cloud"]
    except (json.JSONDecodeError, OSError) as err:
        print(f"! could not read existing manifest ({err}); starting fresh")
        return []


def main() -> int:
    seeded: list[dict] = []
    keep: set[str] = set()

    for folder_name, kind in SECTIONS:
        folder = ROOT / folder_name
        if not folder.is_dir():
            print(f"- {folder_name}: not found, skipped")
            continue

        files = sorted(
            (p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXT),
            key=lambda p: p.name,
        )
        newest = max((p.stat().st_mtime for p in files), default=0)

        for index, path in enumerate(files):
            name = path.name
            sid = seed_id(folder_name, name)
            thumb_name = f"{sid}.webp"
            thumb_path = THUMBS / thumb_name
            try:
                width, height = make_thumb(path, thumb_path)
            except Exception as err:  # noqa: BLE001 - one bad file should not stop the build
                print(f"! skip {name}: {err}")
                continue

            keep.add(thumb_name)
            artist, title = split_artist_title(name)
            created = iso(newest - index * 60)
            seeded.append(
                {
                    "id": sid,
                    "type": kind,
                    "title": title,
                    "artist": artist,
                    "capo": "",
                    "tuning": "",
                    "tags": [],
                    "notes": "",
                    "pages": [
                        {
                            "src": f"{folder_name}/{name}",
                            "thumb": f"thumbs/{thumb_name}",
                            "w": width,
                            "h": height,
                        }
                    ],
                    "createdAt": created,
                    "updatedAt": created,
                    "source": "builtin",
                }
            )
        print(f"- {folder_name}: {len(files)} images -> {kind}")

    if THUMBS.is_dir():
        for stale in THUMBS.glob("*.webp"):
            if stale.name not in keep:
                stale.unlink()

    cloud = load_cloud()
    items = seeded + cloud
    items.sort(key=lambda i: str(i.get("createdAt") or ""), reverse=True)

    latest = max((i.get("updatedAt") or "" for i in items), default="")
    manifest = {"version": 1, "updatedAt": latest, "items": items}

    MANIFEST.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"seeded {len(seeded)} tabs, kept {len(cloud)} published -> {DATA.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
