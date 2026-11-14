/* ═══════════════════════════════════════════════════════════════
   secure.js — the locked Fingerstyle shelf.

   The repository only holds ciphertext (secure/*.enc). Nothing is
   readable until the password is entered; the derived AES key lives
   in this tab's sessionStorage and never touches the network.
   ═══════════════════════════════════════════════════════════════ */

const MAGIC = 'TBL1';
const INDEX_PATH = 'secure/index.enc';
const SESSION_KEY = 'tablature.secure';

const state = { key: null, items: [], unlocked: false };
const urls = new Map();

/* ── helpers ───────────────────────────────────────────────── */

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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
    true,
    ['decrypt'],
  );
}

async function importRawKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['decrypt']);
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

  persist();
  return list;
}

function persist() {
  try {
    crypto.subtle.exportKey('raw', state.key).then((raw) => {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        key: toBase64(raw),
        items: state.items,
      }));
    }).catch(() => {});
  } catch { /* private mode */ }
}

/** Re-open a shelf that was unlocked earlier in this browser session. */
export async function restore() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved?.key || !Array.isArray(saved.items)) return false;
  try {
    state.key = await importRawKey(fromBase64(saved.key));
    state.items = saved.items;
    state.unlocked = true;
    return true;
  } catch {
    return false;
  }
}

export function lock() {
  state.key = null;
  state.items = [];
  state.unlocked = false;
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

/* ── decrypt on demand ─────────────────────────────────────── */

export async function pageUrl(encPath) {
  if (!state.unlocked || !state.key) throw new Error('Locked');
  if (urls.has(encPath)) return urls.get(encPath);

  const res = await fetch(encPath, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`Missing ${encPath}`);

  const raw = new Uint8Array(await res.arrayBuffer());
  const iv = raw.slice(0, 12);
  const ciphertext = raw.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, state.key, ciphertext);

  const blob = new Blob([plain], { type: 'image/webp' });
  const url = URL.createObjectURL(blob);
  urls.set(encPath, url);
  return url;
}
