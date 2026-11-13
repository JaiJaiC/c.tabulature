/* ═══════════════════════════════════════════════════════════════
   db.js — local persistence: IndexedDB for content, localStorage
   for preferences. Nothing here ever leaves the device.
   ═══════════════════════════════════════════════════════════════ */

const DB_NAME = 'tablature';
const DB_VERSION = 1;
const SETTINGS_KEY = 'tablature.settings';

let dbp = null;

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

function done(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

/* ── items ─────────────────────────────────────────────────── */

export async function allItems() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('items', 'readonly').objectStore('items').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function putItem(item) {
  const db = await openDB();
  const t = db.transaction('items', 'readwrite');
  t.objectStore('items').put(item);
  await done(t);
  return item;
}

export async function removeItem(id) {
  const db = await openDB();
  const t = db.transaction('items', 'readwrite');
  t.objectStore('items').delete(id);
  await done(t);
}

/* ── blobs ─────────────────────────────────────────────────── */

export async function putBlob(id, blob) {
  const db = await openDB();
  const t = db.transaction('blobs', 'readwrite');
  t.objectStore('blobs').put(blob, id);
  await done(t);
}

export async function getBlob(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('blobs', 'readonly').objectStore('blobs').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function removeBlob(id) {
  const db = await openDB();
  const t = db.transaction('blobs', 'readwrite');
  t.objectStore('blobs').delete(id);
  await done(t);
}

export async function clearAll() {
  const db = await openDB();
  const t = db.transaction(['items', 'blobs', 'meta'], 'readwrite');
  t.objectStore('items').clear();
  t.objectStore('blobs').clear();
  t.objectStore('meta').clear();
  await done(t);
}

/* ── storage estimate ──────────────────────────────────────── */

export async function estimate() {
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      return await navigator.storage.persist();
    }
  } catch { /* ignore */ }
  return false;
}

/* ── settings ──────────────────────────────────────────────── */

const DEFAULTS = {
  repo: 'JaiJaiC/c.tabulature',
  branch: 'main',
  token: '',
  sort: 'newest',
  filter: 'all',
  hidden: [],
};

let cache = null;

export function getSettings() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function saveSettings(patch) {
  cache = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(cache));
  } catch { /* private mode */ }
  return cache;
}

/* ── tiny helpers ──────────────────────────────────────────── */

export function uid(prefix = 'i') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function nowISO() {
  return new Date().toISOString();
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
