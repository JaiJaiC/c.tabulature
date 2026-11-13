# Tablature

A private guitar tablature and recording library — black, quiet, and built for a
phone propped up on a music stand.

**Live site:** https://jaiaic.github.io/c.tabulature/

![Tablature](https://img.shields.io/badge/pages-live-f0b357)

## What it does

- **Library grid** of every tab you own, with thumbnails, artist, capo and tags.
- **Search** across titles, artists, capo, tuning, tags and notes (`/` focuses it).
- **Reader** with zoom, pinch-to-zoom, double-tap, swipe and keyboard navigation.
- **Recordings** — upload audio files or record straight from the microphone,
  then link a take to the tab it belongs to.
- **Add by dragging** an image (or several) anywhere onto the page. It is saved
  to the browser immediately — no dialog, no "upload" button.
- **Works on phone, tablet and desktop**, offline after the first visit.
- **Optional GitHub publishing** so new tabs appear on your other devices.

## How storage works

This is a static site on GitHub Pages, so there is no server to receive uploads.
Storage is therefore layered:

| Layer | What lives there | Survives |
| --- | --- | --- |
| `data/library.json` + `tablature/` + `thumbs/` | the tabs committed to the repo | everything, every device |
| IndexedDB (`tablature` database) | anything you add in the browser | this browser, until you clear site data |
| `localStorage` | sort order, filter, hidden items, GitHub token | this browser |

When both layers hold the same item, the newest edit wins. Items added locally
show an **On device** badge until they are published.

Open **Storage & sync** to export a JSON backup (with the images and audio
inlined) and to restore one.

## Adding tabs

1. Drop one or more images onto the page — each image becomes a tab, named after
   its file. `Artist - Title.png` splits into artist and title automatically.
2. Click a card, then the pencil, to rename it, add tags, or append more pages.
3. To make it permanent and shared, open **Storage & sync → Publish to GitHub**.

Seeded tabs live in `tablature/`. To add more the repo way, drop the image into
that folder and run:

```bash
python scripts/build_library.py    # rebuilds data/library.json + thumbs/
```

The script keeps anything already published from the website and only
regenerates the seeded entries, so it is safe to run any time.

## Publishing from the browser

Create a **fine-grained** token at
<https://github.com/settings/personal-access-tokens/new>:

- Repository access: only `JaiJaiC/c.tabulature`
- Permissions: **Contents — Read and write**

Paste it into **Storage & sync**. It is kept in this browser's `localStorage`
only, never in the repo. Publishing uploads the files under `media/`, rewrites
`data/library.json`, and creates a single commit. GitHub Pages then rebuilds in
about a minute.

Click **Forget token** on a shared computer.

## Local development

```bash
node scripts/serve.mjs          # http://localhost:4173
python scripts/build_library.py # regenerate seeded entries + thumbnails
```

There is no build step and no dependency to install — it is plain HTML, CSS and
ES modules.

## Layout

```
index.html               markup for the library, reader, editor and settings
assets/css/styles.css    the whole visual system
assets/js/
  app.js                 wiring: search, filters, menus, settings, backup
  store.js               merges manifest + local items, search, sorting
  db.js                  IndexedDB and localStorage
  ui.js                  grid, counters, toasts
  viewer.js              reader, zoom, gestures, audio player
  editor.js              metadata sheet and page management
  importer.js            drag & drop, paste, file picking, microphone
  github.js              publish to the repository via the Git Data API
data/library.json        the published index
tablature/               your tab images (the originals)
thumbs/                  generated 560px WebP previews
scripts/                 library builder, dev server, deploy helper
```

## Shortcuts

| Key | Action |
| --- | --- |
| `/` | focus search |
| `←` `→` | previous / next item in the reader |
| `+` `-` `0` | zoom in / out / reset |
| `Esc` | close reader or dialog |
| `Ctrl/Cmd + Enter` | save in the edit sheet |

## Deploying

```bash
node scripts/deploy-github.mjs create   # first time only
node scripts/deploy-github.mjs pages    # enable GitHub Pages
node scripts/deploy-github.mjs status   # build status + URL
```

Both commands expect a token in `.gh-token` (git-ignored) or `GITHUB_TOKEN`.

Content is served from the `main` branch root. `.nojekyll` keeps Jekyll out of
the way.

---

Everything here is personal: your tabs, your takes, your library.
