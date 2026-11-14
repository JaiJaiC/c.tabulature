/* ═══════════════════════════════════════════════════════════════
   diag.js — open the site with ?diag and it reports exactly which
   step fails on this device: fetch, decrypt, or image decode.
   ═══════════════════════════════════════════════════════════════ */

import * as secure from './secure.js?v=9';
import * as store from './store.js?v=9';

const MAGIC = 'TBL1';
const ONE_PIXEL_WEBP = 'UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+88Jn/qcfjSPGkfSb/+Smv8bcdgAA';

async function webpSupport() {
  try {
    const binary = atob(ONE_PIXEL_WEBP);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
    return `yes (${bitmap.width}x${bitmap.height})`;
  } catch (err) {
    return `NO — ${err.message}`;
  }
}

async function buildReport() {
  const lines = [];
  const push = (label, value) => lines.push(`${label.padEnd(20)}${value}`);

  push('when', new Date().toISOString());
  push('user agent', navigator.userAgent);
  push('screen / dpr', `${screen.width}x${screen.height} @ ${window.devicePixelRatio}`);
  push('secure context', String(window.isSecureContext));
  push('subtle crypto', String(Boolean(window.crypto?.subtle)));
  push('WebP decode', await webpSupport());
  lines.push('');

  try {
    const res = await fetch(`assets/js/viewer.js?diag=${Date.now()}`, { cache: 'no-store' });
    const js = await res.text();
    push('viewer build', js.includes('applyWindow') ? 'windowed (current)' : 'LEGACY — hard refresh needed');
  } catch (err) {
    push('viewer build', `unknown — ${err.message}`);
  }
  lines.push('');

  try {
    const res = await fetch(`secure/index.enc?diag=${Date.now()}`, { cache: 'no-store' });
    const raw = new Uint8Array(await res.arrayBuffer());
    const magic = raw.length >= 4 ? String.fromCharCode(...raw.slice(0, 4)) : '—';
    push('index.enc', `${res.status} · ${raw.length} B · magic ${magic}`);
  } catch (err) {
    push('index.enc', `FAILED — ${err.message}`);
  }
  lines.push('');

  const key = secure.peekKey();
  const item = store.allItems().find((entry) => entry.secure);
  if (!item) {
    lines.push('nothing unlocked — enter the password above and run again');
  } else {
    push('testing item', `${item.title} · ${item.pages.length} pages`);
    for (let i = 0; i < item.pages.length; i++) {
      const label = `  page ${i + 1}`;
      try {
        const res = await fetch(item.pages[i].enc, { cache: 'no-store' });
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!res.ok) { push(label, `fetch ${res.status}`); continue; }
        if (!key) { push(label, `${buf.length} B · no key`); continue; }

        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: buf.slice(0, 12) },
          key,
          buf.slice(12),
        );
        const bytes = new Uint8Array(plain);
        const riff = String.fromCharCode(...bytes.slice(0, 4));
        const webp = String.fromCharCode(...bytes.slice(8, 12));
        let decode = 'ok';
        try {
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
          decode = `decoded ${bitmap.width}x${bitmap.height}`;
          bitmap.close?.();
        } catch (err) {
          decode = `DECODE FAILED — ${err.message}`;
        }
        push(label, `${buf.length} B · ${riff}/${webp} · ${decode}`);
      } catch (err) {
        push(label, `ERROR — ${err.message}`);
      }
    }
  }

  const broken = [...document.images].filter((img) => img.hasAttribute('src') && img.complete && img.naturalWidth === 0);
  lines.push('');
  push('broken <img>', String(broken.length));
  broken.slice(0, 5).forEach((img) => lines.push(`  ${img.getAttribute('src')?.slice(0, 48)}`));
  return lines.join('\n');
}

export function showReport() {
  const overlay = document.createElement('div');
  overlay.className = 'diag';
  overlay.innerHTML = `
    <div class="diag-panel">
      <header>
        <strong>Locked shelf diagnostics</strong>
        <button type="button" data-close>close</button>
      </header>
      <div class="diag-bar">
        <input type="password" id="diagPass" placeholder="password" autocomplete="off">
        <button type="button" class="btn btn-primary btn-sm" id="diagRun">Run test</button>
      </div>
      <pre id="diagOut">reading device information…</pre>
    </div>`;

  overlay.querySelector('[data-close]').addEventListener('click', () => overlay.remove());

  const out = overlay.querySelector('#diagOut');
  const run = async () => {
    out.textContent = 'running…';
    const password = overlay.querySelector('#diagPass').value;
    if (password && !secure.isUnlocked()) {
      try {
        await secure.unlock(password);
        store.invalidateMerge();
      } catch (err) {
        out.textContent = `unlock failed: ${err.message}`;
        return;
      }
    }
    try {
      out.textContent = await buildReport();
    } catch (err) {
      out.textContent = `diagnostics failed: ${err.message}`;
    }
  };

  overlay.querySelector('#diagRun').addEventListener('click', run);
  overlay.querySelector('#diagPass').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') run();
  });

  document.body.appendChild(overlay);
  buildReport().then((text) => { out.textContent = text; }).catch(() => {});
}
