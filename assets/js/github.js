/* ═══════════════════════════════════════════════════════════════
   github.js — optional publishing. Takes the items saved on this
   device and commits them into the repo in a single atomic commit
   (Git Data API), so every device sees the same library.
   ═══════════════════════════════════════════════════════════════ */

import * as db from './db.js?v=17';
import * as store from './store.js?v=17';

const API = 'https://api.github.com';
const MANIFEST_PATH = 'data/library.json';
const MEDIA_DIR = 'media';

/* ── low-level request ─────────────────────────────────────── */

async function request(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tablature-web',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const err = new Error(describeError(res.status, data, method, path));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function describeError(status, data, method, path) {
  const message = data?.message || '';
  if (status === 401) return 'Token rejected — check that it is valid and not expired.';
  if (status === 403) {
    if (/rate limit/i.test(message)) return 'GitHub rate limit reached — try again in a few minutes.';
    return 'Permission denied — the token needs Contents: read & write on this repository.';
  }
  if (status === 404) return 'Repository not found — check the owner/name and that the token can see it.';
  if (status === 409) return 'The repository is empty — create a first commit (or a README) and try again.';
  if (status === 422) return 'GitHub rejected the change — the branch may have moved. Try again.';
  return `${method} ${path} failed (${status}) ${message}`.trim();
}

/* ── connection ────────────────────────────────────────────── */

export async function testConnection(settings) {
  const repo = (settings.repo || '').trim();
  const token = (settings.token || '').trim();
  if (!repo || !repo.includes('/')) throw new Error('Repository must look like owner/name');
  if (!token) throw new Error('Add a fine-grained token first');

  const [owner, name] = repo.split('/');
  const info = await request('GET', `/repos/${owner}/${name}`, { token });
  const me = await request('GET', '/user', { token }).catch(() => null);
  let canWrite = false;
  try {
    await request('GET', `/repos/${owner}/${name}/git/ref/heads/${settings.branch || 'main'}`, { token });
    canWrite = true;
  } catch (err) {
    if (err.status === 409) canWrite = true;
  }
  return {
    fullName: info.full_name,
    private: info.private,
    login: me?.login || owner,
    canWrite,
    defaultBranch: info.default_branch,
  };
}

/* ── publishing ────────────────────────────────────────────── */

export async function publish(settings, { onProgress = () => {} } = {}) {
  const repo = (settings.repo || '').trim();
  const token = (settings.token || '').trim();
  const branch = (settings.branch || 'main').trim() || 'main';
  if (!repo.includes('/')) throw new Error('Repository must look like owner/name');
  if (!token) throw new Error('Add a fine-grained token in Storage & sync first');

  const [owner, name] = repo.split('/');
  const base = `/repos/${owner}/${name}`;

  const pending = store.state.localItems.filter((item) => !item.publishedAt);
  if (!pending.length) {
    onProgress('Everything is already published');
    return { published: 0 };
  }

  /* 1 — current head, so the new commit lands on top of it */
  onProgress('Reading repository state…');
  let headSha = null;
  try {
    const ref = await request('GET', `${base}/git/ref/heads/${branch}`, { token });
    headSha = ref.object.sha;
  } catch (err) {
    if (err.status !== 409) throw err;
  }

  /* 2 — upload media as blobs */
  const files = []; // { path, content }
  let fileIndex = 0;
  const total = pending.reduce((n, i) => n + (i.pages?.length || 0), 0) || 1;

  for (const item of pending) {
    if (item.pages?.length) {
      for (let i = 0; i < item.pages.length; i++) {
        const page = item.pages[i];
        if (!page.blobId) continue;
        const blob = await db.getBlob(page.blobId);
        if (!blob) continue;
        fileIndex++;
        onProgress(`Uploading ${fileIndex}/${total} · ${item.title}`);
        const ext = extensionFor(blob.type || page.mime, 'png');
        files.push({
          path: `${MEDIA_DIR}/${item.id}/p${i + 1}.${ext}`,
          content: await blobToBase64(blob),
        });
        item._publishedPages = item._publishedPages || [];
        item._publishedPages[i] = { src: `${MEDIA_DIR}/${item.id}/p${i + 1}.${ext}`, w: page.w, h: page.h };
      }
    }
  }

  /* 3 — merge the entries into library.json */
  onProgress('Updating library index…');
  const manifest = await readManifest(owner, name, branch, token);
  const entries = new Map(manifest.items.map((entry) => [entry.id, entry]));
  const now = db.nowISO();

  for (const item of pending) {
    const entry = cloudEntry(item, now);
    entries.set(entry.id, entry);
  }
  const nextManifest = {
    version: manifest.version || 1,
    updatedAt: now,
    items: [...entries.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
  };

  files.push({
    path: MANIFEST_PATH,
    content: utf8ToBase64(JSON.stringify(nextManifest, null, 2)),
  });

  /* 4 — one commit for everything */
  onProgress('Committing…');
  const tree = await buildTree({ base, token, branch, headSha, files });
  const commit = await request('POST', `${base}/git/commits`, {
    token,
    body: {
      message: pending.length === 1 ? `Add ${pending[0].title}` : `Add ${pending.length} items`,
      tree: tree.sha,
      parents: headSha ? [headSha] : [],
    },
  }).catch((err) => { throw err; });

  if (headSha) {
    await request('PATCH', `${base}/git/refs/heads/${branch}`, {
      token,
      body: { sha: commit.sha, force: false },
    });
  } else {
    await request('POST', `${base}/git/refs`, {
      token,
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    });
  }

  /* 5 — remember what was published */
  for (const item of pending) {
    const local = store.state.localItems.find((i) => i.id === item.id);
    if (!local) continue;
    local.publishedAt = now;
    delete local._publishedPages;
    local.type = local.type === 'piano' ? 'piano' : 'guitar';
    await db.putItem(local);
  }

  await store.refresh();
  onProgress('Published');
  return { published: pending.length, commit: commit.sha };
}

function cloudEntry(item, now) {
  const pages = (item.pages || [])
    .map((page, i) => {
      const up = item._publishedPages?.[i];
      if (up) return up;
      if (page.src) return { src: page.src, w: page.w, h: page.h, thumb: page.thumb };
      return null;
    })
    .filter(Boolean);

  const entry = {
    id: item.id,
    type: item.type === 'piano' ? 'piano' : 'guitar',
    title: item.title,
    artist: item.artist || '',
    capo: item.capo || '',
    tuning: item.tuning || '',
    tags: item.tags || [],
    notes: item.notes || '',
    pages,
    createdAt: item.createdAt,
    updatedAt: now,
    source: 'cloud',
  };

  return entry;
}

async function buildTree({ base, token, branch, headSha, files }) {
  const blobs = [];
  for (const file of files) {
    const blob = await request('POST', `${base}/git/blobs`, {
      token,
      body: { content: file.content, encoding: 'base64' },
    });
    blobs.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  let baseTree;
  if (headSha) {
    const commit = await request('GET', `${base}/git/commits/${headSha}`, { token });
    baseTree = commit.tree.sha;
  }

  return request('POST', `${base}/git/trees`, {
    token,
    body: baseTree ? { base_tree: baseTree, tree: blobs } : { tree: blobs },
  });
}

async function readManifest(owner, name, branch, token) {
  try {
    const data = await request('GET', `/repos/${owner}/${name}/contents/${MANIFEST_PATH}?ref=${branch}`, { token });
    const text = base64ToUtf8(String(data.content || '').replace(/\n/g, ''));
    const parsed = JSON.parse(text);
    return { version: parsed.version || 1, updatedAt: parsed.updatedAt, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch (err) {
    if (err.status === 404) return { version: 1, updatedAt: null, items: [] };
    throw err;
  }
}

/* ── encoding helpers ──────────────────────────────────────── */

function extensionFor(mime = '', fallback = 'bin') {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
    'audio/flac': 'flac',
  };
  return map[mime] || fallback;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsDataURL(blob);
  });
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUtf8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
