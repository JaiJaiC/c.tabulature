#!/usr/bin/env node
/**
 * Encrypt the rendered Fingerstyle pages so the repository only ever
 * contains ciphertext.
 *
 *   node scripts/build_secure.mjs [password]
 *
 * Reads .secure_staging/ (produced by scripts/build_secure.py) and writes:
 *   secure/index.enc        encrypted JSON: titles + page index
 *   secure/<id>-p<n>.enc    encrypted full pages
 *   secure/<id>-t1.enc      encrypted thumbnail for page 1
 *
 * Cipher: AES-256-GCM. Key: PBKDF2-SHA256(password, salt, 310_000).
 * Layout of a page file:  iv(12) | ciphertext | tag(16)
 * Layout of index.enc  :  "TBL1" | salt(16) | iterations(4, BE) | iv(12) | ciphertext | tag(16)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, '.secure_staging');
const OUT = path.join(ROOT, 'secure');

const PASSWORD = process.argv[2] || process.env.SECURE_PASSWORD || 'c';
const ITERATIONS = 310000;
const MAGIC = Buffer.from('TBL1', 'ascii');

if (!fs.existsSync(path.join(STAGE, 'manifest.json'))) {
  console.error('No staging manifest — run: python scripts/build_secure.py');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(STAGE, 'manifest.json'), 'utf8'));
const salt = crypto.randomBytes(16);
const key = crypto.pbkdf2Sync(PASSWORD, salt, ITERATIONS, 32, 'sha256');

function encrypt(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let bytes = 0;
const items = [];

for (const item of manifest.items) {
  const pages = [];
  for (const [index, page] of item.pages.entries()) {
    // A content hash in the filename means a rebuilt bundle always gets new
    // URLs, so no browser can keep serving a stale copy from its cache.
    const fullBytes = fs.readFileSync(path.join(STAGE, page.full));
    const fullHash = crypto.createHash('sha256').update(fullBytes).digest('hex').slice(0, 8);
    const full = `secure/${item.id}-p${index + 1}-${fullHash}.enc`;
    const fullBuffer = encrypt(fullBytes);
    fs.writeFileSync(path.join(ROOT, full), fullBuffer);
    bytes += fullBuffer.length;

    const entry = { enc: full, w: page.w, h: page.h };
    if (page.thumb) {
      const thumbBytes = fs.readFileSync(path.join(STAGE, page.thumb));
      const thumbHash = crypto.createHash('sha256').update(thumbBytes).digest('hex').slice(0, 8);
      const thumb = `secure/${item.id}-t1-${thumbHash}.enc`;
      const thumbBuffer = encrypt(thumbBytes);
      fs.writeFileSync(path.join(ROOT, thumb), thumbBuffer);
      bytes += thumbBuffer.length;
      entry.thumb = thumb;
    }
    pages.push(entry);
  }

  const createdAt = new Date(Date.UTC(2026, 0, 1) - item.order * 60000).toISOString();
  items.push({
    id: item.id,
    type: item.type === 'piano' ? 'piano' : 'fingerstyle',
    title: item.title,
    artist: item.arranger || '',
    capo: '',
    tuning: '',
    tags: [],
    notes: '',
    pages,
    createdAt,
    updatedAt: createdAt,
    source: 'secure',
    secure: true,
  });
}

const doc = { version: 1, updatedAt: new Date().toISOString(), items };
const payload = Buffer.from(JSON.stringify(doc), 'utf8');

const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const body = Buffer.concat([cipher.update(payload), cipher.final()]);
const iterBuffer = Buffer.alloc(4);
iterBuffer.writeUInt32BE(ITERATIONS, 0);
const indexBuffer = Buffer.concat([MAGIC, salt, iterBuffer, iv, body, cipher.getAuthTag()]);
fs.writeFileSync(path.join(OUT, 'index.enc'), indexBuffer);
bytes += indexBuffer.length;

console.log(`encrypted ${items.length} fingerstyle tabs / ${items.reduce((n, i) => n + i.pages.length, 0)} pages`);
console.log(`password: ${PASSWORD} (${PASSWORD.length} chars) · iterations: ${ITERATIONS}`);
console.log(`wrote ${(bytes / 1024 / 1024).toFixed(2)} MB to secure/`);
