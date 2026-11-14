/* ═══════════════════════════════════════════════════════════════
   app.js — wiring: search, filters, add menu, settings, backup.
   ═══════════════════════════════════════════════════════════════ */

import * as db from './db.js?v=11';
import * as store from './store.js?v=11';
import * as ui from './ui.js?v=11';
import * as viewer from './viewer.js?v=11';
import * as editor from './editor.js?v=11';
import * as importer from './importer.js?v=11';
import * as github from './github.js?v=11';
import * as secure from './secure.js?v=11';
import { showReport } from './diag.js?v=11';

const BUILD = '11';

const $ = (id) => document.getElementById(id);

/* ── boot ──────────────────────────────────────────────────── */

async function boot() {
  document.documentElement.dataset.build = BUILD;
  const tag = document.getElementById('buildTag');
  if (tag) tag.textContent = BUILD;
  viewer.init({ onEdit: (id) => editor.open(id) });
  editor.init({
    onSaved: (id) => {
      ui.render();
      if (viewer.isOpen() && viewer.currentId() === id) viewer.reload();
    },
    onDeleted: () => {
      if (viewer.isOpen()) viewer.close();
      ui.render();
    },
  });
  importer.init({
    onToast: ui.toast,
    onPagesPicked: (files) => editor.receivePages(files),
  });
  ui.bindGrid((id) => viewer.open(id));
  bindChrome();
  bindSettings();
  bindGate();

  store.subscribe(() => {
    ui.render();
    if (viewer.isOpen()) viewer.reload();
  });

  await store.init();
  if (['piano', 'fingerstyle'].includes(store.state.filter) && !secure.isUnlocked()) {
    applyFilter('all');
  }
  renderVerse();
  ui.render();
  syncFormFromSettings();

  if (new URLSearchParams(location.search).has('diag')) showReport();
}

/* ── chrome: search, filters, menu ─────────────────────────── */

function bindChrome() {
  const search = $('search');
  const clear = $('searchClear');
  let timer = null;

  const run = () => {
    store.setQuery(search.value);
    clear.hidden = !search.value;
  };

  search.addEventListener('input', () => {
    clear.hidden = !search.value;
    clearTimeout(timer);
    timer = setTimeout(run, 110);
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      search.value = '';
      run();
      search.blur();
    }
  });
  clear.addEventListener('click', () => {
    search.value = '';
    run();
    search.focus();
  });

  $('chips').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    const filter = chip.getAttribute('data-filter');
    if (LOCKED_SHELVES.includes(filter) && !secure.isUnlocked()) {
      pendingFilter = filter;
      openGate();
      return;
    }
    applyFilter(filter);
  });

  $('refreshBtn').addEventListener('click', async () => {
    $('refreshBtn').disabled = true;
    await store.refresh();
    $('refreshBtn').disabled = false;
    ui.toast('Library reloaded');
  });

  $('emptyAdd').addEventListener('click', () => importer.pickFiles());

  // Add menu
  const addBtn = $('addBtn');
  const menu = $('addMenu');
  const closeMenu = () => {
    menu.hidden = true;
    addBtn.setAttribute('aria-expanded', 'false');
  };
  const toggleMenu = () => {
    const open = menu.hidden;
    menu.hidden = !open;
    addBtn.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('.menu-item')?.focus({ preventScroll: true });
  };

  addBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu();
  });
  menu.addEventListener('click', async (event) => {
    const item = event.target.closest('.menu-item');
    if (!item) return;
    closeMenu();
    const action = item.getAttribute('data-action');
    if (action === 'upload') importer.pickFiles();
    if (action === 'settings') openSettings();
  });
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !event.target.closest('.add-wrap')) closeMenu();
  });

  $('settingsBtn').addEventListener('click', openSettings);
  $('pageFullscreen').addEventListener('click', togglePageFullscreen);
  document.addEventListener('fullscreenchange', () => {
    $('pageFullscreen').classList.toggle('is-on', Boolean(document.fullscreenElement));
  });

  // Global shortcuts
  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (event.key === '/' && !typing && viewer.isHidden !== true) {
      if (!viewer.isOpen()) {
        event.preventDefault();
        $('search').focus();
        $('search').select();
      }
    }
    if (event.key === 'Escape') {
      closeMenu();
      if (!$('settings').hidden) closeSettings();
    }
  });
}

/* ── settings modal ────────────────────────────────────────── */

function openSettings() {
  syncFormFromSettings();
  $('settings').hidden = false;
  document.body.classList.add('no-scroll');
  refreshStorageFacts();
  setTimeout(() => $('sRepo').focus({ preventScroll: true }), 40);
}

function closeSettings() {
  if ($('settings').hidden) return;
  $('settings').hidden = true;
  document.body.classList.remove('no-scroll');
}

function syncFormFromSettings() {
  const s = db.getSettings();
  $('sRepo').value = s.repo || '';
  $('sBranch').value = s.branch || 'main';
  $('sToken').value = s.token || '';
  $('ghStatus').textContent = s.token ? 'Token saved in this browser' : 'Not connected';
  updatePublishState();
}

function bindSettings() {
  $('settings').querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', closeSettings);
  });
  $('settings').addEventListener('mousedown', (event) => {
    if (event.target === $('settings')) closeSettings();
  });

  const persist = () => {
    db.saveSettings({
      repo: $('sRepo').value.trim(),
      branch: $('sBranch').value.trim() || 'main',
      token: $('sToken').value.trim(),
    });
    updatePublishState();
    ui.render();
  };
  ['sRepo', 'sBranch', 'sToken'].forEach((id) => $(id).addEventListener('change', persist));
  ['sRepo', 'sBranch'].forEach((id) => $(id).addEventListener('blur', persist));

  $('testConnBtn').addEventListener('click', async () => {
    persist();
    const btn = $('testConnBtn');
    btn.disabled = true;
    $('ghStatus').textContent = 'Checking…';
    try {
      const info = await github.testConnection(db.getSettings());
      $('ghStatus').textContent = `${info.fullName} · ${info.login}${info.canWrite ? ' · writable' : ''}`;
      ui.toast('Connected to GitHub');
    } catch (err) {
      $('ghStatus').textContent = err.message;
      ui.toast(err.message, { error: true, ms: 4200 });
    } finally {
      btn.disabled = false;
      updatePublishState();
    }
  });

  $('clearTokenBtn').addEventListener('click', () => {
    db.saveSettings({ token: '' });
    $('sToken').value = '';
    $('ghStatus').textContent = 'Not connected';
    updatePublishState();
    ui.render();
    ui.toast('Token removed from this browser');
  });

  $('publishBtn').addEventListener('click', publishNow);

  $('exportBtn').addEventListener('click', exportBackup);
  $('importBtn').addEventListener('click', () => $('restoreInput').click());
  $('restoreInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await restoreBackup(file);
  });
}

function updatePublishState() {
  const s = db.getSettings();
  const pending = store.stats().unpublished;
  $('pendingCount').textContent = String(pending);
  const ready = Boolean(s.repo?.includes('/') && s.token && pending > 0);
  $('publishBtn').disabled = !ready;
  $('publishBtn').textContent = pending
    ? `Publish ${pending} ${pending === 1 ? 'item' : 'items'} to GitHub`
    : 'Nothing to publish';
}

async function publishNow() {
  const btn = $('publishBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Publishing…';
  try {
    const result = await github.publish(db.getSettings(), {
      onProgress: (label) => { $('ghStatus').textContent = label; },
    });
    btn.textContent = original;
    $('ghStatus').textContent = `Published ${result.published} ${result.published === 1 ? 'item' : 'items'}`;
    ui.toast(result.published ? `Published ${result.published} ${result.published === 1 ? 'item' : 'items'}` : 'Nothing to publish');
    refreshStorageFacts();
  } catch (err) {
    $('ghStatus').textContent = err.message;
    ui.toast(err.message, { error: true, ms: 5200 });
  } finally {
    btn.textContent = original;
    updatePublishState();
    refreshStorageFacts();
  }
}

async function refreshStorageFacts() {
  $('localCount').textContent = String(store.state.localItems.length);
  const { usage } = await db.estimate();
  $('usage').textContent = usage ? db.formatBytes(usage) : '—';
  updatePublishState();
}

/* ── backup / restore ──────────────────────────────────────── */

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [head, body] = String(dataUrl).split(',');
  const mime = (head.match(/data:([^;]+)/) || [, 'application/octet-stream'])[1];
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function exportBackup() {
  const btn = $('exportBtn');
  btn.disabled = true;
  try {
    const items = [];
    for (const item of store.state.localItems) {
      const copy = JSON.parse(JSON.stringify(item));
      if (item.pages?.length) {
        copy.pages = [];
        for (const page of item.pages) {
          if (!page.blobId) {
            copy.pages.push(page);
            continue;
          }
          const blob = await db.getBlob(page.blobId);
          copy.pages.push({
            w: page.w,
            h: page.h,
            mime: page.mime,
            data: blob ? await blobToDataUrl(blob) : null,
          });
        }
      }
      if (item.audio?.blobId) {
        const blob = await db.getBlob(item.audio.blobId);
        copy.audio = {
          duration: item.audio.duration || 0,
          mime: item.audio.mime,
          ext: item.audio.ext,
          data: blob ? await blobToDataUrl(blob) : null,
        };
      }
      items.push(copy);
    }

    const payload = {
      app: 'tablature',
      version: 1,
      exportedAt: new Date().toISOString(),
      items,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `tablature-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    ui.toast(`Backup ready · ${items.length} items`);
  } catch (err) {
    console.error(err);
    ui.toast('Backup failed', { error: true });
  } finally {
    btn.disabled = false;
  }
}

async function restoreBackup(file) {
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (payload.app !== 'tablature' || !Array.isArray(payload.items)) {
      throw new Error('Not a Tablature backup file');
    }
    if (!window.confirm(`Restore ${payload.items.length} items into this browser?`)) return;

    for (const raw of payload.items) {
      const item = { ...raw };
      delete item.publishedAt;
      for (const page of item.pages || []) {
        if (!page.data) continue;
        const blob = dataUrlToBlob(page.data);
        page.blobId = db.uid('b');
        page.mime = blob.type;
        delete page.data;
        await db.putBlob(page.blobId, blob);
      }
      if (item.audio?.data) {
        const blob = dataUrlToBlob(item.audio.data);
        item.audio.blobId = db.uid('b');
        item.audio.mime = blob.type;
        delete item.audio.data;
        await db.putBlob(item.audio.blobId, blob);
      }
      item.source = 'local';
      await db.putItem(item);
    }
    await store.refresh();
    ui.render();
    refreshStorageFacts();
    ui.toast(`Restored ${payload.items.length} items`);
  } catch (err) {
    ui.toast(err.message || 'Restore failed', { error: true, ms: 4200 });
  }
}

/* ── protected shelf ───────────────────────────────────────── */

const LOCKED_SHELVES = ['piano', 'fingerstyle'];
let pendingFilter = 'piano';

async function togglePageFullscreen() {
  if (document.fullscreenElement) {
    try { await document.exitFullscreen(); } catch { /* ignore */ }
    return;
  }
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    ui.toast('This browser does not allow fullscreen', { error: true });
  }
}

function applyFilter(filter) {
  document.querySelectorAll('.chip').forEach((c) => {
    c.classList.toggle('is-active', c.getAttribute('data-filter') === filter);
  });
  store.setFilter(filter);
}

function markUnlocked() {
  document.querySelectorAll('.chip-locked').forEach((chip) => chip.classList.add('is-unlocked'));
}

function openGate() {
  $('gateError').hidden = true;
  $('gatePass').value = '';
  $('gate').hidden = false;
  document.body.classList.add('no-scroll');
  setTimeout(() => $('gatePass').focus({ preventScroll: true }), 40);
}

function closeGate() {
  $('gate').hidden = true;
  document.body.classList.remove('no-scroll');
}

async function submitGate() {
  const password = $('gatePass').value;
  if (!password) {
    $('gatePass').focus();
    return;
  }
  const btn = $('gateSubmit');
  btn.disabled = true;
  btn.textContent = 'Unlocking…';
  try {
    await secure.unlock(password);
    store.invalidateMerge();
    markUnlocked();
    closeGate();
    applyFilter(pendingFilter);
    ui.toast('Shelf unlocked');
  } catch (err) {
    $('gateError').hidden = false;
    $('gateError').textContent = err.message === 'Wrong password'
      ? 'Wrong password — try again.'
      : err.message;
    $('gatePass').select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
}

function bindGate() {
  $('gateSubmit').addEventListener('click', submitGate);
  $('gatePass').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitGate();
    }
  });
  $('gate').querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', closeGate));
  $('gate').addEventListener('mousedown', (event) => {
    if (event.target === $('gate')) closeGate();
  });
}

/* ── a new verse every day ─────────────────────────────────── */

const VERSES = [
  'Some strings remember the evening better than we do.',
  'Every song is a room you can walk back into.',
  'The quiet between two notes is still music.',
  'What the hands forget, the page keeps.',
  'Play it slowly enough and the night slows down with you.',
  'A page of tablature is a letter to your future hands.',
  'Strings hold the light long after the sound has gone.',
  'Practice is patience wearing a familiar shape.',
  'Even silence keeps time.',
  'The best takes are the ones nobody was listening to.',
  'Between the frets lives a small and generous silence.',
  'Songs do not end; they simply stop being played.',
  'Every melody is borrowed light, passed hand to hand.',
  'You are never playing alone in an empty room.',
  'Old scores smell of rain on warm wood.',
  'The strings forgive everything the page remembers.',
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One verse per calendar day. Each block of VERSES.length days is a fresh
 * shuffle, so a line never repeats until every other line has been shown.
 */
function verseOfTheDay(date = new Date()) {
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  const count = VERSES.length;
  const cycle = Math.floor(day / count);
  const position = day % count;
  const random = mulberry32((cycle + 1) * 0x9e3779b9);
  const order = VERSES.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return VERSES[order[position]];
}

function renderVerse() {
  const node = $('verse');
  if (node) node.textContent = verseOfTheDay();
}

/* ── go ────────────────────────────────────────────────────── */

boot().catch((err) => {
  console.error(err);
  ui.toast(`Startup problem: ${err.message}`, { error: true, ms: 6000 });
});
