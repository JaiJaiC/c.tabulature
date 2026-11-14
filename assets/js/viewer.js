/* ═══════════════════════════════════════════════════════════════
   viewer.js — full-screen reader: pages, zoom, swipe navigation.
   ═══════════════════════════════════════════════════════════════ */

import * as store from './store.js?v=13';
import { toast } from './ui.js?v=13';

const $ = (id) => document.getElementById(id);

const MAX_W = 1080;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

const vs = {
  id: null,
  zoom: 1,
  base: 0,
  list: [],
  page: 0,
  spread: false,
  pageUrls: [],
  onEdit: null,
  lastFocus: null,
};

/** Piano and Fingerstyle read page-by-page; guitar jumps between scores. */
function isPaged(item) {
  return Boolean(item) && (item.type === 'piano' || item.type === 'fingerstyle');
}

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
  $('toggleSpread').addEventListener('click', () => {
    vs.spread = !vs.spread;
    applySpread();
  });
  $('toggleFullscreen').addEventListener('click', toggleFullscreen);
  $('toggleChrome').addEventListener('click', () => setChromeHidden(true));
  $('chromeRestore').addEventListener('click', () => setChromeHidden(false));

  document.addEventListener('fullscreenchange', () => {
    const active = Boolean(document.fullscreenElement);
    $('toggleFullscreen').classList.toggle('is-on', active);
    $('viewer').classList.toggle('is-immersive', active);
    recompute();
  });

  $('viewerScroll').addEventListener('scroll', debounce(trackPage, 90), { passive: true });

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
  vs.page = 0;
  vs.list = store.visibleItems().map((i) => i.id);
  if (!vs.list.includes(id)) vs.list = [id];

  $('viewer').hidden = false;
  document.body.classList.add('no-scroll');
  setChromeHidden(false);
  renderItem(true);
  $('viewerClose').focus({ preventScroll: true });
}

/** Hiding the bar gives the page the whole screen; a floating chevron brings it back. */
function setChromeHidden(hidden) {
  $('viewer').classList.toggle('is-chrome-hidden', hidden);
  $('chromeRestore').hidden = !hidden;
  recompute();
}

export function close() {
  if ($('viewer').hidden) return;
  setChromeHidden(false);
  $('viewer').hidden = true;
  $('viewerPages').innerHTML = '';
  document.body.classList.remove('no-scroll');
  vs.id = null;
  vs.list = [];
  vs.pageUrls = [];
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
  const item = store.getItem(vs.id);
  if (isPaged(item)) {
    stepPage(delta);
    return;
  }
  if (!vs.list.length) return;
  const i = vs.list.indexOf(vs.id);
  const next = i + delta;
  if (next < 0 || next >= vs.list.length) return;
  vs.id = vs.list[next];
  vs.zoom = 1;
  vs.page = 0;
  renderItem(true);
}

function pageImages() {
  return [...$('viewerPages').querySelectorAll('img')];
}

/** WebP -> PNG through a canvas, used only when the <img> refuses the bytes. */
async function reencode(url) {
  const response = await fetch(url);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvas.toDataURL('image/png');
}

let failures = 0;
function noteFailure() {
  failures += 1;
  const badge = $('failBadge');
  if (!badge) return;
  badge.hidden = false;
  badge.textContent = `⚠ ${failures}`;
  badge.title = `${failures} page(s) failed to display on this device`;
}

/**
 * Only the pages around the current one keep a decoded bitmap. A nine page
 * score would otherwise decode ~110 MB at once, which phones refuse to do -
 * they show broken images instead.
 */
function applyWindow(center) {
  const imgs = pageImages();
  const from = Math.max(0, center - 1);
  const to = Math.min(imgs.length - 1, center + 2);
  imgs.forEach((img, index) => {
    img.dataset.want = index >= from && index <= to ? '1' : '';
    paintImage(img, index);
  });
}

/**
 * An <img> with alt text but no src renders the browser's broken-image icon,
 * so pages outside the window get this transparent pixel instead of having
 * their src removed. The box keeps its size via `aspect-ratio`.
 */
const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function paintImage(img, index) {
  const url = vs.pageUrls?.[index];
  if (!url) return;
  if (img.dataset.want === '1') {
    if (img.getAttribute('src') !== url) img.src = url;
  } else if (img.getAttribute('src') !== BLANK_PIXEL) {
    img.src = BLANK_PIXEL;
  }
}

function stepPage(delta) {
  const images = pageImages();
  if (images.length < 2) return;
  const stride = vs.spread ? 2 : 1;
  const next = Math.min(images.length - 1, Math.max(0, vs.page + delta * stride));
  if (next === vs.page) return;
  vs.page = next;
  applyWindow(next);
  scrollToPage(next);
  setCounter();
}

function scrollToPage(index) {
  const images = pageImages();
  const target = images[index];
  if (!target) return;
  const scroll = $('viewerScroll');
  scroll.scrollTo({ top: Math.max(0, target.offsetTop - 18), behavior: 'smooth' });
}

function trackPage() {
  if (!isOpen()) return;
  const item = store.getItem(vs.id);
  if (!isPaged(item)) return;
  const images = pageImages();
  if (images.length < 2) return;
  const top = $('viewerScroll').scrollTop + 80;
  let index = 0;
  images.forEach((img, i) => {
    if (img.offsetTop <= top) index = i;
  });
  if (index !== vs.page) {
    vs.page = index;
    applyWindow(index);
    setCounter();
  }
}

function applySpread() {
  const host = $('viewerPages');
  host.classList.toggle('is-spread', vs.spread);
  $('toggleSpread').classList.toggle('is-on', vs.spread);
  if (vs.spread && vs.page % 2 === 1) vs.page -= 1;
  recompute();
  applyWindow(vs.page);
  scrollToPage(vs.page);
  setCounter();
}

async function toggleFullscreen() {
  const viewer = $('viewer');
  if (document.fullscreenElement) {
    try { await document.exitFullscreen(); } catch { /* ignore */ }
    return;
  }
  try {
    await viewer.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // iPhone Safari has no element fullscreen - give the page more room instead.
    const immersive = !viewer.classList.contains('is-immersive');
    viewer.classList.toggle('is-immersive', immersive);
    $('toggleFullscreen').classList.toggle('is-on', immersive);
    recompute();
  }
}

function setCounter() {
  const item = store.getItem(vs.id);
  const counter = $('viewerCounter');

  if (isPaged(item)) {
    const total = item.pages?.length || 0;
    if (total > 1) {
      const start = vs.page + 1;
      const end = vs.spread && start + 1 <= total ? start + 1 : start;
      counter.textContent = start === end ? `${start} / ${total}` : `${start}-${end} / ${total}`;
    } else {
      counter.textContent = '';
    }
    $('prevItem').disabled = vs.page <= 0;
    $('nextItem').disabled = vs.page >= total - 1;
    return;
  }

  const i = vs.list.indexOf(vs.id);
  counter.textContent = vs.list.length > 1 ? `${i + 1} / ${vs.list.length}` : '';
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

  vs.page = 0;
  $('viewerTitle').textContent = item.title || 'Untitled';
  $('viewerSub').textContent = store.subtitle(item);
  $('editItem').hidden = Boolean(item.secure);
  $('toggleSpread').hidden = !(isPaged(item) && (item.pages?.length || 0) > 1);
  $('viewerPages').classList.toggle('is-spread', vs.spread);
  setCounter();
  $('zoomReset').textContent = '100%';
  renderFooter(item);

  const host = $('viewerPages');
  host.innerHTML = '';

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
  vs.pageUrls = new Array(pages.length).fill(null);
  pages.forEach((page, index) => {
    const img = document.createElement('img');
    img.dataset.index = String(index);
    img.alt = `${item.title || 'Tab'} — page ${index + 1}`;
    if (page.w && page.h) img.style.aspectRatio = `${page.w} / ${page.h}`;
    img.decoding = 'async';
    img.loading = 'eager';
    img.src = BLANK_PIXEL;

    const fetchPage = () => store.urlForPage(page).then((url) => {
      if (!url) throw new Error('empty page');
      vs.pageUrls[index] = url;
      paintImage(img, index);
    });
    fetchPage().catch(() => setTimeout(() => {
      fetchPage().catch(() => {
        img.classList.add('is-failed');
        img.alt = `Page ${index + 1} could not be loaded`;
        noteFailure();
      });
    }, 800));
    img.addEventListener('error', async () => {
      const current = img.getAttribute('src');
      if (!current || current === BLANK_PIXEL) return;
      const tries = Number(img.dataset.tries || 0);
      if (tries < 2) {
        img.dataset.tries = String(tries + 1);
        setTimeout(() => {
          const url = vs.pageUrls?.[index];
          if (url && img.dataset.want === '1') {
            img.src = BLANK_PIXEL;
            requestAnimationFrame(() => { img.src = url; });
          }
        }, 400 * (tries + 1));
        return;
      }
      // Last resort: re-encode the pixels through a canvas and try again.
      if (img.dataset.rescued !== '1') {
        img.dataset.rescued = '1';
        try {
          const png = await reencode(current);
          if (png) {
            img.src = png;
            return;
          }
        } catch { /* fall through */ }
      }
      img.classList.add('is-failed');
      img.alt = `Page ${index + 1} could not be loaded`;
      noteFailure();
    });
    host.appendChild(img);
  });
  applyWindow(vs.page);

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

  foot.innerHTML = chips.join('');
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

  // Tap the page image to leave the reader. Swipes and pinches are ignored.
  let lastPinchAt = 0;
  let downX = 0;
  let downY = 0;
  let downAt = 0;

  scroll.addEventListener('touchstart', (event) => {
    if (event.touches.length === 2) lastPinchAt = Date.now();
  }, { passive: true });
  scroll.addEventListener('touchmove', (event) => {
    if (event.touches.length === 2) lastPinchAt = Date.now();
  }, { passive: true });

  const host = $('viewerPages');
  host.addEventListener('pointerdown', (event) => {
    downX = event.clientX;
    downY = event.clientY;
    downAt = Date.now();
  });
  host.addEventListener('pointerup', (event) => {
    if (Date.now() - lastPinchAt < 400) return;
    const moved = Math.hypot(event.clientX - downX, event.clientY - downY);
    if (moved > 10 || Date.now() - downAt > 600) return;
    if (event.target.tagName === 'IMG') close();
  });
}

function distance(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/* ── download ──────────────────────────────────────────────── */

async function download() {
  const item = store.getItem(vs.id);
  if (!item) return;
  try {
    const pages = item.pages || [];
    for (let i = 0; i < pages.length; i++) {
      const url = await store.urlForPage(pages[i]);
      if (!url) continue;
      const ext = pages[i].enc
        ? 'webp'
        : (url.split('?')[0].match(/\.(png|jpe?g|webp|gif)$/i) || [, 'png'])[1];
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
