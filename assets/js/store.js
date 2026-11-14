/* ═══════════════════════════════════════════════════════════════
   store.js — the single source of truth the UI reads from.
   Merges the published manifest with this device's IndexedDB items,
   handles search, sorting and blob URL lifecycles.
   ═══════════════════════════════════════════════════════════════ */

import * as db from './db.js?v=14';
import * as secure from './secure.js?v=14';

export const state = {
  manifestItems: [],
  localItems: [],
  hidden: new Set(),
  query: '',
  filter: 'all',
  ready: false,
  manifestError: null,
  lastSync: null,
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit() {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error(err); }
  }
}

/* ── blob URL cache ────────────────────────────────────────── */

const urls = new Map();

export function revokeUrl(key) {
  const u = urls.get(key);
  if (u) {
    URL.revokeObjectURL(u);
    urls.delete(key);
  }
}

export async function urlForPage(page) {
  if (!page) return '';
  if (page.enc) return secure.pageUrl(page.enc);
  if (page.blobId) {
    if (urls.has(page.blobId)) return urls.get(page.blobId);
    const blob = await db.getBlob(page.blobId);
    if (!blob) return '';
    const url = URL.createObjectURL(blob);
    urls.set(page.blobId, url);
    return url;
  }
  return page.src || '';
}

/* ── loading ───────────────────────────────────────────────── */

export async function loadManifest() {
  const url = new URL('data/library.json', document.baseURI);
  url.searchParams.set('v', String(Date.now()));
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.manifestItems = Array.isArray(data.items) ? data.items : [];
    state.manifestError = null;
    state.lastSync = data.updatedAt || null;
  } catch (err) {
    state.manifestItems = [];
    state.manifestError = err.message || String(err);
  }
}

export async function loadLocal() {
  state.localItems = await db.allItems();
}

export async function init() {
  const s = db.getSettings();
  state.filter = ['guitar', 'piano'].includes(s.filter) ? s.filter : 'all';
  state.hidden = new Set(Array.isArray(s.hidden) ? s.hidden : []);
  await Promise.all([loadManifest(), loadLocal()]);
  state.ready = true;
  emit();
}

export async function refresh() {
  await Promise.all([loadManifest(), loadLocal()]);
  emit();
}

/* ── merging ───────────────────────────────────────────────── */

/** Older data used type "tab"; anything unrecognised is treated as guitar. */
function kindOf(item) {
  if (item.type === 'piano') return 'piano';
  if (item.type === 'recording') return 'recording';
  return 'guitar';
}

function merge() {
  const map = new Map();
  for (const item of state.manifestItems) {
    if (!item || !item.id) continue;
    const kind = kindOf(item);
    if (kind === 'recording') continue;
    map.set(item.id, { ...item, type: kind, source: item.source || 'cloud' });
  }
  for (const item of state.localItems) {
    if (!item || !item.id) continue;
    const kind = kindOf(item);
    if (kind === 'recording') continue;
    const existing = map.get(item.id);
    if (!existing) {
      map.set(item.id, { ...item, type: kind, source: 'local' });
      continue;
    }
    // Same id in both places → newest edit wins, cloud wins on a tie.
    const a = Date.parse(item.updatedAt || item.createdAt || 0) || 0;
    const b = Date.parse(existing.updatedAt || existing.createdAt || 0) || 0;
    map.set(item.id, a > b
      ? { ...item, type: kind, source: 'local' }
      : { ...existing, type: existing.type, source: existing.source || 'cloud' });
  }
  for (const item of secure.items()) {
    if (!item?.id || map.has(item.id)) continue;
    const kind = item.type === 'piano' ? 'piano' : 'fingerstyle';
    map.set(item.id, { ...item, type: kind, source: 'secure', secure: true });
  }
  return [...map.values()];
}

let mergedCache = null;
export function allItems() {
  if (!mergedCache) mergedCache = merge();
  return mergedCache;
}

function invalidate() {
  mergedCache = null;
  emit();
}

/** Called after the protected shelf is unlocked or locked. */
export function invalidateMerge() {
  invalidate();
}

/* ── search / filter / sort ────────────────────────────────── */

export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function haystack(item) {
  return normalize([
    item.title,
    item.artist,
    item.capo ? `capo ${item.capo}` : '',
    item.tuning,
    (item.tags || []).join(' '),
    item.notes,
    item.type === 'piano' ? 'piano keyboard 钢琴 钢琴谱'
      : item.type === 'fingerstyle' ? 'fingerstyle 指弹 独奏'
      : 'guitar tab tablature score sheet 吉他谱',
  ].join(' '));
}

function tokens(query) {
  return normalize(query).split(/\s+/).filter(Boolean);
}

export function matches(item, query = state.query) {
  const tk = tokens(query);
  if (!tk.length) return true;
  const hay = haystack(item);
  return tk.every((t) => hay.includes(t));
}

export function isVisible(item) {
  if (state.hidden.has(item.id)) return false;
  if (state.filter !== 'all' && item.type !== state.filter) return false;
  return matches(item);
}

export function visibleItems() {
  const items = allItems().filter(isVisible);
  items.sort((a, b) =>
    String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true, sensitivity: 'base' }),
  );
  return items;
}

export function counts() {
  const items = allItems().filter((i) => !state.hidden.has(i.id) && matches(i));
  return {
    all: items.length,
    guitar: items.filter((i) => i.type === 'guitar').length,
    piano: items.filter((i) => i.type === 'piano').length,
    fingerstyle: items.filter((i) => i.type === 'fingerstyle').length,
  };
}

export function stats() {
  const items = allItems().filter((i) => !state.hidden.has(i.id));
  return {
    guitar: items.filter((i) => i.type === 'guitar').length,
    piano: items.filter((i) => i.type === 'piano').length,
    fingerstyle: items.filter((i) => i.type === 'fingerstyle').length,
    pages: items.reduce((n, i) => n + (i.pages?.length || 0), 0),
    local: state.localItems.length,
    unpublished: state.localItems.filter((i) => !i.publishedAt).length,
  };
}

export function getItem(id) {
  return allItems().find((i) => i.id === id) || null;
}

/* ── mutations ─────────────────────────────────────────────── */

export function draft(partial = {}) {
  const ts = db.nowISO();
  return {
    id: db.uid(),
    type: 'guitar',
    title: 'Untitled',
    artist: '',
    capo: '',
    tuning: '',
    tags: [],
    notes: '',
    pages: [],
    createdAt: ts,
    updatedAt: ts,
    ...partial,
  };
}

export async function save(item) {
  item.updatedAt = db.nowISO();
  await db.putItem(item);
  await loadLocal();
  invalidate();
  return item;
}

export async function remove(id) {
  const item = state.localItems.find((i) => i.id === id) || allItems().find((i) => i.id === id);
  if (item) {
    for (const page of item.pages || []) {
      if (page.blobId) {
        await db.removeBlob(page.blobId);
        revokeUrl(page.blobId);
      }
    }
  }
  if (state.localItems.some((i) => i.id === id)) {
    await db.removeItem(id);
    await loadLocal();
  } else {
    // A published/built-in item: hide it on this device only.
    state.hidden.add(id);
    db.saveSettings({ hidden: [...state.hidden] });
  }
  invalidate();
}

export function setQuery(q) {
  state.query = q;
  emit();
}
export function setFilter(f) {
  state.filter = f;
  db.saveSettings({ filter: f });
  emit();
}
export function restoreHidden() {
  state.hidden.clear();
  db.saveSettings({ hidden: [] });
  invalidate();
}

/* ── display helpers ───────────────────────────────────────── */

export function subtitle(item) {
  const bits = [];
  if (item.type === 'piano') bits.push('Piano');
  if (item.artist) bits.push(item.artist);
  if (item.capo) bits.push(`Capo ${item.capo}`);
  if (item.tuning && item.tuning.toLowerCase() !== 'standard') bits.push(item.tuning);
  if (item.pages?.length > 1) bits.push(`${item.pages.length} pages`);
  return bits.filter(Boolean).join(' · ');
}

export function highlight(text, query = state.query) {
  const raw = String(text ?? '');
  const tk = tokens(query);
  if (!tk.length) return escapeHtml(raw);
  const pattern = tk
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  const re = new RegExp(`(${pattern})`, 'gi');
  return raw
    .split(re)
    .map((part, i) => (i % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join('');
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function parseTags(input) {
  return String(input || '')
    .split(/[,;]/)
    .map((t) => t.trim().replace(/^#/, ''))
    .filter(Boolean)
    .slice(0, 12);
}

export function titleFromFilename(name) {
  let base = String(name || '').replace(/\.[a-z0-9]+$/i, '');
  base = base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  // "01 - Song", "03. Song", "1) Song" → "Song"
  base = base.replace(/^\d{1,3}\s*[-.)]\s*/, '');
  return base || 'Untitled';
}

export function splitArtistTitle(name) {
  const base = titleFromFilename(name);
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: '', title: base };
}
