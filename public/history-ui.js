/* =============================================================================
   MISSION CONTROL - history + alerts

   Everything that needs GET /api/history:
     - the Stack 24h health strip (status band + latency sparkline + caption)
     - a mini status band under each `railway` rail item
     - a fan-out sparkline in the event-feed header
   ...plus the desktop alert channel, which is diff-derived off the same
   snapshots the rest of the UI already receives.

   /api/history does not exist on every build of the server. When it 404s we
   draw NOTHING and say so - a fabricated uptime bar on a real monitor is worse
   than an empty one, so there is deliberately no fixture fallback here.
   `MC.history.loadFixture()` is the explicit, opt-in dev path.

   Loaded after stack-view.js. Reaches app.js only through window.MC.
   ============================================================================= */
'use strict';

(function () {

const MC = window.MC;
if (!MC) return;

const { $, el, svgEl, setText, clamp, lsGet, lsSet, trunc } = MC.util;
const D = MC.D;
const REDUCED = MC.REDUCED;
const COL = MC.COL;

/* ------------------------------------------------------------------ const */

const POLL_MS = 60000;
const HOURS = 24;
const MAX_POINTS = 720;
const NOT_AVAIL = 'history: not available (server restart pending)';
const COLLECTING = 'history: collecting · no samples in the window yet';
const DEDUPE_MS = 60000;
const MAX_BUCKETS = 2000;      // a malformed since/until must not spray 10^6 rects

/* status -> band ink. `ok` stays a quiet wash so an incident reads as the only
   thing on the strip; anything missing is dim at low opacity. */
const BAND = {
  ok:          { c: COL.live, o: 0.24 },
  degraded:    { c: COL.warn, o: 0.60 },
  down:        { c: COL.bad,  o: 0.85 },
  unreachable: { c: COL.bad,  o: 0.62 },
  missing:     { c: COL.dim,  o: 0.14 }
};
const UP_BAND   = { c: COL.live, o: 0.30 };
const DOWN_BAND = { c: COL.bad,  o: 0.85 };

/* ------------------------------------------------------------------ dom */

const E = {
  bar: $('stack-histbar'),
  wrap: $('hb-wrap'),
  svg: $('hb-svg'),
  band: $('hb-band'),
  spark: $('hb-spark'),
  caption: $('hb-caption'),
  fanout: $('fanout-strip'),
  foSvg: $('fanout-spark'),
  foLine: $('fanout-line'),
  foArea: $('fanout-area'),
  foLabel: $('fanout-label'),
  alerts: $('tgl-alerts'),
  tooltip: $('tooltip')
};

/* index.html and this file ship together, but a stale cached page must not take
   the rest of the dashboard down with it. */
if (!E.bar || !E.svg || !E.band || !E.caption || !E.fanout || typeof MC.on !== 'function') {
  console.warn('[history-ui] markup or MC bridge missing - history widgets disabled');
  return;
}

/* ------------------------------------------------------------------ state */

const H = {
  data: null,        // normalised {since, until, bucketMs, n, series, stats}
  at: 0,
  poll: 0,
  inFlight: false,
  failed: false,     // a fetch has failed at least once and we have nothing
  empty: false,      // the endpoint answered, the window just has no samples
  rects: [],         // the stack band's rect elements, index === bucket
  railBands: new Map()   // itemId -> {row, svg, g, up}
};

/* ------------------------------------------------------------------ util */

function fmtMs(v) { return Number.isFinite(v) ? Math.round(v) + ' ms' : '-'; }
function localStamp(t) {
  try {
    return new Date(t).toLocaleString('en-US',
      { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return new Date(t).toISOString().slice(0, 16).replace('T', ' '); }
}
function localClock(t) {
  try {
    return new Date(t).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch (_) { return new Date(t).toISOString().slice(11, 16); }
}
function pctText(p) {
  if (!Number.isFinite(p)) return '-';
  // 100 and 99.4 both want to be honest; 99.97 must not round up to 100
  if (p >= 100) return '100%';
  return (Math.floor(p * 10) / 10).toFixed(1) + '%';
}
function durMins(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

/* Smallest positive gap between samples. Robust to a dropped bucket in the
   middle, which an average or a first-diff would both get wrong. */
function deriveBucketMs(rows) {
  let best = Infinity;
  for (let i = 1; i < rows.length && i < 200; i++) {
    const d = rows[i].t - rows[i - 1].t;
    if (d > 0 && d < best) best = d;
  }
  return Number.isFinite(best) ? best : 0;
}

/* ============================================================== NORMALISE */

/* Takes whatever /api/history returned and produces the one shape the
   renderers read. Never throws on a partial payload - a missing series just
   means that widget draws nothing. */
function normalise(j) {
  if (!j || typeof j !== 'object') return null;
  const src = (j.series && typeof j.series === 'object') ? j.series : {};

  const clean = (arr) => (Array.isArray(arr) ? arr.filter((s) => s && Number.isFinite(s.t)) : [])
    .slice().sort((a, b) => a.t - b.t);

  const stack = clean(src.stack);
  const services = {};
  const rawSvc = (src.services && typeof src.services === 'object') ? src.services : {};
  for (const k of Object.keys(rawSvc)) {
    const rows = clean(rawSvc[k]);
    if (rows.length) services[k] = rows;
  }
  const agents = clean(src.agents);

  // any series can carry the cadence; prefer stack, then a service, then agents
  let bucketMs = deriveBucketMs(stack);
  if (!bucketMs) for (const k of Object.keys(services)) { bucketMs = deriveBucketMs(services[k]); if (bucketMs) break; }
  if (!bucketMs) bucketMs = deriveBucketMs(agents);

  const all = stack.length ? stack : (agents.length ? agents : (Object.keys(services).length ? services[Object.keys(services)[0]] : []));
  if (!all.length) return null;

  let since = Number.isFinite(j.since) ? j.since : all[0].t;
  let until = Number.isFinite(j.until) ? j.until : (all[all.length - 1].t + (bucketMs || 0));
  const hours = Number.isFinite(j.hours) ? j.hours : HOURS;
  if (!bucketMs) bucketMs = Math.max(1000, Math.round((until - since) / MAX_POINTS));
  if (!(until > since)) until = since + bucketMs;

  let n = Math.round((until - since) / bucketMs);
  n = clamp(1, n, MAX_BUCKETS);

  const stats = (j.stats && typeof j.stats === 'object') ? j.stats : {};
  return {
    generatedAt: j.generatedAt || null,
    since: since, until: until, hours: hours,
    bucketMs: bucketMs, n: n,
    series: { stack: stack, services: services, agents: agents },
    stats: {
      stack: (stats.stack && typeof stats.stack === 'object') ? stats.stack : null,
      services: (stats.services && typeof stats.services === 'object') ? stats.services : {},
      agents: (stats.agents && typeof stats.agents === 'object') ? stats.agents : null
    }
  };
}

/* index -> sample, dropping anything outside the window */
function slotMap(rows, since, bucketMs, n) {
  const m = new Map();
  for (const s of rows) {
    const i = Math.round((s.t - since) / bucketMs);
    if (i >= 0 && i < n) m.set(i, s);
  }
  return m;
}

/* ============================================================== STACK STRIP */

/* One rect per bucket, exactly `n` of them, rebuilt only when the count moves.
   Between rebuilds the fills are patched in place so a live SSE append is a
   handful of attribute writes rather than 720 element creations. */
function renderStackBand() {
  const h = H.data;
  if (!h) return;
  const n = h.n;
  const rows = h.series.stack;
  const slots = slotMap(rows, h.since, h.bucketMs, n);

  if (H.rects.length !== n) {
    E.svg.setAttribute('viewBox', '0 0 ' + n + ' 28');
    E.band.textContent = '';
    H.rects = [];
    for (let i = 0; i < n; i++) {
      const r = svgEl('rect', { x: i, y: 0, width: 1, height: 28 });
      E.band.appendChild(r);
      H.rects.push(r);
    }
  }
  for (let i = 0; i < n; i++) {
    const s = slots.get(i);
    const b = (s && BAND[s.status]) || BAND.missing;
    const r = H.rects[i];
    if (r._c !== b.c) { r.setAttribute('fill', b.c); r._c = b.c; }
    if (r._o !== b.o) { r.setAttribute('fill-opacity', b.o); r._o = b.o; }
  }

  // latency polyline over the band, one element per contiguous run so a gap
  // during an outage is a gap and not a straight line through it
  E.spark.textContent = '';
  let hi = 0;
  for (const s of rows) if (Number.isFinite(s.ms) && s.ms > hi) hi = s.ms;
  const st = h.stats.stack;
  if (st && Number.isFinite(st.p95Ms)) hi = Math.max(hi, st.p95Ms);
  if (!(hi > 0)) return;
  const y = (ms) => 26 - clamp(0, ms / (hi * 1.08), 1) * 24;

  let run = [];
  const flush = () => {
    if (run.length > 1) E.spark.appendChild(svgEl('polyline', { class: 'hb-spark', points: run.join(' ') }));
    run = [];
  };
  for (let i = 0; i < n; i++) {
    const s = slots.get(i);
    if (!s || !Number.isFinite(s.ms)) { flush(); continue; }
    run.push((i + 0.5).toFixed(1) + ',' + y(s.ms).toFixed(2));
  }
  flush();
}

function incidentLines() {
  const st = H.data && H.data.stats.stack;
  const inc = st && Array.isArray(st.incidents) ? st.incidents : [];
  if (!inc.length) return ['no incidents in the last 24h'];
  return inc.slice(0, 8).map((x) => {
    const from = Number.isFinite(x.from) ? x.from : null;
    const to = Number.isFinite(x.to) ? x.to : null;
    return String(x.status || 'down').toUpperCase() +
      (from ? '  ' + localStamp(from) : '') +
      (from && to ? '  ·  ' + durMins(to - from) : '');
  });
}

function renderStackCaption() {
  const h = H.data;
  if (!h) {
    setText(E.caption, H.empty ? COLLECTING : NOT_AVAIL);
    E.caption.className = 'hb-caption is-off';
    E.caption.title = H.empty
      ? '/api/history is answering but has no samples in the window yet'
      : 'GET /api/history is not answering on this server build';
    return;
  }
  const st = h.stats.stack || {};
  const inc = Array.isArray(st.incidents) ? st.incidents.length : 0;
  const bits = [h.hours + 'h'];
  if (Number.isFinite(st.uptimePct)) bits.push(pctText(st.uptimePct));
  if (Number.isFinite(st.p50Ms)) bits.push('p50 ' + fmtMs(st.p50Ms));
  if (Number.isFinite(st.p95Ms)) bits.push('p95 ' + fmtMs(st.p95Ms));
  bits.push(inc + (inc === 1 ? ' incident' : ' incidents'));
  setText(E.caption, bits.join(' · '));
  E.caption.className = 'hb-caption' + (inc > 0 ? ' is-bad' : '');
  E.caption.title = incidentLines().join('\n') +
    (Number.isFinite(st.worst) ? '\nworst ' + fmtMs(st.worst) : '') +
    (Number.isFinite(st.samples) ? '\n' + st.samples + ' samples' : '');
}

/* The server's stack module is off (app.js read /api/health). Its strip, its
   per-service bands (the 'railway' group) and its alerts all stand down. */
const stackOff = () => typeof MC.stackOff === 'function' && MC.stackOff();
const STACK_RAIL_GROUP = 'railway';

function showStrip() {
  const on = MC.view === 'stack' && !stackOff();
  if (E.bar.hidden === on) E.bar.hidden = !on;
  const have = !!H.data;
  if (E.wrap.hidden === have) E.wrap.hidden = !have;
}

/* ============================================================== RAIL BANDS */

/* Run-length encoded: a service that has been up all day is one rect, not 720.
   Identical on screen, ~1/200th of the DOM. */
function paintRailBand(g, rows, since, bucketMs, n) {
  const slots = slotMap(rows, since, bucketMs, n);
  g.textContent = '';
  let i = 0;
  while (i < n) {
    const s = slots.get(i);
    const b = !s ? BAND.missing : (s.up ? UP_BAND : DOWN_BAND);
    let j = i + 1;
    while (j < n) {
      const t = slots.get(j);
      const tb = !t ? BAND.missing : (t.up ? UP_BAND : DOWN_BAND);
      if (tb !== b) break;
      j++;
    }
    g.appendChild(svgEl('rect', { x: i, y: 0, width: j - i, height: 12, fill: b.c, 'fill-opacity': b.o }));
    i = j;
  }
}

/* The rail is owned by app.js; we only bolt a third grid row onto the rows of
   whichever group carries the service ids. Absent series -> nothing appended,
   so there is no layout shift on a server that never reports history. */
function renderRailBands() {
  const groups = MC.railGroups;
  if (!groups) return;
  const h = H.data;
  const svcSeries = h ? h.series.services : {};
  const svcStats = h ? h.stats.services : {};

  const wanted = new Set();
  const off = stackOff();
  for (const [gid, ge] of groups) {
    if (off && gid === STACK_RAIL_GROUP) continue;
    for (const [id, ie] of ge.items) {
      const rows = svcSeries[id];
      if (!rows || !rows.length) continue;
      wanted.add(id);
      let rb = H.railBands.get(id);
      if (!rb || !rb.row.isConnected) {
        const row = el('div', 'rail-bandrow');
        const svg = svgEl('svg', {
          class: 'rail-band', xmlns: 'http://www.w3.org/2000/svg',
          viewBox: '0 0 ' + h.n + ' 12', preserveAspectRatio: 'none',
          role: 'img', 'aria-label': id + ' 24 hour availability'
        });
        const g = svgEl('g', {});
        svg.appendChild(g);
        const up = el('span', 'rb-up');
        row.appendChild(svg); row.appendChild(up);
        ie.row.appendChild(row);
        rb = { row, svg, g, up, n: 0 };
        H.railBands.set(id, rb);
      } else if (rb.row.parentNode !== ie.row) {
        ie.row.appendChild(rb.row);
      }
      if (rb.n !== h.n) { rb.svg.setAttribute('viewBox', '0 0 ' + h.n + ' 12'); rb.n = h.n; }
      paintRailBand(rb.g, rows, h.since, h.bucketMs, h.n);

      const st = svcStats[id] || {};
      const p = st.uptimePct;
      setText(rb.up, Number.isFinite(p) ? pctText(p) : '');
      rb.up.className = 'rb-up' + (Number.isFinite(p) && p < 99.9 ? ' is-bad' : '');
      const incs = Array.isArray(st.incidents) ? st.incidents.length : 0;
      rb.row.title = id + '  ·  24h availability' +
        (Number.isFinite(p) ? '\nuptime ' + pctText(p) : '') +
        (Number.isFinite(st.p50Ms) ? '\np50 ' + fmtMs(st.p50Ms) : '') +
        (Number.isFinite(st.p95Ms) ? '  ·  p95 ' + fmtMs(st.p95Ms) : '') +
        '\n' + incs + (incs === 1 ? ' incident' : ' incidents');
    }
  }
  for (const [id, rb] of H.railBands) {
    if (!wanted.has(id)) { if (rb.row.parentNode) rb.row.remove(); H.railBands.delete(id); }
  }
}

/* ============================================================== FAN-OUT */

function renderFanout() {
  const h = H.data;
  const on = MC.view === 'agents' && !!h && h.series.agents.length > 1;
  if (E.fanout.hidden === on) E.fanout.hidden = !on;
  if (!on) return;

  const now = h.until;
  let rows = h.series.agents.filter((s) => s.t >= now - 3600000);
  let span = '1h';
  if (rows.length < 2) { rows = h.series.agents; span = h.hours + 'h'; }

  let hi = 0;
  for (const s of rows) if (Number.isFinite(s.running) && s.running > hi) hi = s.running;
  const scale = Math.max(1, hi);
  const W = 120, Hh = 14;
  const pts = [];
  for (let i = 0; i < rows.length; i++) {
    const x = rows.length === 1 ? 0 : (i / (rows.length - 1)) * W;
    const v = Number.isFinite(rows[i].running) ? rows[i].running : 0;
    pts.push(x.toFixed(1) + ',' + (Hh - 1 - (v / scale) * (Hh - 2)).toFixed(2));
  }
  E.foLine.setAttribute('points', pts.join(' '));
  E.foArea.setAttribute('points', '0,' + Hh + ' ' + pts.join(' ') + ' ' + W + ',' + Hh);

  const st = h.stats.agents || {};
  const peak = span === '1h' ? hi : (Number.isFinite(st.peakRunning) ? st.peakRunning : hi);
  setText(E.foLabel, 'FAN-OUT ' + span + ' · peak ' + peak);
  E.fanout.title = 'subagents running over the last ' + span +
    '\npeak ' + peak +
    (Number.isFinite(st.peakRunning) ? '  ·  24h peak ' + st.peakRunning : '') +
    (Number.isFinite(st.peakAt) ? ' at ' + localClock(st.peakAt) : '');
}

/* ============================================================== TOOLTIP */

function tip(txt, x, y) {
  setText(E.tooltip, txt);
  E.tooltip.hidden = false;
  const r = E.tooltip.getBoundingClientRect();
  E.tooltip.style.left = Math.min(x + 14, window.innerWidth - r.width - 8) + 'px';
  E.tooltip.style.top = Math.min(y + 14, window.innerHeight - r.height - 8) + 'px';
}
function hideTip() { E.tooltip.hidden = true; }

E.svg.addEventListener('pointermove', (e) => {
  const h = H.data;
  if (!h) return;
  const r = E.svg.getBoundingClientRect();
  if (!r.width) return;
  const i = clamp(0, Math.floor((e.clientX - r.left) / r.width * h.n), h.n - 1);
  const t = h.since + i * h.bucketMs;
  const s = slotMap(h.series.stack, h.since, h.bucketMs, h.n).get(i);
  tip(localStamp(t) + '\n' +
    (s ? String(s.status || 'unknown').toUpperCase() : 'NO SAMPLE') +
    (s && Number.isFinite(s.ms) ? '  ·  ' + fmtMs(s.ms) : ''), e.clientX, e.clientY);
});
E.svg.addEventListener('pointerleave', hideTip);

E.caption.addEventListener('pointerenter', (e) => {
  if (!H.data) return;
  tip(incidentLines().join('\n'), e.clientX, e.clientY);
});
E.caption.addEventListener('pointerleave', hideTip);

/* ============================================================== RENDER ALL */

function renderAll() {
  showStrip();
  if (H.data) renderStackBand();
  renderStackCaption();
  renderRailBands();
  renderFanout();
}

/* ============================================================== APPLY */

function applyHistory(json) {
  const h = normalise(json);
  if (!h) {
    /* A well-formed window with no samples in it is the recorder running and
       having nothing yet - a freshly restarted server looks exactly like this.
       That is a different thing from the endpoint not existing, and saying so
       stops the strip claiming the server is broken for the first two minutes
       after every restart. */
    if (json && typeof json === 'object' && json.stats && Number.isFinite(json.since)) {
      H.data = null;
      H.rects = [];
      H.empty = true;
      H.failed = false;
      E.band.textContent = '';
      E.spark.textContent = '';
      renderAll();
      return true;
    }
    return false;
  }
  H.data = h;
  H.at = Date.now();
  H.failed = false;
  H.empty = false;
  H.rects = [];                 // force a rebuild: the bucket count may have moved
  renderAll();
  return true;
}

function dropHistory() {
  H.data = null;
  H.failed = true;
  H.empty = false;
  H.rects = [];
  E.band.textContent = '';
  E.spark.textContent = '';
  for (const [, rb] of H.railBands) if (rb.row.parentNode) rb.row.remove();
  H.railBands.clear();
  renderAll();
}

/* Shift every timestamp so a fixture generated hours ago reads as "now".
   Dev only - the live payload is never rebased. */
function rebase(json, atMs) {
  let j;
  try { j = JSON.parse(JSON.stringify(json)); } catch (_) { return json; }
  const now = Number.isFinite(atMs) ? atMs : Date.now();
  if (!Number.isFinite(j.until)) return j;
  const d = now - j.until;
  if (!d) return j;
  j.since += d; j.until += d;
  const bump = (rows) => { if (Array.isArray(rows)) for (const s of rows) if (s && Number.isFinite(s.t)) s.t += d; };
  const S = j.series || {};
  bump(S.stack); bump(S.agents);
  if (S.services) for (const k of Object.keys(S.services)) bump(S.services[k]);
  const st = j.stats || {};
  if (st.stack && Array.isArray(st.stack.incidents)) {
    for (const x of st.stack.incidents) { if (Number.isFinite(x.from)) x.from += d; if (Number.isFinite(x.to)) x.to += d; }
  }
  if (st.services) for (const k of Object.keys(st.services)) {
    const incs = st.services[k] && st.services[k].incidents;
    if (Array.isArray(incs)) for (const x of incs) { if (Number.isFinite(x.from)) x.from += d; if (Number.isFinite(x.to)) x.to += d; }
  }
  if (st.agents && Number.isFinite(st.agents.peakAt)) st.agents.peakAt += d;
  if (j.generatedAt) j.generatedAt = new Date(now).toISOString();
  return j;
}

/* A machine's own snapshot (gitignored fixtures/history.local.json) wins
   over the tracked synthetic demo (fixtures/history.json). */
async function loadFixture() {
  let r = await fetch('fixtures/history.local.json', { cache: 'no-store' }).catch(() => null);
  if (!r || !r.ok) r = await fetch('fixtures/history.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('fixtures/history.json ' + r.status);
  return applyHistory(rebase(await r.json()));
}

/* ============================================================== TRANSPORT */

async function fetchHistory() {
  if (H.inFlight) return;
  H.inFlight = true;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch('/api/history?hours=' + HOURS + '&maxPoints=' + MAX_POINTS,
      { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('/api/history ' + r.status);
    applyHistory(await r.json());
  } catch (_) {
    // No fixture fallback on purpose. An empty strip is honest; a fake one is not.
    if (!H.data) dropHistory();
  } finally { clearTimeout(to); H.inFlight = false; }
}

/* The Stack SSE frame lands every 30s; the history poll every 60s. Fold the
   fresh probe into the local copy so the band's right edge actually moves. */
function noteStack(snap) {
  const h = H.data;
  if (!h || !snap || !snap.summary) return;
  const s = snap.summary;
  if (!s.status) return;
  const bm = h.bucketMs;
  const t = Math.floor(Date.now() / bm) * bm;
  const rows = h.series.stack;
  const rec = {
    t: t, status: s.status,
    ms: Number.isFinite(s.httpMs) ? s.httpMs : null,
    role: s.role || null,
    unshipped: Number.isFinite(s.unshipped) ? s.unshipped : null,
    incidents: Number.isFinite(s.incidents) ? s.incidents : null
  };
  const last = rows[rows.length - 1];
  if (last && last.t === t) rows[rows.length - 1] = rec;
  else if (last && t < last.t) return;             // clock went backwards; leave it alone
  else rows.push(rec);

  h.until = t + bm;
  h.since = h.until - h.n * bm;
  while (rows.length && rows[0].t < h.since) rows.shift();
  if (MC.view === 'stack') renderStackBand();
}

/* ============================================================== MERGED FEED */

/* The phone's FEED tab is one list, not two panes: the session feed and the
   Stack feed interleaved by timestamp. Both owners expose a plain snapshot of
   their rows, so nothing here reaches into either module's state. */

const MERGED_MAX = 200;
const MF = { rows: $('merged-feed-rows'), sig: '', count: 0 };

function mergedRows() {
  const out = [];
  try {
    for (const e of (MC.feedItems ? MC.feedItems() : [])) {
      out.push({ kind: e.kind, ts: e.ts, depth: e.depth || 0, text: e.text, sev: null });
    }
  } catch (_) { }
  try {
    for (const e of (MC.stack && MC.stack.feed ? MC.stack.feed() : [])) {
      out.push({ kind: 'stack', ts: e.ts, depth: 0, text: e.text, sev: e.sev || 'dim' });
    }
  } catch (_) { }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, MERGED_MAX);
}

function renderMerged() {
  if (!MF.rows) return;
  const on = MC.tab === 'feed';
  if (MF.rows.hidden === on) MF.rows.hidden = !on;
  // the two source panes are owned by stack-view's applyView, which does not run
  // when only the TAB changed - so their visibility is restored here explicitly
  const fr = $('feed-rows'), afr = $('stack-feed-rows');
  if (on) {
    if (fr && !fr.hidden) fr.hidden = true;
    if (afr && !afr.hidden) afr.hidden = true;
  } else {
    const stack = MC.view === 'stack';
    if (fr && fr.hidden !== stack) fr.hidden = stack;
    if (afr && afr.hidden === stack) afr.hidden = !stack;
  }
  if (!on) return;
  const rows = mergedRows();
  MF.count = rows.length;
  const sig = rows.length + ':' + (rows[0] ? rows[0].ts + rows[0].text : '');
  if (sig === MF.sig) { stampMergedTimes(); return; }
  MF.sig = sig;
  MF.rows.textContent = '';
  if (!rows.length) {
    MF.rows.appendChild(el('div', 'feed-empty', 'nothing has happened yet'));
    return;
  }
  const now = Date.now();
  for (const ev of rows) {
    const row = el('div', 'ev k-' + ev.kind + (ev.sev ? ' sev-' + ev.sev : ''));
    const t = el('span', 'ev-t', MC.util.durShort(now - ev.ts));
    const dcls = 'ev-d' + (ev.kind === 'main' || ev.kind === 'session' ? ' main'
      : ev.depth ? ' d' + Math.min(ev.depth, 3) : '');
    row.appendChild(t);
    row.appendChild(el('span', dcls));
    row.appendChild(el('span', 'ev-k', ev.kind === 'session' ? 'session' : ev.kind));
    row.appendChild(el('span', 'ev-x', ev.text));
    row.dataset.ts = String(ev.ts);
    MF.rows.appendChild(row);
  }
}
function stampMergedTimes() {
  if (!MF.rows || MF.rows.hidden) return;
  const now = Date.now();
  for (const row of MF.rows.children) {
    const ts = Number(row.dataset.ts);
    if (Number.isFinite(ts)) setText(row.firstChild, MC.util.durShort(now - ts));
  }
}

/* the FEED tab's unread pip: rows that arrived while another tab was open */
const BADGE = { el: $('bn-badge'), seen: 0, n: 0 };
function bumpBadge() {
  if (!BADGE.el) return;
  const rows = mergedRows();
  if (MC.tab === 'feed') { BADGE.seen = rows.length ? rows[0].ts : Date.now(); BADGE.n = 0; }
  else BADGE.n = rows.filter((r) => r.ts > BADGE.seen).length;
  const show = BADGE.n > 0 && !!(MC.phone && MC.phone());
  if (BADGE.el.hidden === show) BADGE.el.hidden = !show;
  if (show) setText(BADGE.el, BADGE.n > 99 ? '99+' : String(BADGE.n));
}

/* ============================================================== ALERTS */

const AL = {
  on: lsGet('mc.alerts', '0') === '1',
  blocked: false,
  flag: false,
  blink: false,
  seen: new Map(),
  log: [],
  flash: 0,
  stackStatus: undefined,      // undefined === no snapshot seen yet
  rail: null,                  // Map id -> state, null === no snapshot seen yet
  agentSid: null,
  agentPrev: null,
  running: null,
  burst: { n: 0, out: 0, haveOut: false }
};

const BAD_STATUS = { degraded: 1, down: 1, unreachable: 1 };

function notifySupported() { return typeof window.Notification === 'function'; }

function paintAlertBtn() {
  if (!E.alerts) return;
  E.alerts.setAttribute('aria-pressed', String(AL.on));
  E.alerts.className = 'tgl' + (AL.blocked ? ' blocked' : '');
  setText(E.alerts, AL.blocked ? 'ALERTS BLOCKED' : 'ALERTS');
  E.alerts.title = AL.blocked
    ? 'Notification permission was denied - falling back to title flashing (n)'
    : AL.on ? 'Desktop alerts on (n)' : 'Desktop alerts off (n)';
}

function raiseFlag() {
  AL.flag = true;
  MC.setTitle();
  if (AL.flash || REDUCED.matches) return;
  AL.flash = setInterval(() => {
    if (!AL.flag) { clearInterval(AL.flash); AL.flash = 0; return; }
    AL.blink = !AL.blink;
    MC.setTitle();
  }, 1100);
}
function clearFlag() {
  if (!AL.flag) return;
  AL.flag = false; AL.blink = false;
  if (AL.flash) { clearInterval(AL.flash); AL.flash = 0; }
  MC.setTitle();
}
window.addEventListener('focus', clearFlag);
window.addEventListener('click', clearFlag);

function fire(key, title, body, force) {
  if (!AL.on) return false;
  const now = Date.now();
  if (!force) {
    const last = AL.seen.get(key);
    if (last && now - last < DEDUPE_MS) return false;
  }
  AL.seen.set(key, now);
  AL.log.push({ key: key, title: title, body: body, ts: now });
  if (AL.log.length > 50) AL.log.shift();
  raiseFlag();
  if (!AL.blocked && notifySupported() && window.Notification.permission === 'granted') {
    try { new window.Notification(title, { body: body, tag: key, silent: false }); }
    catch (_) { /* some browsers throw outside a service worker; the title flag still fired */ }
  }
  return true;
}

function setAlerts(v) {
  const next = !!v;
  AL.on = next;
  lsSet('mc.alerts', next ? '1' : '0');
  if (next && notifySupported()) {
    const p = window.Notification.permission;
    if (p === 'denied') AL.blocked = true;
    else if (p === 'granted') AL.blocked = false;
    else {
      try {
        const r = window.Notification.requestPermission((x) => { AL.blocked = x === 'denied'; paintAlertBtn(); });
        if (r && typeof r.then === 'function') {
          r.then((x) => { AL.blocked = x === 'denied'; paintAlertBtn(); }, () => { });
        }
      } catch (_) { }
    }
  } else if (next) {
    AL.blocked = true;     // no Notification API at all -> title flashing only
  }
  if (!next) clearFlag();
  paintAlertBtn();
}

/* --- sources ------------------------------------------------------------ */

function alertStack(snap) {
  if (stackOff()) return;
  const st = (snap && snap.summary && snap.summary.status) || null;
  if (!st) return;
  const h = snap.summary.host;
  const host = (typeof h === 'string' && h.trim()) ? h.trim() : MC.stackLabel;
  if (AL.stackStatus === undefined) { AL.stackStatus = st; return; }   // baseline, never fires
  const prev = AL.stackStatus;
  if (prev === st) return;
  AL.stackStatus = st;
  // one channel, one key: a flapping probe must not machine-gun the desktop
  if (BAD_STATUS[st]) {
    fire('stack-status', MC.stackLabel + ' ' + st.toUpperCase(),
      host + ' went ' + prev + ' → ' + st + '.');
  } else if (st === 'ok' && BAD_STATUS[prev]) {
    fire('stack-status', MC.stackLabel + ' recovered', host + ' is back to ok (was ' + prev + ').');
  }
}

function railwayItems(snap) {
  const out = new Map();
  const groups = (snap && Array.isArray(snap.groups)) ? snap.groups : [];
  for (const g of groups) {
    if (!g || g.id !== 'railway') continue;
    for (const it of (Array.isArray(g.items) ? g.items : [])) {
      if (it && it.id) out.set(it.id, { state: it.state || 'unknown', label: it.label || it.id });
    }
  }
  return out;
}

function alertRail(snap) {
  if (stackOff()) return;
  const cur = railwayItems(snap);
  if (!cur.size) return;
  if (!AL.rail) { AL.rail = cur; return; }             // baseline, never fires
  for (const [id, now] of cur) {
    const was = AL.rail.get(id);
    if (!was || was.state === now.state) continue;
    if (was.state === 'up' && now.state !== 'up') {
      fire('rail:' + id, now.label + ' is ' + String(now.state).toUpperCase(),
        'Deployed service left `up` (' + was.state + ' → ' + now.state + ').');
    } else if (was.state !== 'up' && now.state === 'up') {
      fire('rail:' + id, now.label + ' is back up', 'Deployed service returned to `up` (was ' + was.state + ').');
    }
  }
  AL.rail = cur;
}

function alertAgents(snap) {
  const sid = MC.state.sessionId;
  const sess = (snap && Array.isArray(snap.sessions)) ? snap.sessions.find((x) => x.sessionId === sid) : null;
  if (!sess) return;
  const agents = Array.isArray(sess.agents) ? sess.agents : [];
  const running = agents.length
    ? agents.filter((a) => a.status === 'running' || a.status === 'spawning').length
    : (Number.isFinite(sess.runningCount) ? sess.runningCount : 0);
  const cur = new Map(agents.map((a) => [a.id, a.status]));

  if (AL.agentSid !== sid) {          // a session switch is a fresh baseline
    AL.agentSid = sid; AL.agentPrev = cur; AL.running = running;
    AL.burst = { n: 0, out: 0, haveOut: false };
    return;
  }
  if (AL.agentPrev) {
    for (const a of agents) {
      const p = AL.agentPrev.get(a.id);
      if (p && p !== 'done' && a.status === 'done') {
        AL.burst.n++;
        const o = a.tokens && Number.isFinite(a.tokens.out) ? a.tokens.out : null;
        if (o != null) { AL.burst.out += o; AL.burst.haveOut = true; }
      }
    }
  }
  const prev = AL.running;
  AL.agentPrev = cur;
  AL.running = running;
  if (prev === null) return;

  if (prev === 0 && running > 0) { AL.burst = { n: 0, out: 0, haveOut: false }; return; }
  if (prev > 0 && running === 0 && AL.burst.n > 0) {
    const fmt = MC.util.fmtTokens;
    const body = AL.burst.n + ' agent' + (AL.burst.n === 1 ? '' : 's') + ' finished' +
      (AL.burst.haveOut && fmt ? '  ·  ' + fmt(AL.burst.out) + ' out' : '') + '.';
    fire('fanout:' + sid, 'Fan-out complete', body);
    AL.burst = { n: 0, out: 0, haveOut: false };
  }
}

/* ============================================================== WIRING */

MC.on('stack', (snap) => { if (stackOff()) return; noteStack(snap); alertStack(snap); renderMerged(); bumpBadge(); });
/* bands painted before /api/health answered come down once it says "off" */
if (MC.modulesReady && typeof MC.modulesReady.then === 'function') {
  MC.modulesReady.then(() => { if (stackOff()) { renderRailBands(); showStrip(); } });
}
MC.on('infra', (snap) => { renderRailBands(); alertRail(snap); });
MC.on('agents', (snap) => { alertAgents(snap); renderMerged(); bumpBadge(); });
MC.on('view', () => { renderAll(); hideTip(); fetchHistory(); });
MC.on('tab', () => { renderAll(); renderMerged(); bumpBadge(); });
MC.on('phone', () => { renderAll(); renderMerged(); bumpBadge(); });
/* the 1s clock owns relative times everywhere else; keep the merged list on it */
MC.on('tick', () => { stampMergedTimes(); });

if (E.alerts) E.alerts.addEventListener('click', () => setAlerts(!AL.on));

document.addEventListener('keydown', (e) => {
  const ae = document.activeElement;
  if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.toLowerCase() !== 'n') return;
  setAlerts(!AL.on);
  e.preventDefault();
});

/* ============================================================== EXPORTS */

MC.history = {
  apply: applyHistory,
  drop: dropHistory,
  rebase: rebase,
  loadFixture: loadFixture,
  refresh: fetchHistory,
  data: () => H.data,
  available: () => !!H.data,
  buckets: () => (H.data ? H.data.n : 0),
  collecting: () => !!H.empty,
  noteStack: noteStack
};

MC.alerts = {
  set: setAlerts,
  toggle: () => setAlerts(!AL.on),
  enabled: () => AL.on,
  blocked: () => AL.blocked,
  /* app.js reads this every second to build the document title. The blink
     half-cycle turns the prefix off; the flag itself survives until focus. */
  get flag() { return !!AL.flag && !AL.blink; },
  raised: () => !!AL.flag,
  log: () => AL.log.slice(),
  reset: () => { AL.seen.clear(); AL.log = []; },
  test: () => fire('test', 'Mission Control', 'Alert channel test · ' + localClock(Date.now()), true)
};

/* ============================================================== GO */

paintAlertBtn();
renderAll();
renderMerged();
bumpBadge();
fetchHistory();
H.poll = setInterval(fetchHistory, POLL_MS);

})();
