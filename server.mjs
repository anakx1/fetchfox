#!/usr/bin/env node
/**
 * Fetchfox — a download manager for Termux, in the spirit of 1DM/FDM.
 *
 *   aria2c   -> download engine (segmented, resumable, torrents)
 *   yt-dlp   -> media sites (YouTube, Instagram, HLS, etc.)
 *   node     -> local web UI + PWA, JSON-RPC bridge
 *
 * Run:  node server.mjs      then open http://127.0.0.1:8080
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  fmtBytes, isMedia, safeName, parseRange, guardRequest, parseYtProgress,
} from './lib/core.mjs';

const BASE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const ENV_DIR = process.env.FETCHFOX_DIR ? path.resolve(process.env.FETCHFOX_DIR) : null;
const DEFAULT_DL = ENV_DIR || path.join(HOME, 'storage/shared/Downloads/Fetchfox');
// effective directory; replaced with aria2's `dir` once the engine is up
let DL = DEFAULT_DL;
const PUBLIC = path.join(BASE, 'public');
const SESSION = path.join(BASE, 'fetchfox.session');
const CONF = path.join(BASE, 'fetchfox.conf');
const PORT = Number(process.env.PORT || 8080);
const RPC_PORT = Number(process.env.RPC_PORT || 6800);
const SECRET_FILE = path.join(BASE, 'fetchfox.secret');

/**
 * RPC secret: env override, else the persisted 32-byte hex token, else a
 * freshly generated one. Stored 0600 so other apps cannot read it.
 */
function loadSecret() {
  if (process.env.ARIA2_SECRET) return process.env.ARIA2_SECRET;
  try {
    const saved = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (/^[0-9a-f]{32,}$/i.test(saved)) return saved;
  } catch {}
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret + '\n', { mode: 0o600 });
  try { fs.chmodSync(SECRET_FILE, 0o600); } catch {}
  console.log('[fetchfox] generated a new RPC secret in', path.basename(SECRET_FILE));
  return secret;
}

const SECRET = loadSecret();
const RPC_URL = `http://127.0.0.1:${RPC_PORT}/jsonrpc`;

/* ------------------------------------------------------------------ engine */

const CONF_BODY = `# Fetchfox download engine (aria2) — edit freely, restart to apply
dir=${DEFAULT_DL}
enable-rpc=true
rpc-listen-all=false
rpc-listen-port=${RPC_PORT}
rpc-secret=${SECRET}

max-concurrent-downloads=3
max-connection-per-server=16
split=16
min-split-size=1M
continue=true
auto-file-renaming=true
allow-overwrite=false
max-tries=5
retry-wait=2
max-overall-download-limit=0
max-overall-upload-limit=0

user-agent=Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36

save-session=${SESSION}
save-session-interval=30
input-file=${SESSION}
auto-save-interval=30

# /sdcard is FUSE — fallocate is unsupported there
file-allocation=none
disk-cache=16M

follow-torrent=true
enable-dht=true
bt-max-peers=60
seed-time=0
listen-port=6881-6999
dht-listen-port=6881-6999

summary-interval=0
console-log-level=warn
log-level=warn
`;

let aria2Proc = null;

function ensureConf() {
  fs.mkdirSync(DEFAULT_DL, { recursive: true });

  if (!fs.existsSync(CONF)) {
    fs.writeFileSync(CONF, CONF_BODY);
  } else {
    // migrate configs written by older installs: no CORS, current secret
    const before = fs.readFileSync(CONF, 'utf8');
    let body = before;
    body = body.replace(/^rpc-allow-origin-all=.*(?:\r?\n)?/gm, '');
    if (ENV_DIR) {
      body = /^dir=.*$/m.test(body)
        ? body.replace(/^dir=.*$/m, `dir=${ENV_DIR}`)
        : body + `\ndir=${ENV_DIR}\n`;
    }
    if (/^rpc-secret=.*$/m.test(body)) {
      body = body.replace(/^rpc-secret=.*$/m, `rpc-secret=${SECRET}`);
    } else {
      body += `\nrpc-secret=${SECRET}\n`;
    }
    if (body !== before) {
      fs.writeFileSync(CONF, body);
      console.log('[fetchfox] updated fetchfox.conf (dropped CORS, refreshed secret)');
    }
  }

  if (!fs.existsSync(SESSION)) fs.writeFileSync(SESSION, '');
}

async function rpc(method, params = [], timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: String(Date.now()),
        method,
        params: [`token:${SECRET}`, ...params],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'rpc error');
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

async function engineUp() {
  try {
    await rpc('aria2.getVersion', [], 800);
    return true;
  } catch {
    return false;
  }
}

async function startEngine() {
  ensureConf();

  if (await engineUp()) {
    console.log('[fetchfox] reusing already-running aria2');
    return;
  }

  aria2Proc = spawn(
    'aria2c',
    ['--conf-path', CONF, `--stop-with-process=${process.pid}`],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  aria2Proc.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) console.log('[aria2]', s);
  });
  aria2Proc.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log('[fetchfox] aria2 exited', code);
    aria2Proc = null;
  });

  for (let i = 0; i < 40; i++) {
    if (await engineUp()) {
      console.log('[fetchfox] aria2 engine ready');
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('aria2 failed to start — is it installed? (pkg install aria2)');
}

/* ------------------------------------------------------------- yt-dlp jobs */

const ytJobs = new Map();
let ytSeq = 0;
const MAX_YT_CONCURRENT = Number(process.env.MAX_YT_CONCURRENT || 2);
const YT_STATE = path.join(BASE, 'fetchfox.ytjobs.json');
let ytSaveTimer = null;

/** Write job metadata now (used on exit and after debounce). */
function flushYtState() {
  if (ytSaveTimer) {
    clearTimeout(ytSaveTimer);
    ytSaveTimer = null;
  }
  const data = [...ytJobs.values()].map((j) => ({
    id: j.id,
    url: j.url,
    opts: j.opts,
    status: j.status,
    path: j.path,
    name: j.name,
  }));
  try {
    fs.writeFileSync(YT_STATE, JSON.stringify(data, null, 2));
  } catch {}
}

function saveYtState() {
  if (ytSaveTimer) return;
  ytSaveTimer = setTimeout(flushYtState, 400);
}

/** Restore metadata; anything that was running is marked interrupted. */
function loadYtState() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(YT_STATE, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(data)) return;

  for (const r of data) {
    if (!r || typeof r.id !== 'string' || typeof r.url !== 'string') continue;
    const m = /^yt(\d+)-/.exec(r.id);
    if (m) ytSeq = Math.max(ytSeq, Number(m[1]));

    const job = {
      id: r.id,
      kind: 'ytdlp',
      name: typeof r.name === 'string' && r.name ? r.name : r.url,
      url: r.url,
      opts: { playlist: !!r.opts?.playlist, format: r.opts?.format || '' },
      size: 0,
      done: 0,
      speed: 0,
      up: 0,
      conns: 0,
      status: 'error',
      error: 'interrupted by restart — retry to resume',
      path: typeof r.path === 'string' ? r.path : '',
      eta: '',
      percent: 0,
      started: Date.now(),
      proc: null,
      cancelled: false,
    };

    if (r.status === 'complete') {
      job.status = 'complete';
      job.percent = 100;
      job.error = null;
    } else if (r.status === 'waiting') {
      job.status = 'waiting';
      job.error = null;
    } else if (r.status === 'paused') {
      job.status = 'paused';
      job.error = null;
    } else if (r.status === 'cancelled') {
      job.status = 'cancelled';
      job.error = null;
    }
    ytJobs.set(job.id, job);
  }
}

function createYtJob(url, opts = {}) {
  const id = `yt${++ytSeq}-${Date.now().toString(36)}`;
  const job = {
    id,
    kind: 'ytdlp',
    name: url,
    url,
    opts: { playlist: !!opts.playlist, format: opts.format || '' },
    size: 0,
    done: 0,
    speed: 0,
    up: 0,
    conns: 0,
    status: 'waiting',
    error: null,
    path: '',
    eta: '',
    percent: 0,
    started: Date.now(),
    proc: null,
    cancelled: false,
  };
  ytJobs.set(id, job);
  saveYtState();
  pumpYtQueue();
  return job;
}

/** Start queued yt-dlp jobs while there are free slots. */
function pumpYtQueue() {
  const running = [...ytJobs.values()]
    .filter((j) => j.status === 'active' || j.status === 'processing').length;
  let slots = MAX_YT_CONCURRENT - running;
  if (slots <= 0) return;

  for (const job of ytJobs.values()) {
    if (slots <= 0) break;
    if (job.status === 'waiting' && !job.proc) {
      launchYtProc(job);
      slots--;
    }
  }
}

function launchYtProc(job) {
  const args = [
    '--newline',
    '--no-colors',
    '--progress',
    '--no-warnings',
    '-o', path.join(DL, '%(title).150B [%(id)s].%(ext)s'),
    '--continue',
    '--retries', '5',
    '--fragment-retries', '10',
  ];
  if (!job.opts.playlist) args.push('--no-playlist');
  if (job.opts.format) args.push('-f', job.opts.format);
  if (limits.down > 0) args.push('--limit-rate', `${Math.round(limits.down)}B`);
  args.push('--', job.url);

  job.status = 'active';
  job.error = null;
  job.cancelled = false;
  saveYtState();

  let proc;
  try {
    proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    job.status = 'error';
    job.error = String(e.message || e);
    pumpYtQueue();
    return;
  }
  job.proc = proc;

  const handle = (chunk) => {
    const text = String(chunk);
    for (const line of text.split(/\r?\n|\r/)) {
      const ev = parseYtProgress(line);
      if (!ev) continue;
      if (ev.kind === 'destination') {
        job.path = ev.path;
        job.name = path.basename(ev.path);
      } else if (ev.kind === 'progress') {
        job.percent = ev.percent;
        if (ev.size > 0) job.size = ev.size;
        job.done = Math.round((job.percent / 100) * job.size);
        job.speed = ev.speed;
        job.eta = ev.eta;
        if (job.percent >= 100) {
          job.done = job.size;
          job.speed = 0;
        }
      } else if (ev.kind === 'complete') {
        job.percent = 100;
        job.done = job.size;
      } else if (ev.kind === 'error') {
        job.error = ev.message;
      } else if (ev.kind === 'processing') {
        job.status = 'processing';
      }
    }
  };
  proc.stdout.on('data', handle);
  proc.stderr.on('data', handle);

  proc.on('error', (e) => {
    job.status = 'error';
    job.error = e.code === 'ENOENT' ? 'yt-dlp not installed (pkg install yt-dlp)' : String(e.message || e);
    job.proc = null;
    saveYtState();
    pumpYtQueue();
  });

  proc.on('close', (code) => {
    job.proc = null;
    job.speed = 0;
    if (job.cancelled) {
      job.status = 'cancelled';
    } else if (code === 0) {
      job.status = 'complete';
      job.percent = 100;
      job.done = job.size || job.done;
    } else {
      job.status = 'error';
      if (!job.error) job.error = `yt-dlp exited with code ${code}`;
    }
    saveYtState();
    pumpYtQueue();
  });
}

/* ------------------------------------------------------------- side effects */

const notified = new Set();
let primed = false;


function notify(title, content) {
  execFile('termux-notification', [
    '--id', String(2000 + (Math.abs(hash(title + content)) % 500)),
    '--title', title,
    '--content', content,
    '--priority', 'default',
    '--vibrate', '150',
  ], () => {});
}

function mediaScan(p) {
  if (!p || !isInsideDir(p, DL)) return;
  execFile('termux-media-scan', ['-v', path.resolve(p)], () => {});
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Runs whether or not a browser is open, so notifications and media scanning
 * happen even when the UI is closed. Jobs already finished at startup are
 * swallowed by the `primed` pass.
 */
async function processCompletions() {
  const done = [];

  try {
    if (await engineUp()) {
      const stopped = await rpc('aria2.tellStopped',
        [0, 200, ['gid', 'status', 'totalLength', 'files', 'bittorrent']], 5000);
      for (const j of stopped) {
        if (j.status !== 'complete') continue;
        const f = (j.files && j.files[0]) || {};
        done.push({
          id: j.gid,
          name: j.bittorrent?.info?.name ||
            (f.path ? path.basename(decodeURIComponent(f.path)) : 'unknown'),
          size: Number(j.totalLength || 0),
          path: f.path ? decodeURIComponent(f.path) : '',
        });
      }
    }
  } catch {}

  for (const j of ytJobs.values()) {
    if (j.status === 'complete') {
      done.push({ id: j.id, name: j.name, size: j.size, path: j.path });
    }
  }

  if (!primed) {
    for (const d of done) notified.add(d.id);
    primed = true;
    return;
  }

  for (const d of done) {
    if (notified.has(d.id)) continue;
    notified.add(d.id);
    notify('Download finished', `${d.name}\n${fmtBytes(d.size)}`);
    mediaScan(d.path);
  }
}

/* ------------------------------------------------------------------- state */

const KEYS = [
  'gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'uploadSpeed',
  'connections', 'numSeeders', 'errorMessage', 'files', 'bittorrent', 'dir', 'followedBy',
];

function ariaJob(j) {
  const f = (j.files && j.files[0]) || {};
  const name =
    j.bittorrent?.info?.name ||
    (f.path ? path.basename(decodeURIComponent(f.path)) : '') ||
    (f.uris && f.uris[0] ? f.uris[0].uri : '') ||
    'unknown';
  const st = j.status === 'active' ? 'active'
    : j.status === 'waiting' ? 'waiting'
    : j.status === 'paused' ? 'paused'
    : j.status === 'error' ? 'error'
    : j.status === 'removed' ? 'cancelled'
    : 'complete';
  return {
    id: j.gid,
    kind: 'aria2',
    name,
    url: f.uri || (f.uris && f.uris[0] ? f.uris[0].uri : ''),
    size: Number(j.totalLength || 0),
    done: Number(j.completedLength || 0),
    speed: Number(j.downloadSpeed || 0),
    up: Number(j.uploadSpeed || 0),
    conns: Number(j.connections || 0),
    seeders: Number(j.numSeeders || 0),
    status: st,
    error: j.errorMessage || null,
    path: f.path ? decodeURIComponent(f.path) : '',
    eta: '',
  };
}

function ytJobView(j) {
  return {
    id: j.id, kind: 'ytdlp', name: j.name, url: j.url, size: j.size, done: j.done,
    speed: j.speed, up: 0, conns: 0, status: j.status, error: j.error, path: j.path, eta: j.eta,
  };
}

const ORDER = { active: 0, processing: 0, waiting: 1, paused: 2, error: 3, cancelled: 4, complete: 5 };

let limits = { down: 0, up: 0 };

async function buildState() {
  let global = { down: 0, up: 0, active: 0, waiting: 0, stopped: 0 };
  let jobs = [];

  const alive = await engineUp();
  if (alive) {
    const [g, active, waiting, stopped] = await Promise.all([
      rpc('aria2.getGlobalStat'),
      rpc('aria2.tellActive', [KEYS]),
      rpc('aria2.tellWaiting', [0, 200, KEYS]),
      rpc('aria2.tellStopped', [0, 200, KEYS]),
    ]);
    global = {
      down: Number(g.downloadSpeed || 0),
      up: Number(g.uploadSpeed || 0),
      active: Number(g.numActive || 0),
      waiting: Number(g.numWaiting || 0),
      stopped: Number(g.numStopped || 0),
    };
    jobs = [...active, ...waiting, ...stopped].map(ariaJob);
  }

  for (const j of ytJobs.values()) jobs.push(ytJobView(j));
  jobs.sort((a, b) => (ORDER[a.status] ?? 6) - (ORDER[b.status] ?? 6));

  return {
    ok: alive,
    engine: alive ? 'up' : 'down',
    dir: DL,
    global: { ...global, limitDown: limits.down, limitUp: limits.up },
    jobs,
    ts: Date.now(),
  };
}

/* ------------------------------------------------------------------ helpers */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
};



function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(b);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req) {
  let b = '';
  for await (const c of req) {
    b += c;
    if (b.length > 1e6) throw new HttpError(413, 'body too large');
  }
  if (!b) return {};
  try {
    return JSON.parse(b);
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

/**
 * True when `p` lives inside `dir`. Symlinks are resolved on both sides so
 * Termux paths and real /storage paths compare correctly.
 */
function isInsideDir(p, dir) {
  try {
    const realDir = fs.realpathSync(dir);
    const realParent = fs.realpathSync(path.dirname(p));
    const abs = path.join(realParent, path.basename(p));
    return abs === realDir || abs.startsWith(realDir + path.sep);
  } catch {
    return false;
  }
}

/** Recursively total the size of a directory (multi-file torrents). */
async function dirSize(dir) {
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += await dirSize(fp);
    } else {
      const st = await fsp.stat(fp).catch(() => null);
      if (st) total += st.size;
    }
  }
  return total;
}



/* ------------------------------------------------------------------ actions */

async function addJob(url, opts = {}) {
  const clean = String(url).trim();
  if (!/^(https?|ftp|magnet):/i.test(clean)) return { ok: false, error: 'unsupported URL', url: clean };

  const useYtdlp = clean.startsWith('magnet:')
    ? false
    : opts.forceYtdlp
      ? true
      : opts.forceAria2
        ? false
        : isMedia(clean);

  if (useYtdlp) {
    const j = createYtJob(clean, opts);
    return { ok: true, id: j.id, kind: 'ytdlp', url: clean };
  }

  try {
    const gid = await rpc('aria2.addUri', [[clean]]);
    return { ok: true, id: gid, kind: 'aria2', url: clean };
  } catch (e) {
    return { ok: false, error: String(e.message || e), url: clean };
  }
}

function ytAction(job, action) {
  if (action === 'cancel') {
    job.cancelled = true;
    job.speed = 0;
    if (job.proc) {
      try { job.proc.kill('SIGCONT'); } catch {}
      try { job.proc.kill('SIGTERM'); } catch {}
    }
    if (job.status !== 'complete') job.status = 'cancelled';
  } else if (action === 'pause') {
    if (job.proc) { try { job.proc.kill('SIGSTOP'); } catch {} }
    if (job.status === 'waiting' || job.status === 'active' || job.status === 'processing') {
      job.status = 'paused';
      job.speed = 0;
    }
  } else if (action === 'resume') {
    if (job.proc) {
      try { job.proc.kill('SIGCONT'); } catch {}
      job.status = 'active';
    } else if (job.status === 'paused') {
      job.status = 'waiting';
    }
  } else if (action === 'remove') {
    ytJobs.delete(job.id);
  } else if (action === 'retry') {
    // drop the failed entry and re-queue it with the stored url/opts
    const fresh = createYtJob(job.url, job.opts || {});
    ytJobs.delete(job.id);
    saveYtState();
    return { ok: true, id: fresh.id, kind: 'ytdlp' };
  }
  saveYtState();
  pumpYtQueue();
  return { ok: true };
}

async function jobAction(id, action) {
  const yt = ytJobs.get(id);
  if (yt) return ytAction(yt, action);

  try {
    if (action === 'pause') await rpc('aria2.pause', [id]);
    else if (action === 'resume') await rpc('aria2.unpause', [id]);
    else if (action === 'cancel') await rpc('aria2.remove', [id]);
    else if (action === 'remove') await rpc('aria2.removeDownloadResult', [id]);
    else if (action === 'retry') {
      // tellStatus resolves to an object; source URLs live on files[].uris[]
      const st = await rpc('aria2.tellStatus', [id, ['files', 'bittorrent', 'status']]);
      const uri = (st?.files || []).map((f) => f.uris?.[0]?.uri).find(Boolean);
      if (!uri) {
        return { ok: false, error: 'no retryable URL for this job (magnet/torrent) — add it again' };
      }
      await rpc('aria2.removeDownloadResult', [id]).catch(() => {});
      return addJob(uri, { forceAria2: true });
    } else return { ok: false, error: 'unknown action' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/* -------------------------------------------------------------------- server */

const sse = new Set();
const JOB_ACTIONS = new Set(['pause', 'resume', 'cancel', 'remove', 'retry']);



async function route(req, res) {
  const denied = guardRequest({
    method: req.method,
    host: req.headers.host,
    origin: req.headers.origin,
    contentType: req.headers['content-type'],
  }, PORT);
  if (denied) return json(res, 403, { error: denied });

  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(u.pathname);

  // ---- static shell
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return sendFile(res, path.join(PUBLIC, 'index.html'));
  }
  if (req.method === 'GET' && /^\/(app\.js|style\.css|sw\.js|manifest\.webmanifest|icon-\d+\.png|favicon\.svg)$/.test(p)) {
    return sendFile(res, path.join(PUBLIC, p.slice(1)));
  }

  // ---- media file streaming (range-aware)
  if (req.method === 'GET' && p.startsWith('/f/')) {
    const fp = safeName(p.slice(3), DL);
    if (!fp) return json(res, 400, { error: 'bad name' });
    return streamFile(req, res, fp);
  }

  // ---- api
  if (p === '/api/state' && req.method === 'GET') {
    return json(res, 200, await buildState());
  }

  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    sse.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ping); sse.delete(res); });
    return;
  }

  if (p === '/api/add' && req.method === 'POST') {
    const { urls, forceYtdlp, playlist, format } = await readBody(req);
    const list = (Array.isArray(urls) ? urls : String(urls || '').split(/\s+/))
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (!list.length) return json(res, 400, { error: 'no urls' });
    const results = [];
    for (const url of list) {
      results.push(await addJob(url, { playlist: !!playlist, format, forceYtdlp: !!forceYtdlp }));
    }
    return json(res, 200, { results });
  }

  if (p === '/api/job' && req.method === 'POST') {
    const { id, action } = await readBody(req);
    if (!id || typeof action !== 'string' || !JOB_ACTIONS.has(action)) {
      return json(res, 400, { error: 'id and a valid action are required' });
    }
    return json(res, 200, await jobAction(String(id), action));
  }

  if (p === '/api/limit' && req.method === 'POST') {
    const { down, up } = await readBody(req);
    for (const value of [down, up]) {
      if (value === undefined || value === null) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return json(res, 400, { error: 'limit must be a finite non-negative number' });
      }
    }
    try {
      const num = (v) => (Number(v) > 0 ? String(Math.round(Number(v))) : '0');
      if (down !== undefined && down !== null) {
        await rpc('aria2.changeGlobalOption', [{ 'max-overall-download-limit': num(down) }]);
        limits.down = Number(down) > 0 ? Number(down) : 0;
      }
      if (up !== undefined && up !== null) {
        await rpc('aria2.changeGlobalOption', [{ 'max-overall-upload-limit': num(up) }]);
        limits.up = Number(up) > 0 ? Number(up) : 0;
      }
      return json(res, 200, { ok: true, limits });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (p === '/api/clipboard' && req.method === 'POST') {
    return new Promise((resolve) => {
      execFile('termux-clipboard-get', { timeout: 4000 }, (err, stdout) => {
        json(res, 200, { ok: !err, text: String(stdout || '').trim() });
        resolve();
      });
    });
  }

  if (p === '/api/files' && req.method === 'GET') {
    try {
      const entries = await fsp.readdir(DL, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        const n = e.name;
        if (n.endsWith('.aria2') || n.endsWith('.part')) continue;
        const full = path.join(DL, n);
        const st = await fsp.stat(full).catch(() => null);
        if (!st) continue;
        if (st.isDirectory()) {
          out.push({ name: n, size: await dirSize(full), mtime: st.mtimeMs, dir: true });
        } else if (st.isFile()) {
          out.push({ name: n, size: st.size, mtime: st.mtimeMs, dir: false });
        }
      }
      out.sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, { dir: DL, files: out });
    } catch (e) {
      return json(res, 200, { dir: DL, files: [], error: String(e.message || e) });
    }
  }

  if (p === '/api/file' && (req.method === 'DELETE' || req.method === 'POST')) {
    const name = u.searchParams.get('name') || (await readBody(req).catch(() => ({}))).name;
    const fp = safeName(name, DL);
    if (!fp) return json(res, 400, { error: 'bad name' });
    // safeName() already forces a direct child; assert it for directories
    if (path.dirname(fp) !== path.resolve(DL)) return json(res, 403, { error: 'outside download dir' });
    try {
      const st = await fsp.stat(fp).catch(() => null);
      if (st && st.isDirectory()) {
        await fsp.rm(fp, { recursive: true, force: true });
      } else {
        await fsp.unlink(fp);
      }
      await fsp.unlink(fp + '.aria2').catch(() => {});
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (p === '/api/open' && req.method === 'POST') {
    // only a bare filename is accepted; any `target` field is ignored
    const { name } = await readBody(req);
    const fp = safeName(name, DL);
    if (!fp) return json(res, 400, { error: 'bad name' });
    try {
      await fsp.access(fp, fs.constants.R_OK);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
    execFile('termux-open', [fp], () => {});
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
}

function sendFile(res, fp) {
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(fp)] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(fp).pipe(res);
  });
}



function streamFile(req, res, fp) {
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const parsed = parseRange(range, st.size);
      if (parsed === 'invalid') {
        res.writeHead(416, {
          'content-range': `bytes */${st.size}`,
          'accept-ranges': 'bytes',
        });
        return res.end();
      }
      if (parsed) {
        res.writeHead(206, {
          'content-type': type,
          'content-length': parsed.end - parsed.start + 1,
          'content-range': `bytes ${parsed.start}-${parsed.end}/${st.size}`,
          'accept-ranges': 'bytes',
        });
        return fs.createReadStream(fp, parsed).pipe(res);
      }
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': st.size,
      'accept-ranges': 'bytes',
      'content-disposition': `inline; filename="${encodeURIComponent(path.basename(fp))}"`,
    });
    fs.createReadStream(fp).pipe(res);
  });
}

/* --------------------------------------------------------------------- boot */

async function main() {
  fs.mkdirSync(DL, { recursive: true });
  await startEngine();

  try {
    const opt = await rpc('aria2.getGlobalOption', [], 4000);
    if (opt.dir) {
      try { DL = path.resolve(decodeURIComponent(opt.dir)); } catch { DL = path.resolve(opt.dir); }
    }
    limits.down = Number(opt['max-overall-download-limit'] || 0);
    limits.up = Number(opt['max-overall-upload-limit'] || 0);
  } catch {}
  fs.mkdirSync(DL, { recursive: true });
  console.log(`[fetchfox] download dir ${DL}`);

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[fetchfox]', e);
      try {
        json(res, status, { error: status === 500 ? String(e.message || e) : e.message });
      } catch {}
    });
  });

  setInterval(() => {
    processCompletions().catch(() => {});
  }, 2000);

  setInterval(async () => {
    if (!sse.size) return;
    try {
      const payload = `data: ${JSON.stringify(await buildState())}\n\n`;
      for (const c of sse) c.write(payload);
    } catch {}
  }, 1000);

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[fetchfox] UI ready -> http://127.0.0.1:${PORT}`);
    console.log(`[fetchfox] saving to ${DL}`);
  });

  loadYtState();
  pumpYtQueue();

  const shutdown = () => {
    flushYtState();
    try { aria2Proc?.kill('SIGTERM'); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[fetchfox] fatal:', e.message || e);
  process.exit(1);
});
