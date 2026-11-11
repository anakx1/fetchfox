'use strict';

/* ------------------------------------------------------------------ utils */

const $ = (s) => document.querySelector(s);
const listEl = $('#list');
const emptyEl = $('#empty');

const fmtBytes = (n) => {
  n = Number(n) || 0;
  if (n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtSpeed = (n) => (Number(n) > 0 ? `${fmtBytes(n)}/s` : '—');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

async function api(path, opts) {
  const r = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  return r.json().catch(() => ({}));
}

/* ------------------------------------------------------------------- tabs */

let tab = 'active';
document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    tab = b.dataset.tab;
    resetList();
    render();
    if (tab === 'files') loadFiles();
  });
});

function resetList() {
  listEl.innerHTML = '';
  jobEls.clear();
  filesEls.clear();
}

/* ------------------------------------------------------------------- add */

const urlsEl = $('#urls');

function autoGrow() {
  urlsEl.style.height = 'auto';
  urlsEl.style.height = Math.min(urlsEl.scrollHeight, 130) + 'px';
}
urlsEl.addEventListener('input', autoGrow);
urlsEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    addLinks();
  }
});

$('#optsBtn').addEventListener('click', () => $('#options').classList.toggle('hidden'));

$('#pasteBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/clipboard', { method: 'POST' });
    const text = (r.text || '').trim();
    if (!text) return toast('Clipboard is empty', true);
    urlsEl.value = urlsEl.value ? urlsEl.value + '\n' + text : text;
    autoGrow();
    toast('Pasted from clipboard');
  } catch {
    toast('Could not read clipboard', true);
  }
});

$('#addBtn').addEventListener('click', addLinks);

async function addLinks() {
  const raw = urlsEl.value.trim();
  if (!raw) return toast('Paste a link first', true);
  const btn = $('#addBtn');
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    const r = await api('/api/add', {
      method: 'POST',
      body: JSON.stringify({
        urls: raw,
        forceYtdlp: $('#forceYtdlp').checked,
        playlist: $('#playlist').checked,
        format: $('#format').value.trim() || undefined,
      }),
    });
    const res = r.results || [];
    const ok = res.filter((x) => x.ok).length;
    const bad = res.filter((x) => !x.ok);
    if (ok) {
      urlsEl.value = '';
      autoGrow();
      toast(`${ok} download${ok > 1 ? 's' : ''} started`);
      switchTab('active');
    }
    if (bad.length) toast(bad[0].error || 'One link failed', true);
  } catch (e) {
    toast('Request failed', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download';
  }
}

function switchTab(name) {
  const b = document.querySelector(`.tab[data-tab="${name}"]`);
  if (b) b.click();
}

/* ---------------------------------------------------------------- limits */

let currentLimit = null;

$('#limitChips').addEventListener('click', async (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const bps = Number(chip.dataset.bps);
  document.querySelectorAll('#limitChips .chip').forEach((c) => c.classList.remove('on'));
  chip.classList.add('on');
  await api('/api/limit', { method: 'POST', body: JSON.stringify({ down: bps }) });
  toast(bps ? `Limit ${fmtBytes(bps)}/s` : 'Unlimited speed');
});

function syncLimitChip(limitDown) {
  if (currentLimit === limitDown) return;
  currentLimit = limitDown;
  document.querySelectorAll('#limitChips .chip').forEach((c) => {
    c.classList.toggle('on', Number(c.dataset.bps) === limitDown);
  });
}

/* ----------------------------------------------------------------- state */

let last = null;
let jobEls = new Map();
let filesEls = new Map();

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    try {
      last = JSON.parse(ev.data);
      render();
    } catch {}
  };
  es.onerror = () => {
    es.close();
    setTimeout(connect, 2500);
  };
}

function render() {
  if (!last) return;
  const s = last;

  const dot = $('#dot');
  dot.className = 'dot ' + (s.engine === 'up' ? 'up' : 'down');
  $('#engineText').textContent = s.engine === 'up' ? 'engine running' : 'engine offline';
  $('#downSpeed').textContent = fmtSpeed(s.global.down);
  $('#activeCount').textContent = s.jobs.filter((j) => j.status === 'active').length;
  $('#dirText').textContent = s.dir || '';
  syncLimitChip(Number(s.global.limitDown || 0));

  const active = s.jobs.filter((j) => ['active', 'waiting', 'paused', 'processing'].includes(j.status));
  const finished = s.jobs.filter((j) => ['complete', 'error', 'cancelled'].includes(j.status));

  $('#tabActive').textContent = active.length;
  $('#tabFinished').textContent = finished.length;

  if (tab === 'files') { renderFiles(); return; }

  const rows = tab === 'active' ? active : finished;
  emptyEl.classList.toggle('hidden', rows.length > 0);
  emptyEl.innerHTML = tab === 'active'
    ? 'No active downloads.<br><span>Paste a link above to start one.</span>'
    : 'Nothing finished yet.<br><span>Completed downloads will appear here.</span>';

  const seen = new Set();
  for (const job of rows) {
    seen.add(job.id);
    let el = jobEls.get(job.id);
    if (!el) {
      el = makeJobEl();
      jobEls.set(job.id, el);
    }
    updateJobEl(el, job);
    listEl.appendChild(el); // keeps order, moves existing nodes
  }
  for (const [id, el] of jobEls) {
    if (!seen.has(id)) { el.remove(); jobEls.delete(id); }
  }
}

function makeJobEl() {
  const el = document.createElement('div');
  el.className = 'job';
  el.innerHTML = `
    <div class="jhead">
      <span class="jkind"></span>
      <div class="jname"></div>
      <div class="jpct"></div>
    </div>
    <div class="bar"><i></i></div>
    <div class="jmeta"></div>
    <div class="jactions"></div>`;
  return el;
}

const KIND_LABEL = { aria2: 'HTTP', ytdlp: 'MEDIA' };
const STATUS_TEXT = {
  waiting: 'queued', paused: 'paused', error: 'failed',
  cancelled: 'cancelled', processing: 'processing', complete: 'done',
};

function updateJobEl(el, job) {
  const pct = job.size > 0 ? Math.min(100, (job.done / job.size) * 100) : 0;
  const indeterminate = job.status === 'active' && job.size === 0;

  el.className = 'job ' + job.status;
  el.dataset.id = job.id;

  const kind = el.querySelector('.jkind');
  const isTorrent = /^magnet:/i.test(job.url || '');
  kind.textContent = isTorrent ? 'TOR' : (job.kind === 'ytdlp' ? 'MEDIA' : 'HTTP');
  kind.className = 'jkind' + (isTorrent ? ' tor' : (job.kind === 'ytdlp' ? ' yt' : ''));

  const nameEl = el.querySelector('.jname');
  if (nameEl.textContent !== job.name) {
    nameEl.textContent = job.name;
    nameEl.title = job.url || job.name;
  }

  const pctEl = el.querySelector('.jpct');
  pctEl.textContent = indeterminate ? '' : `${pct.toFixed(pct >= 10 || pct === 0 ? 0 : 1)}%`;

  const bar = el.querySelector('.bar');
  const fill = bar.querySelector('i');
  bar.className = 'bar' + (
    job.status === 'paused' ? ' paused' :
    job.status === 'error' || job.status === 'cancelled' ? ' err' :
    job.status === 'complete' ? ' done' :
    job.status === 'waiting' ? ' wait' :
    indeterminate ? ' indet' : ''
  );
  fill.style.width = indeterminate ? '34%' : `${Math.max(pct, job.status === 'active' ? 1 : 0)}%`;

  // meta line
  const meta = [];
  if (job.size > 0) meta.push(`${fmtBytes(job.done)} / ${fmtBytes(job.size)}`);
  else if (job.done > 0) meta.push(fmtBytes(job.done));

  if (job.status === 'active') {
    if (job.speed > 0) meta.push(`<span class="spd">${fmtSpeed(job.speed)}</span>`);
    if (job.conns > 0) meta.push(`${job.conns} conn`);
    if (job.seeders > 0) meta.push(`${job.seeders} seed`);
    if (job.eta) meta.push(`ETA ${esc(job.eta)}`);
  }
  if (STATUS_TEXT[job.status]) meta.push(`<span class="st">${STATUS_TEXT[job.status]}</span>`);
  if (job.error) meta.push(`<span class="err">${esc(String(job.error).slice(0, 120))}</span>`);
  el.querySelector('.jmeta').innerHTML = meta.join('');

  // actions
  const act = el.querySelector('.jactions');
  const want = actionsFor(job);
  const sig = want.map((a) => a.act).join(',');
  if (act.dataset.sig !== sig) {
    act.dataset.sig = sig;
    act.innerHTML = want.map((a) =>
      `<button class="act ${a.cls || ''}" data-act="${a.act}">${a.label}</button>`).join('');
  }
}

function actionsFor(job) {
  const s = job.status;
  if (s === 'active' || s === 'waiting' || s === 'processing') {
    return [
      { act: 'pause', label: 'Pause' },
      { act: 'cancel', label: 'Cancel', cls: 'danger' },
    ];
  }
  if (s === 'paused') {
    return [
      { act: 'resume', label: 'Resume', cls: 'acc' },
      { act: 'cancel', label: 'Cancel', cls: 'danger' },
    ];
  }
  if (s === 'error' || s === 'cancelled') {
    return [
      { act: 'retry', label: 'Retry', cls: 'acc' },
      { act: 'remove', label: 'Remove' },
    ];
  }
  return [
    { act: 'open', label: 'Open', cls: 'acc' },
    { act: 'remove', label: 'Remove from list' },
    { act: 'delete', label: 'Delete file', cls: 'danger' },
  ];
}

listEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('.act');
  if (!btn) return;
  const el = btn.closest('.job');
  const id = el.dataset.id;
  const job = (last?.jobs || []).find((j) => j.id === id);
  if (!job) return;
  const act = btn.dataset.act;

  if (act === 'open') {
    await api('/api/open', { method: 'POST', body: JSON.stringify({ name: job.name }) });
    return;
  }
  if (act === 'delete') {
    if (!confirm(`Delete "${job.name}" from storage?`)) return;
    const r = await api('/api/file?name=' + encodeURIComponent(job.name), { method: 'DELETE' });
    if (r.ok) {
      await api('/api/job', { method: 'POST', body: JSON.stringify({ id, action: 'remove' }) });
      toast('File deleted');
    } else {
      toast(r.error || 'Delete failed', true);
    }
    return;
  }
  const r = await api('/api/job', { method: 'POST', body: JSON.stringify({ id, action: act }) });
  if (r && r.ok === false) toast(r.error || 'Action failed', true);
});

/* ----------------------------------------------------------------- files */

let filesCache = [];

async function loadFiles() {
  const r = await api('/api/files');
  filesCache = r.files || [];
  renderFiles();
}

function renderFiles() {
  const seen = new Set();
  emptyEl.classList.toggle('hidden', filesCache.length > 0);
  emptyEl.innerHTML = 'No files on disk yet.<br><span>Finished downloads land here.</span>';

  for (const f of filesCache) {
    seen.add(f.name);
    let el = filesEls.get(f.name);
    if (!el) {
      el = document.createElement('div');
      el.className = 'job';
      el.dataset.name = f.name;
      el.innerHTML = `
        <div class="jhead">
          <span class="jkind">FILE</span>
          <div class="jname"></div>
        </div>
        <div class="jmeta"></div>
        <div class="jactions">
          <button class="act acc" data-fact="open">Open</button>
          <button class="act" data-fact="play">Play</button>
          <button class="act danger" data-fact="delete">Delete</button>
        </div>`;
      filesEls.set(f.name, el);
    }
    el.querySelector('.jname').textContent = f.name;
    const d = new Date(f.mtime);
    el.querySelector('.jmeta').innerHTML =
      `${fmtBytes(f.size)} · ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    listEl.appendChild(el);
  }
  for (const [n, el] of filesEls) {
    if (!seen.has(n)) { el.remove(); filesEls.delete(n); }
  }
}

listEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-fact]');
  if (!btn) return;
  const el = btn.closest('.job');
  const name = el.dataset.name;
  const fact = btn.dataset.fact;
  if (fact === 'delete') {
    if (!confirm(`Delete "${name}"?`)) return;
    const r = await api('/api/file?name=' + encodeURIComponent(name), { method: 'DELETE' });
    if (r.ok) { toast('Deleted'); loadFiles(); } else toast(r.error || 'Failed', true);
    return;
  }
  await api('/api/open', { method: 'POST', body: JSON.stringify({ name }) });
});

/* ------------------------------------------------------------ install PWA */

let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('#installBtn').classList.remove('hidden');
});

$('#installBtn').addEventListener('click', async () => {
  if (!installEvt) return toast('Use Chrome menu → Add to Home screen');
  installEvt.prompt();
  const { outcome } = await installEvt.userChoice;
  if (outcome === 'accepted') $('#installBtn').classList.add('hidden');
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/* ------------------------------------------------------------------ boot */

connect();
setInterval(() => { if (tab === 'files') loadFiles(); }, 5000);
