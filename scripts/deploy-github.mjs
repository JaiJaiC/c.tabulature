#!/usr/bin/env node
/**
 * Minimal GitHub deploy helper (no extra dependencies).
 *
 * Requires a fine-grained token in the .gh-token file (git-ignored) or in
 * the GITHUB_TOKEN environment variable.
 *
 * Usage:
 *   node scripts/deploy-github.mjs create   # create the repo if missing
 *   node scripts/deploy-github.mjs pages    # enable Pages (branch: main, path: /)
 *   node scripts/deploy-github.mjs status   # print Pages build status + URL
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = process.env.GH_OWNER || 'JaiJaiC';
const REPO = process.env.GH_REPO || 'c.tabulature';
const BRANCH = process.env.GH_BRANCH || 'main';

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.vscode', '.idea', '__pycache__']);
const IGNORE_FILES = new Set(['.gh-token', '.github-token', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  for (const p of ['.gh-token', '.github-token']) {
    const file = path.join(ROOT, p);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  }
  throw new Error('No token found. Put one in .gh-token or set GITHUB_TOKEN.');
}

const token = readToken();

async function api(method, endpoint, body) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'tablature-deploy',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`${method} ${endpoint} -> ${res.status} ${data?.message || text}`.slice(0, 300));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const cmd = process.argv[2] || 'status';

try {
  if (cmd === 'create') {
    const me = await api('GET', '/user');
    console.log(`Authenticated as ${me.login}`);
    try {
      const repo = await api('GET', `/repos/${OWNER}/${REPO}`);
      console.log(`Repo already exists: ${repo.html_url}`);
    } catch (e) {
      if (e.status !== 404) throw e;
      const repo = await api('POST', '/user/repos', {
        name: REPO,
        private: false,
        has_issues: true,
        has_wiki: false,
        has_projects: false,
        description: 'Personal guitar tablature + recordings archive',
        auto_init: false,
      });
      console.log(`Created repo: ${repo.html_url}`);
    }
  } else if (cmd === 'pages') {
    try {
      const pages = await api('GET', `/repos/${OWNER}/${REPO}/pages`);
      console.log(`Pages already enabled: ${pages.html_url} (build_type=${pages.build_type})`);
    } catch (e) {
      if (e.status !== 404) throw e;
      const pages = await api('POST', `/repos/${OWNER}/${REPO}/pages`, {
        source: { branch: BRANCH, path: '/' },
      });
      console.log(`Pages enabled: ${JSON.stringify(pages)}`);
    }
    const info = await api('GET', `/repos/${OWNER}/${REPO}/pages`);
    console.log(`URL: ${info.html_url}`);
  } else if (cmd === 'status') {
    const pages = await api('GET', `/repos/${OWNER}/${REPO}/pages`);
    console.log(`URL:      ${pages.html_url}`);
    console.log(`status:   ${pages.status}`);
    console.log(`build:    ${pages.build_type}`);
    if (pages.cname) console.log(`cname:    ${pages.cname}`);
    try {
      const builds = await api('GET', `/repos/${OWNER}/${REPO}/pages/builds/latest`);
      console.log(`latest:   ${builds.status} @ ${builds.updated_at}`);
    } catch { /* no builds yet */ }
  } else if (cmd === 'push') {
    const message = process.argv[3] || 'Update site';
    const result = await pushTree(message);
    console.log(`Pushed ${result.files} files -> ${result.commitUrl}`);
  } else {
    console.log('Usage: node scripts/deploy-github.mjs <create|push|pages|status> [commit message]');
  }
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}

/* ── push the working tree through the Git Data API ────────── */

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      if (IGNORE_FILES.has(entry.name) || entry.name.endsWith('.log')) continue;
      out.push({ rel, full: path.join(dir, entry.name) });
    }
  }
  return out;
}

async function pushTree(message) {
  const head = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`).catch((e) => {
    if (e.status === 404 || e.status === 409) return null;
    throw e;
  });
  const headSha = head?.object?.sha || null;

  const files = walk(ROOT);
  console.log(`found ${files.length} files, ${headSha ? `on top of ${headSha.slice(0, 7)}` : 'first commit'}`);

  // Never clobber tabs that were published from the website.
  const merged = await mergeRemoteManifest(files);

  const tree = [];
  for (const file of files) {
    const content = fs.readFileSync(file.full).toString('base64');
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content, encoding: 'base64' });
    tree.push({ path: file.rel, mode: '100644', type: 'blob', sha: blob.sha });
  }
  if (merged) {
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: Buffer.from(merged.json, 'utf8').toString('base64'),
      encoding: 'base64',
    });
    const existing = tree.find((t) => t.path === 'data/library.json');
    if (existing) existing.sha = blob.sha;
    else tree.push({ path: 'data/library.json', mode: '100644', type: 'blob', sha: blob.sha });
    if (merged.added) console.log(`kept ${merged.added} published item(s) from the live library`);
  }

  let baseTree;
  if (headSha) baseTree = (await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${headSha}`)).tree.sha;

  const newTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree,
  });
  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: headSha ? [headSha] : [],
  });

  if (headSha) {
    await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
  } else {
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  }

  return { files: files.length, commitUrl: `https://github.com/${OWNER}/${REPO}/commit/${commit.sha}` };
}

async function mergeRemoteManifest(files) {
  const local = files.find((f) => f.rel === 'data/library.json');
  if (!local) return null;
  let remote;
  try {
    remote = await api('GET', `/repos/${OWNER}/${REPO}/contents/data/library.json?ref=${BRANCH}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
  const remoteJson = Buffer.from(String(remote.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
  const remoteItems = JSON.parse(remoteJson).items || [];
  const localDoc = JSON.parse(fs.readFileSync(local.full, 'utf8'));
  const known = new Set((localDoc.items || []).map((i) => i.id));
  const missing = remoteItems.filter((i) => !known.has(i.id));
  if (!missing.length) return null;

  localDoc.items = [...(localDoc.items || []), ...missing];
  return { json: JSON.stringify(localDoc, null, 2) + '\n', added: missing.length };
}
