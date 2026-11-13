/* ═══════════════════════════════════════════════════════════════
   viewer.js — full-screen reader: pages, zoom, swipe navigation,
   and the custom audio player used by recordings.
   ═══════════════════════════════════════════════════════════════ */

import * as store from './store.js';
import * as db from './db.js';
import { toast } from './ui.js';

const $ = (id) => document.getElementById(id);

const MAX_W = 1080;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

const vs = {
  id: null,
  zoom: 1,
  base: 0,
  list: [],
  audio: null,
  onEdit: null,
  lastFocus: null,
};

/* ── open / close ──────────────────────────────────────────── */

export function init({ onEdit }) {
  vs.onEdit = onEdit;

  $('viewerClose').addEventListener('click', close);
  $('prevItem').addEventListener('click', () => step(-1));
  $('nextItem').addEventListener('click', () => step(1));
  $('zoomIn').addEventListener('click', () => zoomBy(1.25));
  $('zoomOut').addEventListener('click', () => zoomBy(1 / 1.25));
  $('zoomReset').addEventListener('click', () => setZoom(1));
  $('editItem').addEventListener('click', () => {
    if (vs.id && vs.onEdit) vs.onEdit(vs.id);
  });
  $('downloadItem').addEventListener('click', download);

  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', debounce(recompute, 120));
  window.addEventListener('orientationchange', debounce(recompute, 200));

  bindGestures();
}

export function open(id) {
  const item = store.getItem(id);
  if (!item) return;
  vs.lastFocus = document.activeElement;
  vs.id = id;
  vs.zoom = 1;
  vs.list = store.visibleItems().map((i) => i.id);
  if (!vs.list.includes(id)) vs.list = [id];

  $('viewer').hidden = false;
  document.body.classList.add('no-scroll');
  renderItem(true);
  $('viewerClose').focus({ preventScroll: true });
}

export function close() {
  if ($('viewer').hidden) return;
  stopAudio();
  $('viewer').hidden = true;
  $('viewerPages').innerHTML = '';
  document.body.classList.remove('no-scroll');
  vs.id = null;
  vs.list = [];
  if (vs.lastFocus && typeof vs.lastFocus.focus === 'function') {
    vs.lastFocus.focus({ preventScroll: true });
  }
}

export function isOpen() {
  return !$('viewer').hidden;
}

export function currentId() {
  return vs.id;
}

export function reload() {
  if (!isOpen() || !vs.id) return;
  vs.list = store.visibleItems().map((i) => i.id);
  if (!vs.list.includes(vs.id)) vs.list = [vs.id];
  renderItem(true);
}

/* ── navigation ────────────────────────────────────────────── */

function step(delta) {
  if (!vs.list.length) return;
  const i = vs.list.indexOf(vs.id);
  const next = i + delta;
  if (next < 0 || next >= vs.list.length) return;
  vs.id = vs.list[next];
  vs.zoom = 1;
  renderItem(true);
}

function setCounter() {
  const i = vs.list.indexOf(vs.id);
  $('viewerCounter').textContent = vs.list.length > 1 ? `${i + 1} / ${vs.list.length}` : '';
  $('prevItem').disabled = i <= 0;
  $('nextItem').disabled = i >= vs.list.length - 1;
}

/* ── render ────────────────────────────────────────────────── */

async function renderItem(resetScroll) {
  const item = store.getItem(vs.id);
  if (!item) {
    close();
    return;
  }
  stopAudio();

  $('viewerTitle').textContent = item.title || 'Untitled';
  $('viewerSub').textContent = store.subtitle(item);
  setCounter();
  $('zoomReset').textContent = '100%';
  renderFooter(item);

  const host = $('viewerPages');
  host.innerHTML = '';

  if (item.type === 'recording') {
    $('zoomIn').hidden = true;
    $('zoomOut').hidden = true;
    $('zoomReset').hidden = true;
    host.appendChild(await audioStage(item));
  } else {
    $('zoomIn').hidden = false;
    $('zoomOut').hidden = false;
    $('zoomReset').hidden = false;
    const pages = item.pages || [];
    if (!pages.length) {
      const p = document.createElement('div');
      p.className = 'page-fallback';
      p.textContent = 'This tab has no pages yet. Use the pencil to add images.';
      host.appendChild(p);
    }
    pages.forEach((page, index) => {
      const img = document.createElement('img');
      img.dataset.index = String(index);
      img.alt = `${item.title || 'Tab'} — page ${index + 1}`;
      if (page.w && page.h) img.style.aspectRatio = `${page.w} / ${page.h}`;
      img.decoding = 'async';
      img.loading = index === 0 ? 'eager' : 'lazy';
      store.urlForPage(page).then((url) => {
        if (url) img.src = url;
      }).catch(() => { /* ignore */ });
      img.addEventListener('error', () => {
        const fallback = document.createElement('div');
        fallback.className = 'page-fallback';
        fallback.textContent = 'This image could not be loaded.';
        img.replaceWith(fallback);
      });
      host.appendChild(img);
    });
  }

  const scroll = $('viewerScroll');
  if (resetScroll) scroll.scrollTop = 0;
  recompute();
}

function renderFooter(item) {
  const foot = $('viewerFoot');
  const chips = [];
  if (item.artist) chips.push(`<span class="foot-chip">${store.escapeHtml(item.artist)}</span>`);
  if (item.capo) chips.push(`<span class="foot-chip">Capo <strong>${store.escapeHtml(item.capo)}</strong></span>`);
  if (item.tuning) chips.push(`<span class="foot-chip">${store.escapeHtml(item.tuning)}</span>`);
  (item.tags || []).slice(0, 3).forEach((t) => chips.push(`<span class="foot-chip">#${store.escapeHtml(t)}</span>`));
  if (item.notes) chips.push(`<span class="foot-chip" title="${store.escapeHtml(item.notes)}">Notes</span>`);

  if (item.type === 'recording' && item.linkedTab) {
    const linked = store.getItem(item.linkedTab);
    if (linked) {
      chips.push(`<button class="foot-btn" data-goto="${store.escapeHtml(linked.id)}" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ${store.escapeHtml(linked.title)}</button>`);
    }
  }
  foot.innerHTML = chips.join('');
  foot.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => open(btn.getAttribute('data-goto')));
  });
}

/* ── zoom ──────────────────────────────────────────────────── */

function recompute() {
  if (!isOpen()) return;
  const scroll = $('viewerScroll');
  const style = window.getComputedStyle(scroll);
  const pad = parseFloat(style.paddingLeft || 0) + parseFloat(style.paddingRight || 0);
  const available = Math.max(200, scroll.clientWidth - pad);
  vs.base = Math.min(available, MAX_W);
  applyZoom();
}

function applyZoom() {
  const width = Math.round(vs.base * vs.zoom);
  document.documentElement.style.setProperty('--zw', `${width}px`);
  $('zoomReset').textContent = `${Math.round(vs.zoom * 100)}%`;
}

function setZoom(z) {
  vs.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  applyZoom();
}

function zoomBy(factor) {
  setZoom(vs.zoom * factor);
}

/* ── gestures: pinch + swipe ───────────────────────────────── */

function bindGestures() {
  const scroll = $('viewerScroll');
  let pinchStart = 0;
  let pinchZoom = 1;
  let startX = 0;
  let startY = 0;
  let tracking = false;

  scroll.addEventListener('touchstart', (event) => {
    if (document.body.classList.contains('no-scroll') === false) return;
    if (event.touches.length === 2) {
      pinchStart = distance(event.touches[0], event.touches[1]);
      pinchZoom = vs.zoom;
      tracking = false;
    } else if (event.touches.length === 1) {
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      tracking = true;
    }
  }, { passive: true });

  scroll.addEventListener('touchmove', (event) => {
    if (event.touches.length === 2 && pinchStart) {
      event.preventDefault();
      const ratio = distance(event.touches[0], event.touches[1]) / pinchStart;
      setZoom(pinchZoom * ratio);
      tracking = false;
    } else if (tracking && event.touches.length === 1) {
      const dy = Math.abs(event.touches[0].clientY - startY);
      const dx = Math.abs(event.touches[0].clientX - startX);
      if (dy > 14 || dx > 14) tracking = false;
    }
  }, { passive: false });

  scroll.addEventListener('touchend', (event) => {
    if (event.touches.length < 2) pinchStart = 0;
    if (!tracking) return;
    tracking = false;
    if (vs.zoom > 1.02) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Math.abs(dx) > 72 && Math.abs(dy) < 56 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      step(dx < 0 ? 1 : -1);
    }
  }, { passive: true });

  // Double-click / double-tap toggles a comfortable reading zoom.
  let lastTap = 0;
  scroll.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 320) {
      setZoom(vs.zoom > 1.4 ? 1 : 2);
      lastTap = 0;
    } else {
      lastTap = now;
    }
  });
}

function distance(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/* ── audio ─────────────────────────────────────────────────── */

async function audioStage(item) {
  const stage = document.createElement('div');
  stage.className = 'audio-stage';
  stage.innerHTML = `
    <div class="audio-art">
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-opacity=".18"/>
        <circle cx="24" cy="24" r="13" fill="none" stroke="currentColor" stroke-opacity=".28"/>
        <circle cx="24" cy="24" r="3.2" fill="currentColor"/>
      </svg>
    </div>
    <h3 class="audio-title">${store.escapeHtml(item.title || 'Recording')}</h3>
    <p class="audio-sub">${store.escapeHtml(store.subtitle(item))}</p>
    <div class="player">
      <button class="player-btn" data-play type="button" aria-label="Play">
        <svg class="icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>
        <svg class="icon-pause" viewBox="0 0 24 24" aria-hidden="true" hidden><path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor"/></svg>
      </button>
      <span class="player-time" data-cur>0:00</span>
      <div class="player-track" data-track role="slider" tabindex="0" aria-label="Seek">
        <div class="player-fill" data-fill></div>
        <div class="player-knob" data-knob></div>
      </div>
      <span class="player-time" data-dur>0:00</span>
      <button class="player-rate" data-rate type="button" title="Playback speed">1×</button>
    </div>
    ${item.notes ? `<p class="audio-notes">${store.escapeHtml(item.notes)}</p>` : ''}
  `;

  const url = await store.urlForAudio(item);
  if (!url) {
    const warn = document.createElement('p');
    warn.className = 'audio-missing';
    warn.textContent = 'The audio file for this recording is not available on this device yet.';
    stage.appendChild(warn);
    return stage;
  }

  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = url;
  vs.audio = audio;

  const playBtn = stage.querySelector('[data-play]');
  const iconPlay = stage.querySelector('.icon-play');
  const iconPause = stage.querySelector('.icon-pause');
  const fill = stage.querySelector('[data-fill]');
  const knob = stage.querySelector('[data-knob]');
  const track = stage.querySelector('[data-track]');
  const cur = stage.querySelector('[data-cur]');
  const dur = stage.querySelector('[data-dur]');
  const rateBtn = stage.querySelector('[data-rate]');

  const paint = () => {
    const d = audio.duration || item.audio?.duration || 0;
    const t = audio.currentTime || 0;
    const pct = d ? Math.min(100, (t / d) * 100) : 0;
    fill.style.width = `${pct}%`;
    knob.style.left = `${pct}%`;
    cur.textContent = db.formatDuration(t);
    dur.textContent = db.formatDuration(d);
  };

  const syncIcon = () => {
    const playing = !audio.paused;
    iconPlay.hidden = playing;
    iconPause.hidden = !playing;
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    stage.classList.toggle('is-playing', playing);
  };

  audio.addEventListener('loadedmetadata', paint);
  audio.addEventListener('timeupdate', paint);
  audio.addEventListener('play', syncIcon);
  audio.addEventListener('pause', syncIcon);
  audio.addEventListener('ended', syncIcon);
  audio.addEventListener('error', () => {
    dur.textContent = '—';
    cur.textContent = 'audio error';
  });

  playBtn.addEventListener('click', () => {
    if (audio.paused) audio.play().catch(() => toast('Playback was blocked by the browser', { error: true }));
    else audio.pause();
  });

  const seek = (clientX) => {
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (Number.isFinite(audio.duration)) {
      audio.currentTime = ratio * audio.duration;
      paint();
    }
  };

  let seeking = false;
  track.addEventListener('pointerdown', (event) => {
    seeking = true;
    track.setPointerCapture(event.pointerId);
    seek(event.clientX);
  });
  track.addEventListener('pointermove', (event) => { if (seeking) seek(event.clientX); });
  track.addEventListener('pointerup', () => { seeking = false; });
  track.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') { event.stopPropagation(); audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); }
    if (event.key === 'ArrowLeft') { event.stopPropagation(); audio.currentTime = Math.max(0, audio.currentTime - 5); }
  });

  const rates = [1, 0.75, 1.25, 1.5, 0.5];
  rateBtn.addEventListener('click', () => {
    const i = (rates.indexOf(audio.playbackRate) + 1) % rates.length;
    audio.playbackRate = rates[i];
    rateBtn.textContent = `${rates[i]}×`;
  });

  paint();
  return stage;
}

function stopAudio() {
  if (vs.audio) {
    try { vs.audio.pause(); } catch { /* ignore */ }
    vs.audio.src = '';
    vs.audio = null;
  }
}

/* ── download ──────────────────────────────────────────────── */

async function download() {
  const item = store.getItem(vs.id);
  if (!item) return;
  try {
    if (item.type === 'recording') {
      const url = await store.urlForAudio(item);
      if (!url) return toast('Audio not available on this device', { error: true });
      triggerDownload(url, `${safeName(item.title)}.mp3`);
      return;
    }
    const pages = item.pages || [];
    for (let i = 0; i < pages.length; i++) {
      const url = await store.urlForPage(pages[i]);
      if (!url) continue;
      const ext = (url.split('?')[0].match(/\.(png|jpe?g|webp|gif)$/i) || [, 'png'])[1];
      triggerDownload(url, `${safeName(item.title)}${pages.length > 1 ? `-p${i + 1}` : ''}.${ext}`);
      if (pages.length > 1) await new Promise((r) => setTimeout(r, 260));
    }
    toast(pages.length > 1 ? `Downloading ${pages.length} pages` : 'Download ready');
  } catch (err) {
    toast('Download failed', { error: true });
  }
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function safeName(title) {
  return String(title || 'tab').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'tab';
}

/* ── keyboard ──────────────────────────────────────────────── */

function onKey(event) {
  if (!isOpen()) return;
  if ($('editor').hidden === false || $('settings').hidden === false) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

  switch (event.key) {
    case 'Escape':
      event.preventDefault();
      close();
      break;
    case 'ArrowRight':
      if (!typing) { event.preventDefault(); step(1); }
      break;
    case 'ArrowLeft':
      if (!typing) { event.preventDefault(); step(-1); }
      break;
    case '+':
    case '=':
      event.preventDefault();
      zoomBy(1.25);
      break;
    case '-':
      event.preventDefault();
      zoomBy(1 / 1.25);
      break;
    case '0':
      event.preventDefault();
      setZoom(1);
      break;
    default:
      break;
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
