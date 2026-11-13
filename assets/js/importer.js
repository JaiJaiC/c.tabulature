/* ═══════════════════════════════════════════════════════════════
   importer.js — drag & drop, file picking, clipboard paste and
   microphone capture. Everything is written to IndexedDB the
   moment it arrives, so nothing is lost if the tab is closed.
   ═══════════════════════════════════════════════════════════════ */

import * as db from './db.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);

const IMAGE_RE = /^image\/(png|jpeg|jpg|webp|gif|avif|bmp)$/i;
const AUDIO_RE = /^audio\//i;

let hooks = { onChange: () => {}, onToast: () => {}, onSettings: () => {} };
let dragDepth = 0;
let recorder = null;

export function init(options) {
  hooks = { ...hooks, ...options };

  // Global drag & drop
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

  // Clipboard images
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
    if (files.length && hooks.onPagesPicked) await hooks.onPagesPicked(files);
  });

  // Recorder controls
  $('recStop').addEventListener('click', () => stopRecording(true));
  $('recCancel').addEventListener('click', () => stopRecording(false));
}

function hasFiles(event) {
  const types = event.dataTransfer?.types;
  return !!types && [...types].includes('Files');
}

/* ── public entry points ───────────────────────────────────── */

export function pickFiles() {
  $('fileInput').click();
}

export function pickPages() {
  $('pageInput').click();
}

export async function handleFiles(fileList) {
  const files = [...fileList];
  const images = files.filter((f) => IMAGE_RE.test(f.type) || /\.(png|jpe?g|webp|gif|avif)$/i.test(f.name));
  const audio = files.filter((f) => AUDIO_RE.test(f.type) || /\.(mp3|m4a|aac|wav|ogg|opus|flac|webm)$/i.test(f.name));
  const skipped = files.length - images.length - audio.length;

  const added = [];
  for (const file of images) {
    try {
      added.push(await addImageTab(file));
    } catch (err) {
      console.error(err);
      hooks.onToast(`Could not read ${file.name}`, { error: true });
    }
  }
  for (const file of audio) {
    try {
      added.push(await addAudioRecording(file));
    } catch (err) {
      console.error(err);
      hooks.onToast(`Could not read ${file.name}`, { error: true });
    }
  }

  if (added.length) {
    await revealNew();
    const label = added.length === 1
      ? `Saved “${added[0].title}”`
      : `Saved ${added.length} items`;
    hooks.onToast(label);
    db.requestPersistence();
  } else if (skipped > 0) {
    hooks.onToast('Only images and audio files can be added', { error: true });
  }
}

/* ── item builders ─────────────────────────────────────────── */

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
    type: 'tab',
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

async function addAudioRecording(file) {
  const duration = await audioDuration(file).catch(() => 0);
  const blobId = db.uid('b');
  await db.putBlob(blobId, file);

  const { artist, title } = store.splitArtistTitle(file.name);
  const createdAt = file.lastModified ? new Date(file.lastModified).toISOString() : db.nowISO();
  const item = store.draft({
    type: 'recording',
    title,
    artist,
    audio: { blobId, duration, mime: file.type || 'audio/mpeg' },
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
    if (!IMAGE_RE.test(file.type) && !/\.(png|jpe?g|webp|gif|avif)$/i.test(file.name)) continue;
    const { w, h } = await imageSize(file);
    const blobId = db.uid('b');
    await db.putBlob(blobId, file);
    pageArray.push({ blobId, w, h, mime: file.type || 'image/png' });
  }
  item.pages = pageArray;
  await store.save(item);
  return item;
}

function audioDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const cleanup = (value) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => cleanup(Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Unreadable audio'));
    };
    audio.src = url;
  });
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

/* ── microphone ────────────────────────────────────────────── */

export async function startRecording() {
  if (recorder) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    hooks.onToast('Recording is not supported in this browser', { error: true });
    return;
  }
  if (!window.isSecureContext) {
    hooks.onToast('Recording needs HTTPS (the published site has it)', { error: true });
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    hooks.onToast('Microphone permission was denied', { error: true });
    return;
  }

  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || '';

  let rec;
  try {
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    hooks.onToast('Could not start the recorder', { error: true });
    return;
  }

  const chunks = [];
  rec.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const type = rec.mimeType || mime || 'audio/webm';
    const blob = new Blob(chunks, { type });
    recorder = null;
    $('recorder').hidden = true;
    stopTimer();

    if (!chunks.length) return;
    const duration = await audioDuration(blob).catch(() => 0);
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const stamp = new Date();
    const title = `Recording ${stamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${stamp
      .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    const blobId = db.uid('b');
    await db.putBlob(blobId, blob);
    const item = store.draft({
      type: 'recording',
      title,
      audio: { blobId, duration, mime: type, ext },
      source: 'local',
    });
    await store.save(item);
    await revealNew();
    hooks.onToast('Recording saved');
  };

  recorder = rec;
  rec.start(200);
  $('recorder').hidden = false;
  startTimer();
}

export function stopRecording(save) {
  if (!recorder) return;
  if (!save) {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    try { recorder.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  }
  try { recorder.stop(); } catch { /* ignore */ }
  if (!save) {
    recorder = null;
    $('recorder').hidden = true;
    stopTimer();
  }
}

let timerId = null;
let startedAt = 0;

function startTimer() {
  startedAt = Date.now();
  const paint = () => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    $('recTime').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  };
  paint();
  timerId = setInterval(paint, 500);
}

function stopTimer() {
  clearInterval(timerId);
  timerId = null;
  $('recTime').textContent = '00:00';
}

export function isRecording() {
  return !!recorder;
}
