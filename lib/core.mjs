/**
 * Pure helpers shared by server.mjs and the test suite.
 *
 * Nothing in here does I/O, reads globals, or depends on server state, so it
 * can be imported by tests without starting aria2 or opening a port.
 */
import path from 'node:path';

/* ------------------------------------------------------------------ format */

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/* ------------------------------------------------------------------- media */

const MEDIA_HOSTS = [
  'youtube.com', 'youtu.be', 'music.youtube.com', 'instagram.com', 'tiktok.com',
  'twitter.com', 'x.com', 'facebook.com', 'fb.watch', 'vimeo.com', 'reddit.com',
  'redd.it', 'soundcloud.com', 'twitch.tv', 'dailymotion.com', 'bilibili.com',
  'pinterest.com', 'snapchat.com', 'threads.net', 'rumble.com', 'odysee.com',
];

export function isMedia(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (MEDIA_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;
    if (/\.(m3u8|mpd|ism)(\?|$)/i.test(u.pathname)) return true;
  } catch {}
  return false;
}

/* ------------------------------------------------------------------- paths */

/**
 * Resolve a bare filename inside `dir`. Anything containing a separator, a
 * null byte, or a dot-only segment is rejected so the result is always a
 * direct child of `dir`.
 */
export function safeName(name, dir) {
  const raw = String(name ?? '');
  if (!raw || raw.includes('\0') || raw.includes('/') || raw.includes('\\')) return null;
  if (raw === '.' || raw === '..') return null;

  const root = path.resolve(dir);
  const resolved = path.join(root, raw);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/* ------------------------------------------------------------------ ranges */

/**
 * Parse a single-range `bytes=` header.
 * Returns { start, end }, null when absent/unsupported, or 'invalid' when the
 * range cannot be satisfied (caller replies 416).
 */
export function parseRange(header, size) {
  if (header == null || header === '') return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
  if (!m) return 'invalid';

  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  if (rawStart === '') {
    // suffix form: bytes=-500 -> last 500 bytes
    const suffix = parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = parseInt(rawStart, 10);
  const end = rawEnd === '' ? size - 1 : parseInt(rawEnd, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

/* ------------------------------------------------------------------- guard */

/**
 * Localhost-only request guard. Returns an error string when the request must
 * be refused, or null when it may proceed.
 */
export function guardRequest({ method, host, origin, contentType }, port) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(String(host || '').toLowerCase())) return 'unexpected Host header';

  if (method === 'POST' || method === 'DELETE') {
    if (origin != null && origin !== '') {
      const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
      if (!allowedOrigins.has(String(origin).toLowerCase())) return 'unexpected Origin header';
    }
  }

  if (method === 'POST') {
    const ct = String(contentType || '').toLowerCase();
    if (!ct.startsWith('application/json')) return 'Content-Type must be application/json';
  }
  return null;
}

/* ----------------------------------------------------------------- yt-dlp */

const MULT = {
  B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3,
  KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3,
};

function bytes(value, unit) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * (MULT[String(unit || 'B').toUpperCase()] || 1));
}

/**
 * Classify one line of yt-dlp output.
 *
 * Returns null for lines we do not care about, otherwise one of:
 *   { kind: 'destination', path }
 *   { kind: 'progress', percent, size, speed, eta }
 *   { kind: 'complete' }        (file was already downloaded)
 *   { kind: 'processing' }      (download finished, post-processing)
 *   { kind: 'error', message }
 */
export function parseYtProgress(line) {
  const l = String(line ?? '').trim();
  if (!l) return null;
  let m;

  if ((m = l.match(/^\[download\]\s+Destination:\s+(.+)$/)) ||
      (m = l.match(/^\[Merger\]\s+Merging formats into "(.+)"$/))) {
    return { kind: 'destination', path: m[1].trim().replace(/^"|"$/g, '') };
  }

  if ((m = l.match(/^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)\s*([KMGT]?i?B)\s+at\s+([\d.]+|Unknown)\s*([KMGT]?i?B)?\/s(?:\s+ETA\s+(\S+))?/i))) {
    return {
      kind: 'progress',
      percent: parseFloat(m[1]),
      size: bytes(m[2], m[3]),
      speed: /unknown/i.test(m[4]) ? 0 : bytes(m[4], m[5] || m[3]),
      eta: m[6] && m[6] !== 'Unknown' ? m[6] : '',
    };
  }

  if ((m = l.match(/^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)\s*([KMGT]?i?B)/i))) {
    return { kind: 'progress', percent: parseFloat(m[1]), size: bytes(m[2], m[3]), speed: 0, eta: '' };
  }

  if (l.includes('has already been downloaded')) return { kind: 'complete' };
  if (/ERROR:/.test(l)) return { kind: 'error', message: l.replace(/^.*ERROR:\s*/, '') };
  if (/^\[download\]\s+100%/.test(l)) return { kind: 'processing' };

  return null;
}
