/* ═══════════════════════════════════════════════════════════════
   importer.js — drag & drop, file picking and clipboard paste.
   Every image is written to IndexedDB the moment it arrives, so
   nothing is lost if the tab is closed.
   ═══════════════════════════════════════════════════════════════ */

import * as db from './db.js?v=13';
import * as store from './store.js?v=13';

const $ = (id) => document.getElementById(id);

const IMAGE_RE = /^image\/(png|jpeg|jpg|webp|gif|avif|bmp)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;

let hooks = { onToast: () => {}, onPagesPicked: () => {} };
let dragDepth = 0;

export function init(options) {
  hooks = { ...hooks, ...options };

  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    $('dropOverlay').hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropOverlay').hidden = true;
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    $('dropOverlay').hidden = true;
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) handleFiles(files);
  });

  document.addEventListener('paste', (event) => {
    const target = event.target;
    if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) {
      event.preventDefault();
      handleFiles(files);
    }
  });

  $('fileInput').addEventListener('change', async (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length) await handleFiles(files);
  });

  $('pageInput').addEventListener('change', async (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length) await hooks.onPagesPicked(files);
  });
}

function hasFiles(event) {
  const types = event.dataTransfer?.types;
  return !!types && [...types].includes('Files');
}

export function pickFiles() {
  $('fileInput').click();
}

export function pickPages() {
  $('pageInput').click();
}

/* ── import ────────────────────────────────────────────────── */

export async function handleFiles(fileList) {
  const files = [...fileList];
  const images = files.filter((f) => IMAGE_RE.test(f.type) || IMAGE_EXT.test(f.name));
  const skipped = files.length - images.length;

  const added = [];
  for (const file of images) {
    try {
      added.push(await addImageTab(file));
    } catch (err) {
      console.error(err);
      hooks.onToast(`Could not read ${file.name}`, { error: true });
    }
  }

  if (added.length) {
    await revealNew();
    hooks.onToast(added.length === 1 ? `Saved “${added[0].title}”` : `Saved ${added.length} tabs`);
    db.requestPersistence();
  } else if (skipped > 0) {
    hooks.onToast('Only image files can be added', { error: true });
  }
}

async function imageSize(file) {
  try {
    if ('createImageBitmap' in window) {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const size = { w: bitmap.width, h: bitmap.height };
      bitmap.close?.();
      return size;
    }
  } catch { /* fall through */ }
  return await new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ w: 0, h: 0 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

async function addImageTab(file) {
  const { w, h } = await imageSize(file);
  const blobId = db.uid('b');
  await db.putBlob(blobId, file);

  const { artist, title } = store.splitArtistTitle(file.name);
  const createdAt = file.lastModified ? new Date(file.lastModified).toISOString() : db.nowISO();
  const item = store.draft({
    type: 'guitar',
    title,
    artist,
    pages: [{ blobId, w, h, mime: file.type || 'image/png' }],
    createdAt,
    updatedAt: createdAt,
    source: 'local',
  });
  await store.save(item);
  return item;
}

export async function appendPages(item, files) {
  const pageArray = [...(item.pages || [])];
  for (const file of files) {
    if (!IMAGE_RE.test(file.type) && !IMAGE_EXT.test(file.name)) continue;
    const { w, h } = await imageSize(file);
    const blobId = db.uid('b');
    await db.putBlob(blobId, file);
    pageArray.push({ blobId, w, h, mime: file.type || 'image/png' });
  }
  item.pages = pageArray;
  await store.save(item);
  return item;
}

/** Make sure whatever was just added is actually on screen. */
async function revealNew() {
  const s = store.state;
  if (s.filter !== 'all') store.setFilter('all');
  if (s.query) {
    s.query = '';
    $('search').value = '';
  }
  await store.refresh();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
