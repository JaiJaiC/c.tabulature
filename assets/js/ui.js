/* ═══════════════════════════════════════════════════════════════
   ui.js — everything that touches the DOM: the library grid,
   counters, chips, empty states and toasts.
   ═══════════════════════════════════════════════════════════════ */

import * as store from './store.js';
import * as secure from './secure.js';

const $ = (id) => document.getElementById(id);

let firstPaint = true;

/* ── toasts ────────────────────────────────────────────────── */

export function toast(message, { error = false, ms = 2600 } = {}) {
  const host = $('toasts');
  const node = document.createElement('div');
  node.className = `toast${error ? ' is-error' : ''}`;
  node.innerHTML = `<span class="tick">${error ? '!' : '✓'}</span><span></span>`;
  node.lastElementChild.textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 220);
  }, ms);
}

/* ── card ──────────────────────────────────────────────────── */

function cardHTML(item, index) {
  const id = store.escapeHtml(item.id);
  const title = store.highlight(item.title || 'Untitled');
  const sub = store.escapeHtml(store.subtitle(item));
  const page = item.pages?.[0];
  const tagList = (item.tags || []).slice(0, 3);

  const src = page ? store.escapeHtml(page.thumb || page.src || '') : '';
  const blob = page?.blobId ? ` data-blob="${store.escapeHtml(page.blobId)}"` : '';
  const enc = page?.enc ? ` data-enc="${store.escapeHtml(page.thumb || page.enc)}"` : '';
  const media = page
    ? `<img src="${src}"${blob}${enc} alt="" loading="lazy" decoding="async" onload="this.classList.add('is-loaded')">`
    : `<span class="page-fallback">No pages</span>`;

  const pageBadge = item.pages?.length > 1 ? `<span class="badge">${item.pages.length} pages</span>` : '';
  const localBadge = item.source === 'local' && !item.publishedAt ? `<span class="badge-local">On device</span>` : '';

  return `
    <article class="card" data-id="${id}" data-type="${item.type}" ${firstPaint ? `style="animation-delay:${Math.min(index * 22, 260)}ms"` : ''}>
      <button class="card-media" data-open="${id}" type="button"
              aria-label="${store.escapeHtml(item.title || 'Untitled')}">
        ${media}
        ${pageBadge}${localBadge}
      </button>
      <div class="card-body">
        <h3 class="card-title">${title}</h3>
        ${sub ? `<p class="card-meta">${sub}</p>` : ''}
        ${tagList.length ? `<div class="card-tags">${tagList
          .map((t) => `<button class="card-tag" data-tag="${store.escapeHtml(t)}" type="button">#${store.escapeHtml(t)}</button>`)
          .join('')}</div>` : ''}
      </div>
    </article>`;
}

/* ── hydrate blob-backed thumbnails ────────────────────────── */

async function hydrateImages(root) {
  const blobs = [...root.querySelectorAll('img[data-blob]')];
  await Promise.all(blobs.map(async (img) => {
    const blobId = img.getAttribute('data-blob');
    if (!blobId) return;
    try {
      const url = await store.urlForPage({ blobId });
      if (url) {
        img.src = url;
        img.removeAttribute('data-blob');
      }
    } catch { /* leave broken */ }
  }));

  const encrypted = [...root.querySelectorAll('img[data-enc]')];
  await Promise.all(encrypted.map(async (img) => {
    const path = img.getAttribute('data-enc');
    if (!path) return;
    try {
      const url = await secure.pageUrl(path);
      if (url) {
        img.src = url;
        img.removeAttribute('data-enc');
      }
    } catch { /* locked or missing */ }
  }));
}

/* ── render ────────────────────────────────────────────────── */

export function render() {
  const items = store.visibleItems();
  const grid = $('grid');
  const empty = $('empty');
  const resultLine = $('resultLine');
  const q = store.state.query.trim();

  grid.innerHTML = items.map(cardHTML).join('');
  if (!firstPaint) grid.classList.add('no-anim');
  hydrateImages(grid);

  // counters
  const c = store.counts();
  document.querySelectorAll('.chip-count').forEach((node) => {
    const key = node.getAttribute('data-count');
    node.textContent = c[key] ? String(c[key]) : '';
  });

  // stats
  const s = store.stats();
  $('statGuitar').textContent = String(s.guitar);
  $('statPiano').textContent = String(s.piano);
  $('statPages').textContent = String(s.pages);

  const fs = $('statFingerstyle');
  if (fs) {
    if (secure.isUnlocked()) {
      fs.textContent = String(s.fingerstyle);
    } else {
      fs.innerHTML = `<svg class="stat-lock" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="10.5" width="14" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/>
        <path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
    }
  }

  // result line
  if (q) {
    resultLine.innerHTML = items.length
      ? `<strong>${items.length}</strong> ${items.length === 1 ? 'match' : 'matches'} for “${store.escapeHtml(q)}”`
      : `No matches for “${store.escapeHtml(q)}”`;
  } else if (store.state.filter !== 'all') {
    resultLine.innerHTML = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
  } else {
    resultLine.textContent = '';
  }

  // empty state
  const libraryEmpty = store.allItems().length === 0;
  empty.hidden = items.length > 0;
  if (!items.length) {
    empty.hidden = false;
    const t = $('emptyTitle');
    const p = $('emptyText');
    const addBtn = $('emptyAdd');
    if (store.state.manifestError && libraryEmpty) {
      t.textContent = 'Could not load the library';
      p.textContent = `${store.state.manifestError} — drag an image in to start your own.`;
      addBtn.hidden = false;
    } else if (libraryEmpty) {
      t.textContent = 'Nothing here yet';
      p.textContent = 'Drag a tab image into this window — it saves automatically.';
      addBtn.hidden = false;
    } else if (q) {
      t.textContent = 'No matches';
      p.textContent = `Nothing found for “${q}”. Try a shorter word or a tag.`;
      addBtn.hidden = true;
    } else {
      t.textContent = 'No items in this filter';
      p.textContent = 'Switch back to “All” to see everything.';
      addBtn.hidden = true;
    }
  }

  firstPaint = false;
}

/* ── grid interactions ─────────────────────────────────────── */

export function bindGrid(openItem) {
  $('grid').addEventListener('click', (event) => {
    const tag = event.target.closest('.card-tag');
    if (tag) {
      event.preventDefault();
      event.stopPropagation();
      const value = tag.getAttribute('data-tag');
      $('search').value = value;
      store.setQuery(value);
      return;
    }
    const open = event.target.closest('[data-open]');
    if (open) openItem(open.getAttribute('data-open'));
  });
}

export function scrollTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
