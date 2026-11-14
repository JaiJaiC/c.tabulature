/* ═══════════════════════════════════════════════════════════════
   editor.js — metadata sheet for a tab: rename, tag, add or drop pages.
   ═══════════════════════════════════════════════════════════════ */

import * as store from './store.js';
import * as db from './db.js';
import { toast } from './ui.js';
import * as importer from './importer.js';

const $ = (id) => document.getElementById(id);

let editing = null;
let lastFocus = null;
let pageUrls = [];

/* ── open / close ──────────────────────────────────────────── */

export function init({ onSaved = () => {}, onDeleted = () => {} } = {}) {
  hooks.onSaved = onSaved;
  hooks.onDeleted = onDeleted;

  $('saveItem').addEventListener('click', save);
  $('deleteItem').addEventListener('click', destroy);
  $('editorForm').addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });
  $('addPagesBtn').addEventListener('click', () => {
    if (!editing) return;
    importer.pickPages();
  });

  document.querySelectorAll('#editor [data-close]').forEach((btn) => {
    btn.addEventListener('click', close);
  });
  $('editor').addEventListener('mousedown', (event) => {
    if (event.target === $('editor')) close();
  });

  document.addEventListener('keydown', (event) => {
    if ($('editor').hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  });
}

const hooks = { onSaved: () => {}, onDeleted: () => {} };

export function open(id) {
  const item = store.getItem(id);
  if (!item) return;
  editing = { ...item };
  editing.editablePages = true;
  lastFocus = document.activeElement;

  $('editorTitle').textContent = item.type === 'piano' ? 'Edit piano tab' : 'Edit guitar tab';
  $('fTitle').value = item.title || '';
  $('fArtist').value = item.artist || '';
  $('fCapo').value = item.capo || '';
  $('fTuning').value = item.tuning || '';
  $('fTags').value = (item.tags || []).join(', ');
  $('fNotes').value = item.notes || '';
  $('fType').value = item.type === 'piano' ? 'piano' : 'guitar';

  const del = $('deleteItem');
  del.textContent = item.source === 'local' ? 'Delete' : 'Hide from this device';

  $('editor').hidden = false;
  document.body.classList.add('no-scroll');
  renderPages(editing);
  setTimeout(() => $('fTitle').focus({ preventScroll: true }), 40);
}

export function close() {
  if ($('editor').hidden) return;
  $('editor').hidden = true;
  document.body.classList.remove('no-scroll');
  revokePageUrls();
  editing = null;
  if (lastFocus?.focus) lastFocus.focus({ preventScroll: true });
}

export function currentItem() {
  return editing;
}

/** Called by importer once the user picked new page images. */
export async function receivePages(files) {
  if (!editing) return;
  const item = store.getItem(editing.id);
  if (!item) return;
  const updated = await importer.appendPages(item, files);
  editing = { ...updated, editablePages: true };
  renderPages(editing);
  toast(files.length === 1 ? 'Page added' : `${files.length} pages added`);
  hooks.onSaved(item.id);
}

async function renderPages(item) {
  revokePageUrls();
  const strip = $('pageStrip');
  strip.innerHTML = '';
  const pages = item.pages || [];
  $('pagesHint').textContent = pages.length
    ? `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`
    : 'no pages yet';
  $('addPagesBtn').disabled = false;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const wrap = document.createElement('div');
    wrap.className = 'page-thumb';
    const img = document.createElement('img');
    img.alt = `Page ${i + 1}`;
    img.loading = 'lazy';
    wrap.appendChild(img);

    store.urlForPage(page).then((url) => {
      if (url) {
        img.src = url;
        pageUrls.push(url);
      }
    }).catch(() => {});

    if (item.editablePages && pages.length > 1) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-label', `Remove page ${i + 1}`);
      btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
      btn.addEventListener('click', async () => {
        const fresh = store.getItem(item.id) || item;
        const removed = fresh.pages[i];
        fresh.pages.splice(i, 1);
        if (removed?.blobId) await db.removeBlob(removed.blobId);
        await store.save(fresh);
        editing = { ...fresh, editablePages: true };
        renderPages(editing);
        toast('Page removed');
        hooks.onSaved(fresh.id);
      });
      wrap.appendChild(btn);
    }
    strip.appendChild(wrap);
  }
}

function revokePageUrls() {
  pageUrls = [];
}

/* ── save ──────────────────────────────────────────────────── */

async function save() {
  if (!editing) return;
  const title = $('fTitle').value.trim();
  if (!title) {
    $('fTitle').focus();
    toast('A title is required', { error: true });
    return;
  }
  const fresh = store.getItem(editing.id);
  if (!fresh) {
    close();
    return;
  }
  fresh.title = title;
  fresh.artist = $('fArtist').value.trim();
  fresh.capo = $('fCapo').value.trim();
  fresh.tuning = $('fTuning').value.trim();
  fresh.tags = store.parseTags($('fTags').value);
  fresh.notes = $('fNotes').value.trim();
  fresh.type = $('fType').value === 'piano' ? 'piano' : 'guitar';

  await store.save(fresh);
  hooks.onSaved(fresh.id);
  close();
  toast('Saved');
}

async function destroy() {
  if (!editing) return;
  const item = store.getItem(editing.id);
  if (!item) return close();
  const isLocal = item.source === 'local';
  const message = isLocal
    ? `Delete “${item.title}” from this device? The files will be removed.`
    : `Hide “${item.title}” from this device? It stays in your GitHub library.`;
  if (!window.confirm(message)) return;

  await store.remove(item.id);
  hooks.onDeleted(item.id);
  close();
  toast(isLocal ? 'Deleted' : 'Hidden from this device');
}
