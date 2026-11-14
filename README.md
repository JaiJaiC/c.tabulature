# Tablature

A private guitar and piano tablature library — black, quiet, and built for a
phone propped up on a music stand.

**Live site:** https://jaiaic.github.io/c.tabulature/

![Tablature](https://img.shields.io/badge/pages-live-f0b357)

## What it does

- **Library grid** of every tab you own, sorted A-Z, with thumbnails, artist, capo and tags.
- **Search** across titles, artists, capo, tuning, tags and notes (`/` focuses it).
- **Reader** with zoom, pinch-to-zoom, double-tap, swipe and keyboard navigation.
- **Three shelves** - Guitar, Piano, and a password-protected Fingerstyle shelf.
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

Open **Storage & sync** to export a JSON backup (with the images inlined) and to
restore one.

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

## The protected Fingerstyle shelf

`3.Fingerstyle/` holds PDFs that should not be public. They never enter the
repository: the folder is git-ignored and the build only produces ciphertext.

```bash
python scripts/build_secure.py       # PDF pages -> WebP in .secure_staging/
node   scripts/build_secure.mjs c    # AES-256-GCM -> secure/*.enc
```

The site ships `secure/index.enc` (titles + page index) plus one encrypted file
per page. Entering the password derives a key with PBKDF2-SHA256 (310k
iterations) and decrypts in the browser; the key lives in `sessionStorage` for
that tab only and is dropped when the tab closes.

**Be realistic about the password.** The ciphertext is public, so the password
is the only secret protecting it. `c` is a single character and a script can
brute-force it almost instantly. To change it:

```bash
node scripts/build_secure.mjs "a longer passphrase"
```

Re-run `build_secure.py` as well whenever the PDFs themselves change. Anything
genuinely sensitive belongs in a private repository or a paid private hosting
plan - public GitHub Pages cannot hide a file on its own.
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
  viewer.js              reader, zoom, gestures, tap-to-exit
  secure.js              password gate + AES-GCM decryption
  editor.js              metadata sheet and page management
  importer.js            drag & drop, paste, file picking, microphone
  github.js              publish to the repository via the Git Data API
data/library.json        the published index
tablature/               your tab images (the originals)
thumbs/                  generated 560px WebP previews
scripts/                 library builder, secure builder, dev server, deploy helper
1.Guitar/ 2.Piano/        public shelves (images)
3.Fingerstyle/           PDF sources - git-ignored, never published
secure/                  encrypted Fingerstyle pages
```

## Shortcuts

| Key | Action |
| --- | --- |
| `/` | focus search |
| `←` `→` | previous / next item in the reader |
| `+` `-` `0` | zoom in / out / reset |
| `Esc` | close reader or dialog |
| `Ctrl/Cmd + Enter` | save in the edit sheet |

## Adding a tab on Windows

Drop new images into `1.Guitar/`, or PDFs into `2.Piano/` or `3.Fingerstyle/`,
then **double-click `update.cmd`** in the project root.

It finds Python, rebuilds the manifest and thumbnails, re-encrypts the locked
shelves only when their sources changed, bumps the asset version (so no browser
keeps a stale build) and pushes to `main`. The window stays open so you can read
the result.

From a terminal, with options:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\update.ps1           # build + push
powershell -ExecutionPolicy Bypass -File scripts\update.ps1 -NoPush   # commit locally only
powershell -ExecutionPolicy Bypass -File scripts\update.ps1 -Force    # re-encrypt even if unchanged
```

## Deploying

The site is served by GitHub Pages from the **`gh-pages`** branch, while **`main`**
stays the single source of truth. `.github/workflows/sync.yml` mirrors `main`
onto `gh-pages` on every push — including commits made by the in-browser
publisher — so you normally only ever touch `main`.

```bash
git push origin main                       # code change → site rebuilds in ~1 min

node scripts/deploy-github.mjs push "…"    # same thing through the GitHub API
node scripts/deploy-github.mjs status      # Pages build status + URL
```

The helper commands read a token from `.gh-token` (git-ignored) or `GITHUB_TOKEN`.
Enabling Pages itself needs `administration` permission, so if the site is ever
switched off just turn it back on under **Settings → Pages** (branch `gh-pages`,
root). `.nojekyll` keeps Jekyll out of the way.

---

Everything here is personal: your tabs, your takes, your library.
