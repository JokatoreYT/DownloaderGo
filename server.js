const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = process.env.PORT || 3000;

const KEY_TTL_MS = 10 * 60 * 1000;      // le chiavi si resettano ogni 10 minuti
const MAX_FILES_PER_KEY = 50;
const STRICT_IP = process.env.STRICT_IP === '1'; // se 1, solo l'IP proprietario può scaricare
const ALLOWED_EXT = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'iso', 'pdf', 'apk', 'exe', 'mp4', 'mkv', 'mp3', 'txt']);

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => { res.setHeader('Server', 'nginx'); next(); });

// ---- stato in memoria --------------------------------------------------
const keysByIp = new Map(); // ip  -> { key, expiresAt }
const sessions = new Map(); // key -> { ip, expiresAt, files: Map(fileName -> { driveId, driveUrl }) }

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
  sessions.set(entry.key, { ip, expiresAt: entry.expiresAt, files: new Map() });
  return entry;
}

function getSession(key) {
  const s = sessions.get(key);
  if (!s || s.expiresAt <= Date.now()) return null;
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of keysByIp) if (e.expiresAt <= now) keysByIp.delete(ip);
  for (const [k, s] of sessions) if (s.expiresAt <= now) sessions.delete(k);
}, 30 * 1000).unref();

// ---- helper Drive ------------------------------------------------------
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

// ---- pagina base: default nginx ----------------------------------------
const nginxPage = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const nginx404 = `<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n`;

app.get('/', (req, res) => res.type('html').send(nginxPage));

// ---- API ---------------------------------------------------------------
// Genera (o restituisce, se ancora valida) la key dell'IP chiamante
app.get('/api/get-key', (req, res) => {
  const { key, expiresAt } = issueKey(getIp(req));
  res.json({ key, expires_at: new Date(expiresAt).toISOString(), expires_in: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) });
});

function auth(req, res, next) {
  const key = req.get('x-api-key') || req.query.key;
  const s = key && getSession(String(key));
  if (!s) return res.status(401).json({ error: 'API key mancante, non valida o scaduta. Chiama /api/get-key' });
  if (s.ip !== getIp(req)) return res.status(403).json({ error: 'Questa key appartiene a un altro IP' });
  req.apiKey = String(key);
  req.session = s;
  next();
}

// Aggiunge un file all'indice: { "url": "<link drive pubblico>", "name": "nome.zip" }
app.post('/api/index', auth, (req, res) => {
  const { url, name } = req.body || {};
  const driveId = extractDriveId(url);
  if (!driveId) return res.status(400).json({ error: 'Link Google Drive non valido' });
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,100}\.[A-Za-z0-9]{1,5}$/.test(name))
    return res.status(400).json({ error: 'Nome non valido (es. "mio-file.zip")' });
  const ext = name.split('.').pop().toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return res.status(400).json({ error: `Estensione non permessa: .${ext}` });
  if (req.session.files.size >= MAX_FILES_PER_KEY && !req.session.files.has(name))
    return res.status(400).json({ error: 'Limite file per key raggiunto' });

  req.session.files.set(name, { driveId, driveUrl: url });
  res.status(201).json({ drive: url, path: `/downs/${req.apiKey}/${name}` });
});

// Indice JSON della key
app.get('/api/index', auth, (req, res) => {
  res.json({
    key: req.apiKey,
    expires_at: new Date(req.session.expiresAt).toISOString(),
    index: [...req.session.files].map(([name, f]) => ({ drive: f.driveUrl, path: `/downs/${req.apiKey}/${name}` })),
  });
});

// ---- proxy download (streaming, nessun file su disco) -------------------
app.get('/downs/:key/:file', async (req, res) => {
  const s = getSession(req.params.key);
  const file = s && s.files.get(req.params.file);
  if (!file) return res.status(404).type('html').send(nginx404);
  if (STRICT_IP && s.ip !== getIp(req)) return res.status(403).json({ error: 'IP non autorizzato' });

  const ac = new AbortController();
  res.on('close', () => ac.abort()); // se il client chiude, chiudi anche Google

  try {
    const headers = { 'User-Agent': 'Mozilla/5.0 (GoAPI)' };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(
      `https://drive.usercontent.google.com/download?id=${encodeURIComponent(file.driveId)}&export=download&confirm=t`,
      { headers, redirect: 'follow', signal: ac.signal }
    );

    const ctype = upstream.headers.get('content-type') || '';
    if (!upstream.ok && upstream.status !== 206) return res.status(502).json({ error: `Drive ha risposto ${upstream.status}` });
    if (ctype.includes('text/html')) {
      return res.status(502).json({ error: 'File non pubblico, quota Drive superata o link non scaricabile' });
    }

    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.file}"`);

    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (ac.signal.aborted) return;
    if (!res.headersSent) res.status(502).json({ error: 'Errore nel proxy verso Drive' });
    else res.destroy();
  }
});

app.use((req, res) => res.status(404).type('html').send(nginx404));

app.listen(PORT, () => console.log(`GoAPI in ascolto sulla porta ${PORT}`));
