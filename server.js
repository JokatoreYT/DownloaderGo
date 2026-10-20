// GoAPI backend: gira SOLO su 127.0.0.1, nginx (vero) sta davanti e serve "/".
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = process.env.APP_PORT || 3000;

const KEY_TTL_MS = 10 * 60 * 1000;                 // le chiavi si resettano ogni 10 minuti
const STRICT_IP = process.env.STRICT_IP === '1';   // se 1, solo l'IP che ha creato la key può scaricare
const SAFE_NAME = /^[A-Za-z0-9._-]{1,150}$/;

// Dove cercare l'indice JSON (il primo che esiste vince)
const FILES_CANDIDATES = [
  process.env.FILES_JSON,
  '/etc/secrets/files.json',                       // Secret File di Render (link Drive fuori da GitHub)
  path.join(__dirname, 'files.json'),
].filter(Boolean);

app.disable('x-powered-by');
app.set('trust proxy', true);

// ---- chiavi per IP -----------------------------------------------------
const keysByIp = new Map(); // ip  -> { key, expiresAt }
const sessions = new Map(); // key -> { ip, expiresAt }

function getIp(req) {
  return req.headers['cf-connecting-ip'] || req.headers['true-client-ip'] || req.ip;
}

function generateKey() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let key;
  do {
    key = Array.from({ length: 16 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (sessions.has(key));
  return key;
}

function issueKey(ip) {
  const now = Date.now();
  const existing = keysByIp.get(ip);
  if (existing && existing.expiresAt > now) return existing;
  const entry = { key: generateKey(), expiresAt: now + KEY_TTL_MS };
  keysByIp.set(ip, entry);
  sessions.set(entry.key, { ip, expiresAt: entry.expiresAt });
  return entry;
}

function getSession(key) {
  const s = sessions.get(key);
  return s && s.expiresAt > Date.now() ? s : null;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of keysByIp) if (e.expiresAt <= now) keysByIp.delete(ip);
  for (const [k, s] of sessions) if (s.expiresAt <= now) sessions.delete(k);
}, 30 * 1000).unref();

// ---- indice JSON (riletto a ogni richiesta) ----------------------------
function extractDriveId(link) {
  try {
    const u = new URL(link);
    const hosts = ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'];
    if (!hosts.includes(u.hostname)) return null;
    const m = u.pathname.match(/\/file\/d\/([\w-]{10,})/);
    if (m) return m[1];
    const id = u.searchParams.get('id');
    if (id && /^[\w-]{10,}$/.test(id)) return id;
  } catch (_) {}
  return null;
}

function loadIndex() {
  for (const p of FILES_CANDIDATES) {
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') continue; console.error('[goapi] impossibile leggere', p, e.message); return new Map(); }
    try {
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : data.files;
      const map = new Map();
      for (const f of Array.isArray(list) ? list : []) {
        const id = f && extractDriveId(f.drive);
        if (id && typeof f.name === 'string' && SAFE_NAME.test(f.name)) map.set(f.name, id);
        else console.error('[goapi] voce ignorata (nome o link non validi):', f && f.name);
      }
      return map;
    } catch (e) {
      console.error('[goapi] JSON non valido in', p, e.message);
      return new Map();
    }
  }
  console.error('[goapi] nessun files.json trovato');
  return new Map();
}

// ---- API: crea/restituisce la key dell'IP ------------------------------
app.get('/api/get-key', (req, res) => {
  const { key, expiresAt } = issueKey(getIp(req));
  res.json({
    key,
    expires_at: new Date(expiresAt).toISOString(),
    expires_in: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
  });
});

// ---- /downs/{key}/{nome.ext}: proxy in streaming ------------------------
// Il link Drive non esce mai dal server: il client vede solo questo URL.
app.get('/downs/:key/:file', async (req, res) => {
  const s = getSession(req.params.key);
  const driveId = s && loadIndex().get(req.params.file);
  if (!driveId) return res.status(404).type('text/plain').send('Not Found');
  if (STRICT_IP && s.ip !== getIp(req)) return res.status(403).type('text/plain').send('Forbidden');

  const ac = new AbortController();
  res.on('close', () => ac.abort()); // se il client chiude, chiudi anche l'origine

  try {
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(
      `https://drive.usercontent.google.com/download?id=${encodeURIComponent(driveId)}&export=download&confirm=t`,
      { headers, redirect: 'follow', signal: ac.signal }
    );

    const ctype = upstream.headers.get('content-type') || '';
    if ((!upstream.ok && upstream.status !== 206) || ctype.includes('text/html')) {
      console.error('[goapi] origine non scaricabile:', req.params.file, upstream.status);
      return res.status(502).type('text/plain').send('Bad Gateway');
    }

    res.status(upstream.status);
    // si inoltrano solo header neutri: niente tracce di Google
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.file}"`);

    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (ac.signal.aborted) return;
    if (!res.headersSent) res.status(502).type('text/plain').send('Bad Gateway');
    else res.destroy();
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`GoAPI backend su 127.0.0.1:${PORT} - file in indice: ${loadIndex().size}`);
});
