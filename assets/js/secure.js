/* ═══════════════════════════════════════════════════════════════
   secure.js — the locked shelves (Piano + Fingerstyle).

   The repository only holds ciphertext (secure/*.enc). Nothing is
   readable until the password is entered; the derived AES key lives
   in memory only, so every refresh asks again.
   ═══════════════════════════════════════════════════════════════ */

const MAGIC = 'TBL1';
const INDEX_PATH = 'secure/index.enc';

const state = { key: null, items: [], unlocked: false };
const urls = new Map();

/* ── helpers ───────────────────────────────────────────────── */


async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}


/* ── public state ──────────────────────────────────────────── */

export function isUnlocked() {
  return state.unlocked;
}

export function items() {
  return state.unlocked ? state.items : [];
}

export function count() {
  return state.items.length;
}

/** The AES key, for diagnostics only. */
export function peekKey() {
  return state.unlocked ? state.key : null;
}

/* ── unlock / lock ─────────────────────────────────────────── */

export async function unlock(password) {
  const res = await fetch(`${INDEX_PATH}?v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('The protected shelf has not been published yet.');

  const raw = new Uint8Array(await res.arrayBuffer());
  if (raw.length < 40) throw new Error('Protected shelf is damaged.');
  if (String.fromCharCode(...raw.slice(0, 4)) !== MAGIC) throw new Error('Protected shelf is damaged.');

  const salt = raw.slice(4, 20);
  const iterations = new DataView(raw.buffer, raw.byteOffset + 20, 4).getUint32(0, false);
  const iv = raw.slice(24, 36);
  const ciphertext = raw.slice(36);

  const key = await deriveKey(password, salt, iterations);

  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  } catch {
    throw new Error('Wrong password');
  }

  const doc = JSON.parse(new TextDecoder().decode(plain));
  const list = Array.isArray(doc.items) ? doc.items : [];

  state.key = key;
  state.items = list;
  state.unlocked = true;
  return list;
}

export function lock() {
  state.key = null;
  state.items = [];
  state.unlocked = false;
  urls.clear();
}

/* ── decrypt on demand ─────────────────────────────────────── */

/**
 * Decrypts one page and hands back a `data:` URL.
 *
 * Pages are PNG so every browser can decode them. The URL used to be a `blob:`, but
 * to decode blobs created on the fly, which surfaced as a broken-image icon.
 * A data URL is plain text, so nothing can block it.
 */
export async function pageUrl(encPath) {
  if (!state.unlocked || !state.key) throw new Error('Locked');
  if (urls.has(encPath)) return urls.get(encPath);

  const res = await fetch(encPath, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`Missing ${encPath}`);

  const raw = new Uint8Array(await res.arrayBuffer());
  const iv = raw.slice(0, 12);
  const ciphertext = raw.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, state.key, ciphertext);

  const url = await toDataUrl(new Blob([plain], { type: 'image/png' }));
  urls.set(encPath, url);
  return url;
}

function toDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read page'));
    reader.readAsDataURL(blob);
  });
}
