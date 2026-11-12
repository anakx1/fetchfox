import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtBytes, isMedia, safeName, parseRange, guardRequest, parseYtProgress, shortError,
  safeDecode, isMetadataOnlyJob, magnetName, ytStartableIds, ytRestartIds,
} from '../lib/core.mjs';

const DL = '/data/data/com.termux/files/home/storage/shared/Downloads/Fetchfox';
const PORT = 8080;

/* ------------------------------------------------------------------ format */

test('fmtBytes formats byte counts', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(undefined), '0 B');
  assert.equal(fmtBytes(1023), '1023 B');
  assert.equal(fmtBytes(1024), '1.0 KB');
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(100 * 1024), '100 KB');
  assert.equal(fmtBytes(1024 ** 2), '1.0 MB');
  assert.equal(fmtBytes(1024 ** 3), '1.0 GB');
  assert.equal(fmtBytes(1024 ** 4), '1.0 TB');
});

test('shortError flattens and clips failure messages', () => {
  assert.equal(shortError('  boom\n\n  gone '), 'boom gone');
  assert.equal(shortError(''), 'download failed');
  assert.equal(shortError(null), 'download failed');
  const long = shortError('x'.repeat(300), 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('…'));
});

/* ------------------------------------------------------------------- media */

test('isMedia recognises media hosts', () => {
  assert.equal(isMedia('https://www.youtube.com/watch?v=abc'), true);
  assert.equal(isMedia('https://youtu.be/abc'), true);
  assert.equal(isMedia('https://m.youtube.com/watch?v=abc'), true);
  assert.equal(isMedia('https://instagram.com/p/xyz'), true);
  assert.equal(isMedia('https://vm.tiktok.com/xyz'), true);
});

test('isMedia recognises streaming manifests', () => {
  assert.equal(isMedia('https://example.com/live/stream.m3u8'), true);
  assert.equal(isMedia('https://example.com/vod/movie.mpd?token=1'), true);
});

test('isMedia leaves plain files alone', () => {
  assert.equal(isMedia('https://example.com/file.zip'), false);
  assert.equal(isMedia('https://example.com/photo.jpg'), false);
  assert.equal(isMedia('https://notyoutube.com/watch?v=1'), false);
  assert.equal(isMedia('https://evil-youtube.com/watch?v=1'), false);
  assert.equal(isMedia('not a url'), false);
});

/* ------------------------------------------------------------------- paths */

test('safeName resolves plain filenames inside the download dir', () => {
  assert.equal(safeName('file.txt', DL), `${DL}/file.txt`);
  assert.equal(safeName('Some Video (1).mp4', DL), `${DL}/Some Video (1).mp4`);
});

test('safeName refuses traversal and separators', () => {
  assert.equal(safeName('../etc/passwd', DL), null);
  assert.equal(safeName('/etc/passwd', DL), null);
  assert.equal(safeName('..', DL), null);
  assert.equal(safeName('.', DL), null);
  assert.equal(safeName('a/b', DL), null);
  assert.equal(safeName('a\\b', DL), null);
  assert.equal(safeName('', DL), null);
  assert.equal(safeName(null, DL), null);
  assert.equal(safeName('bad\0name', DL), null);
});

test('safeName never escapes the root', () => {
  const root = '/tmp/dl';
  assert.equal(safeName('..%2f..%2fetc', root), `${root}/..%2f..%2fetc`);
  assert.equal(safeName('../file', root), null);
});

/* -------------------------------------------------------------- safeDecode */

test('safeDecode decodes valid escapes', () => {
  assert.equal(safeDecode('a%20b'), 'a b');
  assert.equal(safeDecode('100%25'), '100%');
  assert.equal(safeDecode('plain'), 'plain');
  assert.equal(safeDecode(''), '');
});

test('safeDecode keeps broken escapes verbatim', () => {
  assert.equal(safeDecode('%E0%A4%A'), '%E0%A4%A');
  assert.equal(safeDecode('file%ZZ.bin'), 'file%ZZ.bin');
  assert.equal(safeDecode('ends-with-%'), 'ends-with-%');
});

test('safeDecode passes non-strings through untouched', () => {
  assert.equal(safeDecode(undefined), undefined);
  assert.equal(safeDecode(null), null);
});

/* ------------------------------------------------------------------ magnet */

test('isMetadataOnlyJob spots aria2 magnet metadata jobs', () => {
  assert.equal(isMetadataOnlyJob({ followedBy: ['abc'] }), true);
  assert.equal(isMetadataOnlyJob({ followedBy: ['a', 'b'] }), true);
});

test('isMetadataOnlyJob tolerates ordinary jobs', () => {
  assert.equal(isMetadataOnlyJob({}), false);
  assert.equal(isMetadataOnlyJob({ followedBy: [] }), false);
  assert.equal(isMetadataOnlyJob({ gid: 'x', status: 'active' }), false);
  assert.equal(isMetadataOnlyJob(null), false);
  assert.equal(isMetadataOnlyJob(undefined), false);
});

test('magnetName extracts the display name', () => {
  assert.equal(magnetName('magnet:?xt=urn:btih:abc&dn=Cool%20Movie'), 'Cool Movie');
  assert.equal(magnetName('magnet:?xt=urn:btih:abc&dn=Cool+Movie'), 'Cool Movie');
  assert.equal(magnetName('magnet:?xt=urn:btih:abc'), '');
  assert.equal(magnetName(''), '');
  assert.equal(magnetName(null), '');
});

/* ------------------------------------------------------------------- queue */

const q = (id, status, hasProc) => ({ id, status, hasProc });

test('ytStartableIds fills free slots in order', () => {
  const jobs = [q('a', 'waiting', false), q('b', 'waiting', false), q('c', 'waiting', false)];
  assert.deepEqual(ytStartableIds(jobs, 2), ['a', 'b']);
  assert.deepEqual(ytStartableIds(jobs, 1), ['a']);
  assert.deepEqual(ytStartableIds(jobs, 0), []);
  assert.deepEqual(ytStartableIds([], 3), []);
});

test('ytStartableIds counts any live process, including paused ones', () => {
  const pausedWithProc = [q('a', 'paused', true), q('b', 'waiting', false)];
  assert.deepEqual(ytStartableIds(pausedWithProc, 1), []);
  assert.deepEqual(ytStartableIds(pausedWithProc, 2), ['b']);
});

test('ytStartableIds ignores jobs paused before they started', () => {
  const jobs = [q('a', 'paused', false), q('b', 'waiting', false)];
  assert.deepEqual(ytStartableIds(jobs, 1), ['b']);
});

test('ytStartableIds never picks running or finished jobs', () => {
  const jobs = [
    q('a', 'active', true),
    q('b', 'processing', true),
    q('c', 'complete', false),
    q('d', 'error', false),
  ];
  assert.deepEqual(ytStartableIds(jobs, 5), []);
});

/* ----------------------------------------------------- limit-change restart */

test('ytRestartIds picks active jobs with a live process', () => {
  const jobs = [q('a', 'active', true), q('b', 'active', false), q('c', 'processing', true)];
  assert.deepEqual(ytRestartIds(jobs), ['a']);
});

test('ytRestartIds skips paused, processing and already-restarting jobs', () => {
  const jobs = [
    { id: 'a', status: 'paused', hasProc: true },
    { id: 'b', status: 'processing', hasProc: true },
    { id: 'c', status: 'active', hasProc: true, restarting: true },
    { id: 'd', status: 'waiting', hasProc: false },
  ];
  assert.deepEqual(ytRestartIds(jobs), []);
});

/* ------------------------------------------------------------------ ranges */

test('parseRange handles closed, open-ended and suffix ranges', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-9999', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=999-999', 1000), { start: 999, end: 999 });
});

test('parseRange reports unsatisfiable ranges', () => {
  assert.equal(parseRange('bytes=1000-', 1000), 'invalid');
  assert.equal(parseRange('bytes=5-2', 1000), 'invalid');
  assert.equal(parseRange('bytes=abc', 1000), 'invalid');
  assert.equal(parseRange('bytes=-0', 1000), 'invalid');
  assert.equal(parseRange('bytes=-', 1000), 'invalid');
  assert.equal(parseRange('bytes=0-1,3-4', 1000), 'invalid');
  assert.equal(parseRange('items=0-1', 1000), 'invalid');
});

test('parseRange ignores absent headers', () => {
  assert.equal(parseRange(null, 1000), null);
  assert.equal(parseRange('', 1000), null);
});

/* ------------------------------------------------------------------- guard */

const req = (over) => ({ method: 'GET', host: `127.0.0.1:${PORT}`, ...over });

test('guardRequest accepts localhost hosts', () => {
  assert.equal(guardRequest(req({}), PORT), null);
  assert.equal(guardRequest(req({ host: `localhost:${PORT}` }), PORT), null);
  assert.equal(guardRequest(req({ host: `LOCALHOST:${PORT}` }), PORT), null);
});

test('guardRequest rejects foreign or missing hosts', () => {
  assert.ok(guardRequest(req({ host: 'evil.com' }), PORT));
  assert.ok(guardRequest(req({ host: `evil.com:${PORT}` }), PORT));
  assert.ok(guardRequest(req({ host: `127.0.0.1:${PORT + 1}` }), PORT));
  assert.ok(guardRequest(req({ host: undefined }), PORT));
});

test('guardRequest checks Origin on writes only', () => {
  const json = 'application/json';
  assert.equal(guardRequest(req({ method: 'POST', contentType: json }), PORT), null);
  assert.equal(
    guardRequest(req({ method: 'POST', contentType: json, origin: `http://127.0.0.1:${PORT}` }), PORT),
    null,
  );
  assert.equal(
    guardRequest(req({ method: 'POST', contentType: json, origin: `http://localhost:${PORT}` }), PORT),
    null,
  );
  assert.ok(
    guardRequest(req({ method: 'POST', contentType: json, origin: 'http://evil.com' }), PORT),
  );
  // reads may carry any Origin
  assert.equal(guardRequest(req({ origin: 'http://evil.com' }), PORT), null);
  assert.ok(guardRequest(req({ method: 'DELETE', origin: 'http://evil.com' }), PORT));
});

test('guardRequest requires JSON on POST', () => {
  assert.ok(guardRequest(req({ method: 'POST' }), PORT));
  assert.ok(guardRequest(req({ method: 'POST', contentType: 'text/plain' }), PORT));
  assert.equal(
    guardRequest(req({ method: 'POST', contentType: 'application/json; charset=utf-8' }), PORT),
    null,
  );
  // DELETE bodies are optional
  assert.equal(guardRequest(req({ method: 'DELETE' }), PORT), null);
});

/* ----------------------------------------------------------------- yt-dlp */

test('parseYtProgress reads destination and merge lines', () => {
  assert.deepEqual(
    parseYtProgress('[download] Destination: /tmp/My Video [abc].mp4'),
    { kind: 'destination', path: '/tmp/My Video [abc].mp4' },
  );
  assert.deepEqual(
    parseYtProgress('[Merger] Merging formats into "/tmp/out.mkv"'),
    { kind: 'destination', path: '/tmp/out.mkv' },
  );
});

test('parseYtProgress reads percentage, size, speed and ETA', () => {
  const ev = parseYtProgress('[download]  42.5% of ~ 10.00MiB at 1.50MiB/s ETA 00:12');
  assert.equal(ev.kind, 'progress');
  assert.equal(ev.percent, 42.5);
  assert.equal(ev.size, 10 * 1024 * 1024);
  assert.equal(ev.speed, 1.5 * 1024 * 1024);
  assert.equal(ev.eta, '00:12');
});

test('parseYtProgress tolerates unknown speed and missing ETA', () => {
  const unknown = parseYtProgress('[download]  10.0% of 1.00MiB at Unknown B/s ETA Unknown');
  assert.equal(unknown.kind, 'progress');
  assert.equal(unknown.speed, 0);
  assert.equal(unknown.eta, '');

  const bare = parseYtProgress('[download]  50.0% of 2.00MiB');
  assert.equal(bare.kind, 'progress');
  assert.equal(bare.percent, 50);
  assert.equal(bare.size, 2 * 1024 * 1024);
  assert.equal(bare.speed, 0);
});

test('parseYtProgress handles completion, errors and noise', () => {
  assert.deepEqual(
    parseYtProgress('[download] /tmp/a.mp4 has already been downloaded'),
    { kind: 'complete' },
  );
  assert.deepEqual(
    parseYtProgress('ERROR: [youtube] abc: Video unavailable'),
    { kind: 'error', message: '[youtube] abc: Video unavailable' },
  );
  assert.equal(parseYtProgress('[download] 100%').kind, 'processing');
  assert.equal(parseYtProgress('[youtube] abc: Downloading webpage'), null);
  assert.equal(parseYtProgress(''), null);
  assert.equal(parseYtProgress(null), null);
});
