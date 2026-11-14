#!/usr/bin/env python3
"""Build data/library.json + thumbs/*.webp from tablature/.

Safe to run repeatedly: entries published from the website (source ==
"cloud") are preserved, while seeded entries (source == "builtin") are
regenerated from whatever is currently in tablature/.

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
SOURCE = ROOT / "tablature"
THUMBS = ROOT / "thumbs"
DATA = ROOT / "data" / "library.json"
MANIFEST = ROOT / "data"

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


def seed_id(name: str) -> str:
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:10]
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
        THUMBS.mkdir(parents=True, exist_ok=True)
        thumb.save(out, "WEBP", quality=THUMB_QUALITY, method=6)
    return width, height


def load_existing() -> list[dict]:
    if not DATA.exists():
        return []
    try:
        payload = json.loads(DATA.read_text(encoding="utf-8"))
        items = payload.get("items", [])
        return [i for i in items if isinstance(i, dict) and i.get("source") == "cloud"]
    except (json.JSONDecodeError, OSError) as err:
        print(f"! could not read existing manifest ({err}); starting fresh")
        return []


def main() -> int:
    if not SOURCE.is_dir():
        print(f"! missing folder: {SOURCE}")
        return 1

    files = sorted(
        (p for p in SOURCE.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXT),
        key=lambda p: p.name,
    )

    cloud_items = load_existing()
    seeded: list[dict] = []

    # Deterministic ordering: the first file listed becomes the newest one,
    # staggered by a minute so "Newest first" is stable across rebuilds.
    newest = max((p.stat().st_mtime for p in files), default=0)

    for index, path in enumerate(files):
        name = path.name
        thumb_name = f"{seed_id(name)}.webp"
        thumb_path = THUMBS / thumb_name
        try:
            width, height = make_thumb(path, thumb_path)
        except Exception as err:  # noqa: BLE001 - one bad file should not stop the build
            print(f"! skip {name}: {err}")
            continue

        artist, title = split_artist_title(name)
        created = iso(newest - index * 60)
        seeded.append(
            {
                "id": seed_id(name),
                "type": "guitar",
                "title": title,
                "artist": artist,
                "capo": "",
                "tuning": "",
                "tags": [],
                "notes": "",
                "pages": [
                    {
                        "src": f"tablature/{name}",
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

    # Drop thumbnails whose source image disappeared.
    keep = {f"{seed_id(p.name)}.webp" for p in files}
    if THUMBS.is_dir():
        for stale in THUMBS.glob("*.webp"):
            if stale.name not in keep:
                stale.unlink()

    items = seeded + cloud_items
    items.sort(key=lambda i: str(i.get("createdAt") or ""), reverse=True)

    latest = max((i.get("updatedAt") or "" for i in items), default="")
    manifest = {"version": 1, "updatedAt": latest, "items": items}

    MANIFEST.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"seeded {len(seeded)} tabs, kept {len(cloud_items)} published -> {DATA.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
