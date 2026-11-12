/**
 * Integration test: run the real server against a fake aria2 JSON-RPC engine.
 *
 * The server is copied to a temp directory so it writes its own conf/secret
 * there, and RPC_PORT points at a stub engine so aria2c is never spawned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastError || new Error('timed out');
}

/** Minimal aria2 stub: getVersion/getGlobalOption plus empty job lists. */
function fakeAria2(fixture) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let method = '';
      try {
        method = JSON.parse(body).method;
      } catch {}

      let result = 'OK';
      if (method === 'aria2.getVersion') {
        result = { version: '1.36.0' };
      } else if (method === 'aria2.getGlobalOption') {
        result = {
          dir: fixture.dir,
          'max-overall-download-limit': '0',
          'max-overall-upload-limit': '0',
        };
      } else if (method === 'aria2.getGlobalStat') {
        result = {
          downloadSpeed: '0',
          uploadSpeed: '0',
          numActive: String(fixture.active.length),
          numWaiting: String(fixture.waiting.length),
          numStopped: String(fixture.stopped.length),
        };
      } else if (method === 'aria2.tellActive') {
        result = fixture.active;
      } else if (method === 'aria2.tellWaiting') {
        result = fixture.waiting;
      } else if (method === 'aria2.tellStopped') {
        result = fixture.stopped;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: '1', result }));
    });
  });
}

test('host/origin guard, body validation, bad paths and magnet rows', { timeout: 60000 }, async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetchfox-it-'));
  const dlDir = path.join(appDir, 'downloads');
  const httpPort = await freePort();
  const rpcPort = await freePort();

  const fixture = {
    dir: dlDir,
    active: [
      {
        // the real torrent spawned by the magnet; name is unknown until metadata
        gid: 'real1',
        status: 'active',
        totalLength: '2048',
        completedLength: '0',
        downloadSpeed: '0',
        uploadSpeed: '0',
        connections: '0',
        dir: dlDir,
        files: [{ path: '' }],
        following: 'meta1',
      },
    ],
    waiting: [],
    stopped: [
      {
        // metadata-only job: must never reach the UI or trigger a notification
        gid: 'meta1',
        status: 'complete',
        totalLength: '0',
        files: [{ path: '', uris: [{ uri: 'magnet:?xt=urn:btih:abc&dn=Cool%20Movie' }] }],
        followedBy: ['real1'],
      },
    ],
  };

  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(appDir, 'server.mjs'));
  fs.cpSync(path.join(ROOT, 'lib'), path.join(appDir, 'lib'), { recursive: true });

  const fake = fakeAria2(fixture);
  await new Promise((resolve) => fake.listen(rpcPort, '127.0.0.1', resolve));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: appDir,
    env: {
      ...process.env,
      PORT: String(httpPort),
      RPC_PORT: String(rpcPort),
      FETCHFOX_DIR: dlDir,
      ARIA2_SECRET: 'integration-test',
      MAX_YT_CONCURRENT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  try {
    await waitFor(async () => {
      const r = await request(httpPort, { path: '/api/state' });
      return r.status === 200;
    }).catch((e) => {
      throw new Error(`server did not start (${e.message}):\n${output}`);
    });

    // --- state, magnet metadata hidden, follower labelled from the magnet
    const state = JSON.parse((await request(httpPort, { path: '/api/state' })).body);
    assert.equal(state.engine, 'up');
    assert.equal(state.dir, dlDir);
    assert.equal(state.jobs.length, 1, 'metadata-only job must be hidden');
    assert.equal(state.jobs[0].id, 'real1');
    assert.equal(state.jobs[0].name, 'Cool Movie');

    // --- Host / Origin / content-type guard
    const badHost = await request(httpPort, {
      path: '/api/state',
      headers: { host: 'evil.example' },
    });
    assert.equal(badHost.status, 403);

    const badOrigin = await request(httpPort, {
      method: 'POST',
      path: '/api/limit',
      headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(badOrigin.status, 403);

    const textPlain = await request(httpPort, {
      method: 'POST',
      path: '/api/limit',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    assert.equal(textPlain.status, 403);

    // --- body and path validation
    const badJson = await request(httpPort, {
      method: 'POST',
      path: '/api/limit',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.equal(badJson.status, 400);
    assert.equal(JSON.parse(badJson.body).error, 'invalid json');

    const badPath = await request(httpPort, { path: '/f/%E0%A4%A' });
    assert.equal(badPath.status, 400);
    assert.equal(JSON.parse(badPath.body).error, 'bad path');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await new Promise((r) => fake.close(r));
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});
