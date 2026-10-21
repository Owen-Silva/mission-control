/* =============================================================================
   MISSION CONTROL - STACK view
   A live system map of the configured app: edge -> runtime -> app -> deps,
   a "this machine" band, and a 24h jobs timeline.

   Loaded after app.js. Everything it needs from app.js arrives through the
   window.MC bridge - no reaching into app.js internals.
   ============================================================================= */
'use strict';

(function () {

const MC = window.MC;
if (!MC) return;                       // app.js failed to load; nothing to hang off

const { $, el, svgEl, setText, clamp, lsGet, lsSet, parseTs, rel, durShort, trunc } = MC.util;
const D = MC.D;
const REDUCED = MC.REDUCED;

/* ------------------------------------------------------------------ const */

const SVGNS = 'http://www.w3.org/2000/svg';
const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 30000;
/* how long boot waits for /api/health to say whether the stack module is on;
   past this it carries on exactly as a server without modules would */
const MODULES_WAIT_MS = 1500;

/* Map geometry. Sized so the whole map still fits a 1280-wide window next to
   the 340px rail; wider windows just scale it up to a cap. */
const G = {
  PILL_W: 136,      // main tier pill
  LOC_W: 114,       // the "this machine" band is narrower - short labels
  PILL_H: 29,
  VGAP: 5,
  SUB_GAP: 8,       // between sub-columns of the SAME tier
  TIER_GAP: 22,     // between tiers
  HEAD_H: 22,       // column header band above the first pill
  PAD_X: 14,
  PAD_TOP: 26,      // room for the deploy arch and its label
  PAD_BOT: 14,
  LANE_GAP: 5,      // stagger between bottom-lane routes
  K_MIN: 0.34,
  K_MAX: 5
};

const STATES = ['up', 'degraded', 'down', 'armed', 'idle', 'hold', 'disabled', 'wired', 'unknown'];
const FLOW_STATES = { up: 1, armed: 1 };
const SOLID_KINDS = { runs: 1, serves: 1 };

/* jobs live on the timeline strip, not in the column map */
const TIMELINE_TIER = 'jobs';
/* the local band gets a dotted divider and a narrower pill - emphasis only,
   every other tier id (known or not) lays out identically */
const LOCAL_TIER = 'local';

/* ------------------------------------------------------------------ dom */

const A = {
  svg: $('stack-svg'), vp: $('a-viewport'),
  lCols: $('a-cols'), lEdges: $('a-edges'), lFlow: $('a-flow'), lNodes: $('a-nodes'),
  stage: $('graph-stage'),
  tabs: $('viewtabs'), tabAgents: $('tab-agents'), tabStack: $('tab-stack'),
  selWrap: $('sel-wrap'), counters: $('counters'), toggles: $('toggles'),
  legend: $('legend'), stackLegend: $('stack-legend'),
  panelTitle: $('panel-title'), graphSub: $('graph-sub'),
  chips: $('stack-chips'),
  chStatus: $('ach-status'), chRole: $('ach-role'), chProd: $('ach-prod'),
  chLocal: $('ach-local'), chLatency: $('ach-latency'), chIncidents: $('ach-incidents'),
  chScan: $('ach-scan'),
  fixtureChip: $('stack-fixture-chip'),
  chipbar: $('stack-chipbar'), tierStrip: $('stack-tierstrip'), scanline: $('stack-scanline'),
  hint: $('hint'), stackHint: $('stack-hint'),
  focusChip: $('focus-chip'), emptyNote: $('empty-note'),
  timeline: $('stack-timeline'), tlIvals: $('atl-ivals'), tlNote: $('atl-note'),
  tlAxis: $('atl-axis'), tlTicks: $('atl-ticks'), tlMarks: $('atl-marks'),
  tlLater: $('atl-later'), tlList: $('atl-list'), help: $('stack-help'),
  list: $('stack-list'),
  feedRows: $('feed-rows'), feedRowsStack: $('stack-feed-rows'),
  feedEmpty: $('stack-feed-empty'), feedTitle: $('feed-title'), feedCount: $('feed-count'),
  tooltip: $('tooltip'), detail: $('detail')
};

/* ------------------------------------------------------------------ state */

const S = {
  snap: null,           // last applied stack snapshot
  prev: null,           // previous snapshot, for the feed diff
  at: 0,                // local ms the snapshot landed
  fixture: false,
  live: false,          // an SSE stack frame has arrived at least once
  off: false,           // the server said the stack module is disabled
  pinned: null,
  hover: null,
  hoverXY: null,
  layoutSig: '',
  boxes: new Map(),     // id -> {x,y,w,h,cx,cy,node}
  cols: [],             // [{tier, label, subs:[[node,...]], x0, x1}]
  content: { w: 0, h: 0 },
  nodeEls: new Map(),
  edgeEls: [],
  tlEls: new Map(),
  tlListEls: new Map(),
  listEls: new Map(),
  poll: 0
};

const av = { x: 0, y: 0, k: 1, user: false };

/* ============================================================== UTIL */

function short(id) { return String(id || '').replace(/^(edge|rt|app|dep|job|loc)-/, ''); }

/* `hidden` is an HTMLElement property - assigning it on an <svg> silently
   creates an expando and never touches the attribute the CSS is matching on.
   Everything here goes through the attribute so HTML and SVG behave alike. */
/* The deployed origin's host as the server reports it (summary.host); a
   snapshot without one reads as plain "Stack". */
function stackHost(snap) {
  const h = snap && snap.summary && snap.summary.host;
  return (typeof h === 'string' && h.trim()) ? h.trim() : MC.stackLabel;
}

function show(node, visible) {
  if (!node) return;
  if (visible) node.removeAttribute('hidden');
  else node.setAttribute('hidden', '');
}
function nodesOf(s) { return (s && Array.isArray(s.nodes)) ? s.nodes : []; }
function edgesOf(s) { return (s && Array.isArray(s.edges)) ? s.edges : []; }

/* A monospace glyph is ~0.6em wide, which is close enough to budget characters
   without laying the text out first. */
function fit(str, px, fontPx) {
  const n = Math.max(3, Math.floor(px / (fontPx * 0.6)));
  return trunc(String(str == null ? '' : str), n);
}

function fmtEvery(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  if (ms < 60000) return Math.round(ms / 1000) + ' s';
  if (ms < 3600000) return Math.round(ms / 60000) + ' min';
  if (ms < DAY_MS) return Math.round(ms / 3600000) + ' h';
  return Math.round(ms / DAY_MS) + ' d';
}
/* countdown, always positive-looking: "in 6h 12m" / "in 42s" / "due" */
function fmtIn(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms <= 0) return 'due';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'in ' + s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return 'in ' + m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return 'in ' + h + 'h ' + (m % 60) + 'm';
  return 'in ' + Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}
function utcHM(ms) { return new Date(ms).toISOString().slice(11, 16); }
function localHM(ms) {
  try {
    return new Date(ms).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch (_) { return utcHM(ms); }
}
function utcFull(ms) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
/* Mon / Tue / ... in UTC, to match the Z time it is printed next to */
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function utcDay(ms) { return DOW[new Date(ms).getUTCDay()]; }
function localFull(ms) {
  try {
    return new Date(ms).toLocaleString('en-US',
      { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' local';
  } catch (_) { return ''; }
}

/* ============================================================== CRON */

/* Enough of cron to resolve the next fire time: lists, ranges and steps on all
   five fields. Used for the fixture, and for real jobs that arrive carrying an
   expression but no nextRunUtc. */
function cronField(f, v, max) {
  if (f === '*') return true;
  const parts = String(f).split(',');
  for (const part of parts) {
    let body = part, step = 1;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      body = part.slice(0, slash);
      step = parseInt(part.slice(slash + 1), 10);
      if (!(step > 0)) continue;
    }
    let lo, hi;
    if (body === '*' || body === '') { lo = 0; hi = max; }
    else if (body.indexOf('-') > 0) {
      const r = body.split('-'); lo = Number(r[0]); hi = Number(r[1]);
    } else { lo = Number(body); hi = slash >= 0 ? max : lo; }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    if (v >= lo && v <= hi && (v - lo) % step === 0) return true;
  }
  return false;
}

function cronNext(expr, fromMs) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length < 5) return NaN;
  let t = Math.ceil((fromMs + 1000) / 60000) * 60000;   // next whole minute
  for (let i = 0; i < 1440 * 8; i++) {
    const d = new Date(t);
    if (cronField(f[0], d.getUTCMinutes(), 59) &&
        cronField(f[1], d.getUTCHours(), 23) &&
        cronField(f[2], d.getUTCDate(), 31) &&
        cronField(f[3], d.getUTCMonth() + 1, 12) &&
        cronField(f[4], d.getUTCDay(), 6)) return t;
    t += 60000;
  }
  return NaN;
}

/* ============================================================== NORMALISE */

/* Fill in whatever the producer left out, so the renderer can assume the
   fields it draws. Never invents state - an unknown state stays 'unknown'. */
function normalise(snap) {
  if (!snap || typeof snap !== 'object') return null;
  const now = Date.now();
  if (!Array.isArray(snap.tiers)) snap.tiers = [];
  if (!Array.isArray(snap.nodes)) snap.nodes = [];
  if (!Array.isArray(snap.edges)) snap.edges = [];
  if (!snap.summary || typeof snap.summary !== 'object') snap.summary = {};

  const seen = new Set(snap.tiers.map((t) => t && t.id));
  for (const n of snap.nodes) {
    if (!n || !n.id) continue;
    if (STATES.indexOf(n.state) < 0) n.state = 'unknown';
    if (!n.tier) n.tier = 'unknown';
    if (!n.label) n.label = short(n.id);
    if (!n.meta || typeof n.meta !== 'object') n.meta = {};
    if (!seen.has(n.tier)) { seen.add(n.tier); snap.tiers.push({ id: n.tier, label: n.tier }); }
    const m = n.meta;
    // A job that carries an expression but no nextRunUtc and no everyMs is one
    // the producer knows never fires (a cron that is never started). Only
    // resolve an expression for a job it says is actually live.
    if (!m.nextRunUtc && m.expr && (n.state === 'armed' || n.state === 'up')) {
      const nx = cronNext(m.expr, now);
      if (Number.isFinite(nx)) m.nextRunUtc = new Date(nx).toISOString();
    }
    if (m.nextRunUtc) {
      const t = parseTs(m.nextRunUtc);
      if (Number.isFinite(t)) m.inMs = t - now;
    }
  }
  return snap;
}

/* The fixture is a fixed instant on disk. Re-base it onto now so countdowns,
   ages and the timeline all read live - and so the cron expressions and the
   times shown next to them still agree with each other. */
function rehydrate(snap) {
  const now = Date.now();
  const gen = parseTs(snap.generatedAt);
  const delta = Number.isFinite(gen) ? (now - 12000 - gen) : 0;
  const shift = (iso) => {
    const t = parseTs(iso);
    return Number.isFinite(t) ? new Date(t + delta).toISOString() : iso;
  };
  snap.generatedAt = shift(snap.generatedAt);
  if (snap.summary) snap.summary.deployedAt = shift(snap.summary.deployedAt);
  for (const n of snap.nodes) {
    const m = n.meta;
    if (!m || typeof m !== 'object') continue;
    for (const k of ['lastCommitAt', 'lastFetchAt', 'lastRunAt', 'lastOkAt', 'since', 'pausedAt']) {
      if (typeof m[k] === 'string') m[k] = shift(m[k]);
    }
    if (m.expr && (n.state === 'armed' || n.state === 'up')) {
      const nx = cronNext(m.expr, now);
      if (Number.isFinite(nx)) { m.nextRunUtc = new Date(nx).toISOString(); m.inMs = nx - now; }
    } else if (m.nextRunUtc) {
      m.nextRunUtc = shift(m.nextRunUtc);
      m.inMs = parseTs(m.nextRunUtc) - now;
    }
  }
  snap.fromFixture = true;
  return snap;
}

/* ============================================================== LAYOUT */

/* Sub-columns are laid out left to right, so a tier that is too tall for the
   panel becomes two narrow stacks under one header rather than one long one. */
function buildColumns(snap) {
  const order = [];
  const byTier = new Map();
  for (const t of snap.tiers) {
    if (!t || !t.id || t.id === TIMELINE_TIER) continue;
    order.push(t); byTier.set(t.id, []);
  }
  for (const n of snap.nodes) {
    if (n.tier === TIMELINE_TIER) continue;
    if (!byTier.has(n.tier)) { byTier.set(n.tier, []); order.push({ id: n.tier, label: n.tier }); }
    byTier.get(n.tier).push(n);
  }

  const cols = [];
  for (const t of order) {
    const list = byTier.get(t.id) || [];
    if (!list.length) continue;
    cols.push({ tier: t.id, label: t.label || t.id, nodes: list, subs: [], w: t.id === LOCAL_TIER ? G.LOC_W : G.PILL_W });
  }
  return cols;
}

/* Forward/backward barycentre sweeps over an ordered list of node groups.
   Used twice: once over the tiers to get a sane global order, then again over
   the sub-columns once the tiers have been split. Returns the new groups. */
function barycentre(groups, edges, passes) {
  const colOf = new Map();
  groups.forEach((g, i) => g.forEach((n) => colOf.set(n.id, i)));

  const nbr = new Map();   // id -> [{id, col}]
  for (const e of edges) {
    if (!colOf.has(e.from) || !colOf.has(e.to)) continue;
    if (!nbr.has(e.from)) nbr.set(e.from, []);
    if (!nbr.has(e.to)) nbr.set(e.to, []);
    nbr.get(e.from).push({ id: e.to, col: colOf.get(e.to) });
    nbr.get(e.to).push({ id: e.from, col: colOf.get(e.from) });
  }

  const out = groups.slice();
  const idx = new Map();
  const reindex = () => { out.forEach((g) => g.forEach((n, i) => idx.set(n.id, i))); };
  reindex();

  const sweep = (dir) => {
    for (let s = 0; s < out.length; s++) {
      const ci = dir > 0 ? s : out.length - 1 - s;
      const key = new Map();
      out[ci].forEach((n, i) => {
        const list = (nbr.get(n.id) || []).filter((x) => (dir > 0 ? x.col < ci : x.col > ci));
        if (!list.length) { key.set(n.id, i); return; }
        let sum = 0;
        for (const x of list) sum += (idx.get(x.id) || 0);
        key.set(n.id, sum / list.length);
      });
      out[ci] = out[ci]
        .map((n, i) => ({ n, i, k: key.get(n.id) }))
        .sort((a, b) => (a.k - b.k) || (a.i - b.i))
        .map((x) => x.n);
      reindex();
    }
  };
  for (let p = 0; p < (passes || 1); p++) { sweep(1); sweep(-1); }
  sweep(1);
  return out;
}

/* Splitting a tall tier down the middle of its list draws every deps-bound edge
   straight through the second sub-column. Split by edge direction instead:
   anything wired to a later tier goes on the RIGHT, so those edges leave from
   the outer face and the purely internal nodes sit on the left. */
function splitSubs(cols, edges, rowCap) {
  const tierOf = new Map();
  cols.forEach((c, i) => c.nodes.forEach((n) => tierOf.set(n.id, i)));

  for (let ci = 0; ci < cols.length; ci++) {
    const c = cols[ci];
    const n = c.nodes.length;
    const subs = Math.max(1, Math.ceil(n / rowCap));
    if (subs === 1) { c.subs = [c.nodes.slice()]; continue; }

    if (subs === 2) {
      const fwd = new Set();
      for (const e of edges) {
        const a = tierOf.get(e.from), b = tierOf.get(e.to);
        if (a === ci && b > ci) fwd.add(e.from);
        if (b === ci && a > ci) fwd.add(e.to);   // an inbound edge from the right argues the same way
      }
      const left = c.nodes.filter((x) => !fwd.has(x.id));
      const right = c.nodes.filter((x) => fwd.has(x.id));
      // a 13/1 split is worse than no split at all - only take it if both
      // sides are a real column
      if (left.length >= 2 && right.length >= 2) { c.subs = [left, right]; continue; }
    }

    const rows = Math.ceil(n / subs);
    c.subs = [];
    for (let i = 0; i < subs; i++) {
      const s = c.nodes.slice(i * rows, (i + 1) * rows);
      if (s.length) c.subs.push(s);
    }
  }
}

/* Re-sort inside each sub-column now that the sub-columns are the real layout
   columns - otherwise the split undoes the tier-level ordering. */
function orderSubs(cols, edges) {
  const groups = [], slot = [];
  for (const c of cols) c.subs.forEach((s, si) => { groups.push(s); slot.push([c, si]); });
  const out = barycentre(groups, edges, 2);
  out.forEach((g, i) => { slot[i][0].subs[slot[i][1]] = g; });
}

function placeColumns(cols) {
  const pitch = G.PILL_H + G.VGAP;
  let maxRows = 1;
  for (const c of cols) for (const s of c.subs) maxRows = Math.max(maxRows, s.length);
  const bodyH = maxRows * pitch - G.VGAP;
  const top = G.PAD_TOP + G.HEAD_H;

  const boxes = new Map();
  let x = G.PAD_X, sub = 0;
  for (let ci = 0; ci < cols.length; ci++) {
    const c = cols[ci];
    c.x0 = x;
    for (let si = 0; si < c.subs.length; si++) {
      const list = c.subs[si];
      const subH = list.length * pitch - G.VGAP;
      // centred, but never above the header band
      const y0 = Math.max(top, top + (bodyH - subH) / 2);
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        const b = {
          x: x, y: y0 + i * pitch, w: c.w, h: G.PILL_H,
          node: n, tier: c.tier, tierIdx: ci, col: sub
        };
        b.cx = b.x + b.w / 2; b.cy = b.y + b.h / 2;
        boxes.set(n.id, b);
      }
      x += c.w + (si < c.subs.length - 1 ? G.SUB_GAP : 0);
      sub++;
    }
    c.x1 = x;
    if (ci < cols.length - 1) x += G.TIER_GAP;
  }

  return { boxes, w: x + G.PAD_X, bodyBottom: top + bodyH, h: top + bodyH + G.PAD_BOT };
}

/* Try every sensible sub-column cap and keep the one that fits the panel best.
   A 16-node App tier next to a 14-node Deps tier wants a different split at
   1280 than it does at 1680, and the payload shape changes under us anyway. */
function layoutBest(cols, edges, sw, sh) {
  let most = 1;
  for (const c of cols) most = Math.max(most, c.nodes.length);
  let best = null;
  // A payload whose tallest tier is a single node used to leave the loop body
  // unentered and then dereference a null `best`. Clamp the lower bound so the
  // range is never empty; on any real payload this is the same start as before.
  const lo = Math.min(most, Math.max(2, Math.ceil(most / 3)));
  for (let cap = lo; cap <= most; cap++) {
    splitSubs(cols, edges, cap);
    orderSubs(cols, edges);
    const p = placeColumns(cols);
    const k = Math.min(G.K_MAX, Math.min(sw / p.w, sh / p.h));
    // ties go to the wider cap: fewer columns, less ink
    if (!best || k > best.k + 0.001) {
      best = { k: k, cap: cap, subs: cols.map((c) => c.subs.map((s) => s.slice())) };
    }
  }
  cols.forEach((c, i) => { c.subs = best.subs[i]; });
  return placeColumns(cols);
}

/* ============================================================== EDGE PATHS */

function isArch(a, b, kind) {
  return kind === 'deploys' || (a.tier === LOCAL_TIER && b.tier !== LOCAL_TIER);
}
function isLongHop(a, b, kind) {
  return !isArch(a, b, kind) && Math.abs(b.tierIdx - a.tierIdx) >= 2;
}

function edgePath(a, b, kind, lane) {
  if (isArch(a, b, kind)) {
    // the push pipe: arch it over the whole map instead of dragging a line
    // right-to-left through four columns of pills
    const y = G.PAD_TOP - 20;
    return 'M' + a.cx.toFixed(1) + ' ' + a.y.toFixed(1) +
      'C' + a.cx.toFixed(1) + ' ' + y.toFixed(1) + ',' +
      b.cx.toFixed(1) + ' ' + y.toFixed(1) + ',' +
      b.cx.toFixed(1) + ' ' + b.y.toFixed(1);
  }

  // An edge that skips a whole tier would otherwise be dragged through every
  // pill in between. Route it down, flat along a lane under the lowest row,
  // then back up - a swooping bezier across that span reads as noise.
  if (isLongHop(a, b, kind)) {
    const y = S.laneY + (lane || 0) * G.LANE_GAP;
    const right = b.tierIdx > a.tierIdx;
    const x1 = right ? a.x + a.w : a.x;
    const x2 = right ? b.x : b.x + b.w;
    const dir = right ? 1 : -1;
    const ax = x1 + dir * 26, bx = x2 - dir * 26;
    const f = (v) => v.toFixed(1);
    if ((bx - ax) * dir <= 8) {          // too short for a flat run
      return 'M' + f(x1) + ' ' + f(a.cy) + 'C' + f(x1 + dir * 30) + ' ' + f(y) + ',' +
        f(x2 - dir * 30) + ' ' + f(y) + ',' + f(x2) + ' ' + f(b.cy);
    }
    return 'M' + f(x1) + ' ' + f(a.cy) +
      'C' + f(x1 + dir * 14) + ' ' + f(a.cy) + ',' + f(ax) + ' ' + f(y) + ',' + f(ax) + ' ' + f(y) +
      'L' + f(bx) + ' ' + f(y) +
      'C' + f(bx) + ' ' + f(y) + ',' + f(x2 - dir * 14) + ' ' + f(b.cy) + ',' + f(x2) + ' ' + f(b.cy);
  }

  const fwd = b.x - (a.x + a.w);
  if (fwd > 14) {
    const x1 = a.x + a.w, x2 = b.x, dx = Math.max(26, (x2 - x1) * 0.55);
    return 'M' + x1.toFixed(1) + ' ' + a.cy.toFixed(1) +
      'C' + (x1 + dx).toFixed(1) + ' ' + a.cy.toFixed(1) + ',' +
      (x2 - dx).toFixed(1) + ' ' + b.cy.toFixed(1) + ',' +
      x2.toFixed(1) + ' ' + b.cy.toFixed(1);
  }
  const back = a.x - (b.x + b.w);
  if (back > 14) {
    const x1 = a.x, x2 = b.x + b.w, dx = Math.max(26, (x1 - x2) * 0.55);
    return 'M' + x1.toFixed(1) + ' ' + a.cy.toFixed(1) +
      'C' + (x1 - dx).toFixed(1) + ' ' + a.cy.toFixed(1) + ',' +
      (x2 + dx).toFixed(1) + ' ' + b.cy.toFixed(1) + ',' +
      x2.toFixed(1) + ' ' + b.cy.toFixed(1);
  }
  // same (or overlapping) column: loop out to the left
  const off = 30 + Math.abs(b.cy - a.cy) * 0.07;
  return 'M' + a.x.toFixed(1) + ' ' + a.cy.toFixed(1) +
    'C' + (a.x - off).toFixed(1) + ' ' + a.cy.toFixed(1) + ',' +
    (b.x - off).toFixed(1) + ' ' + b.cy.toFixed(1) + ',' +
    b.x.toFixed(1) + ' ' + b.cy.toFixed(1);
}

/* ============================================================== RENDER MAP */

function stateMark(state) {
  const g = svgEl('g', { class: 'a-mark' });
  if (state === 'armed') {
    g.appendChild(svgEl('path', { class: 'a-dia', d: 'M0 -4.4L4.4 0L0 4.4L-4.4 0Z' }));
  } else if (state === 'hold') {
    g.appendChild(svgEl('rect', { class: 'a-bar', x: -3.2, y: -4, width: 2, height: 8, rx: 0.6 }));
    g.appendChild(svgEl('rect', { class: 'a-bar', x: 1.2, y: -4, width: 2, height: 8, rx: 0.6 }));
  } else if (state === 'unknown') {
    const t = svgEl('text', { class: 'a-qm', x: 0, y: 3.4, 'text-anchor': 'middle' });
    t.textContent = '?';
    g.appendChild(t);
  } else {
    g.appendChild(svgEl('circle', { class: 'a-dot', cx: 0, cy: 0, r: 3.6 }));
  }
  return g;
}

function nodeTitle(n) {
  const parts = [n.label || n.id, 'state: ' + n.state];
  if (n.detail) parts.push(n.detail);
  if (n.sub) parts.push(n.sub);
  if (n.source) parts.push('source: ' + n.source);
  return parts.join('\n');
}

function renderMap(structural) {
  const snap = S.snap;
  if (!snap) return;

  if (structural) {
    A.lCols.textContent = '';
    A.lEdges.textContent = '';
    A.lFlow.textContent = '';
    A.lNodes.textContent = '';
    S.nodeEls = new Map();
    S.edgeEls = [];
    S.deployLabel = null;

    // column headers + the dotted divider in front of the local band
    for (const c of S.cols) {
      const t = svgEl('text', {
        class: 'a-colhead', x: ((c.x0 + c.x1) / 2).toFixed(1), y: (G.PAD_TOP + 12).toFixed(1),
        'text-anchor': 'middle'
      });
      t.textContent = String(c.label || c.tier).toUpperCase();
      A.lCols.appendChild(t);
      if (c.tier === LOCAL_TIER) {
        A.lCols.appendChild(svgEl('line', {
          class: 'a-divider',
          x1: (c.x0 - G.TIER_GAP / 2).toFixed(1), y1: (G.PAD_TOP - 4).toFixed(1),
          x2: (c.x0 - G.TIER_GAP / 2).toFixed(1), y2: (S.content.h - 4).toFixed(1)
        }));
      }
    }

    // edges under the nodes
    const byId = S.boxes;
    let slot = 0;
    for (const e of edgesOf(snap)) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const kind = e.kind || 'uses';
      const lane = isLongHop(a, b, kind) ? (slot++ % 4) : 0;
      const d = edgePath(a, b, kind, lane);
      const p = svgEl('path', { class: 'a-edge k-' + kind, d: d });
      A.lEdges.appendChild(p);
      let flow = null;
      if (!REDUCED.matches) {
        flow = svgEl('path', { class: 'a-flowline k-' + kind, d: d });
        A.lFlow.appendChild(flow);
      }
      S.edgeEls.push({ e, p, flow, kind });
      if (kind === 'deploys') {
        const lab = svgEl('text', { class: 'a-edgelabel', x: ((a.cx + b.cx) / 2).toFixed(1), y: (G.PAD_TOP - 12).toFixed(1), 'text-anchor': 'middle' });
        lab.textContent = '';
        A.lEdges.appendChild(lab);
        S.deployLabel = lab;
      }
    }

    // nodes
    for (const [id, b] of S.boxes) {
      const n = b.node;
      const g = svgEl('g', { class: 'a-node' });
      g.dataset.id = id;
      g.setAttribute('transform', 'translate(' + b.x.toFixed(1) + ' ' + b.y.toFixed(1) + ')');
      const pill = svgEl('rect', { class: 'a-pill', x: 0, y: 0, width: b.w, height: b.h, rx: 5 });
      const mark = stateMark(n.state);
      mark.setAttribute('transform', 'translate(11 ' + (b.h / 2).toFixed(1) + ')');
      const lab = svgEl('text', { class: 'a-lab', x: 21, y: 12.5 });
      const det = svgEl('text', { class: 'a-det', x: 21, y: 22.5 });
      const title = document.createElementNS(SVGNS, 'title');
      const hit = svgEl('rect', { class: 'a-hit', x: -2, y: -2, width: b.w + 4, height: b.h + 4 });
      g.appendChild(pill); g.appendChild(mark); g.appendChild(lab); g.appendChild(det);
      g.appendChild(title); g.appendChild(hit);
      A.lNodes.appendChild(g);
      S.nodeEls.set(id, { g, pill, mark, lab, det, title, state: '', cls: '' });
    }
  }

  // per-snapshot refresh
  for (const [id, e] of S.nodeEls) {
    const b = S.boxes.get(id);
    if (!b) continue;
    const n = b.node;
    if (e.state !== n.state) {
      const m = stateMark(n.state);
      m.setAttribute('transform', 'translate(11 ' + (b.h / 2).toFixed(1) + ')');
      e.g.replaceChild(m, e.mark);
      e.mark = m;
      e.state = n.state;
    }
    setText(e.lab, fit(n.label, b.w - 28, 9.5));
    setText(e.det, fit(n.detail || n.sub || '', b.w - 26, 7.5));
    setText(e.title, nodeTitle(n));
    let cls = 'a-node st-' + n.state;
    if (id === S.pinned) cls += ' sel';
    if (id === S.hover) cls += ' hov';
    if (e.cls !== cls) { e.g.setAttribute('class', cls); e.cls = cls; }
  }

  for (const rec of S.edgeEls) {
    const a = S.boxes.get(rec.e.from), b = S.boxes.get(rec.e.to);
    const flowing = !!(a && b && FLOW_STATES[a.node.state] && FLOW_STATES[b.node.state]);
    const cls = 'a-edge k-' + rec.kind + (flowing ? ' flowing' : '');
    if (rec.p.getAttribute('class') !== cls) rec.p.setAttribute('class', cls);
    if (rec.flow) {
      const fcls = 'a-flowline k-' + rec.kind + (flowing ? ' on' : '');
      if (rec.flow.getAttribute('class') !== fcls) rec.flow.setAttribute('class', fcls);
    }
  }

  if (S.deployLabel) {
    const un = snap.summary && snap.summary.unshipped;
    setText(S.deployLabel, un > 0 ? 'push main:master  ·  ' + un + ' unshipped' : 'push main:master');
    S.deployLabel.setAttribute('class', 'a-edgelabel' + (un > 0 ? ' hot' : ''));
  }
}

/* ============================================================== PHONE LIST */

/* A five-column dependency map on a 390px screen is a smear. The same graph
   becomes a vertical list of collapsible tiers with a wrapping grid of node
   pills - the edges move onto the detail sheet as "connects to". */

const COLLAPSED_KEY = 'mc.stackTiers';

function collapsedSet() {
  try {
    const raw = lsGet(COLLAPSED_KEY, '');
    return new Set(raw ? String(raw).split(',').filter(Boolean) : []);
  } catch (_) { return new Set(); }
}
function saveCollapsed(set) { lsSet(COLLAPSED_KEY, Array.from(set).join(',')); }

function renderStackList(force) {
  if (!A.list) return;
  const on = !!(MC.phone && MC.phone()) && MC.view === 'stack';
  show(A.list, on);
  const snap = S.snap;
  if (!on || !snap) return;

  // tier order follows the payload; unknown tiers were already appended by
  // normalise(), and jobs live on the timeline strip, not here
  const byTier = new Map();
  for (const n of nodesOf(snap)) {
    if (n.tier === TIMELINE_TIER) continue;
    if (!byTier.has(n.tier)) byTier.set(n.tier, []);
    byTier.get(n.tier).push(n);
  }
  const tiers = snap.tiers.filter((t) => t && t.id !== TIMELINE_TIER && byTier.has(t.id));

  const sig = tiers.map((t) => t.id + ':' + byTier.get(t.id).map((n) => n.id).join('.')).join('|');
  const collapsed = collapsedSet();

  if (force || A.list.dataset.sig !== sig) {
    A.list.dataset.sig = sig;
    A.list.textContent = '';
    S.listEls = new Map();
    for (const t of tiers) {
      const list = byTier.get(t.id);
      const sec = el('section', 'tsec');
      sec.dataset.tier = t.id;
      const open = !collapsed.has(t.id);
      sec.setAttribute('aria-collapsed', String(!open));

      const head = el('button', 'tsec-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', String(open));
      head.appendChild(el('span', 'tsec-name', String(t.label || t.id).toUpperCase()));
      const nEl = el('span', 'tsec-n', String(list.length));
      const badEl = el('span', 'tsec-bad', '');
      head.appendChild(nEl); head.appendChild(badEl);
      head.appendChild(el('span', 'tsec-caret', '▸'));

      const body = el('div', 'tsec-body');
      const pills = new Map();
      for (const n of list) {
        const p = el('button', 'npill st-' + n.state);
        p.type = 'button';
        p.dataset.id = n.id;
        p.appendChild(el('span', 'np-dot'));
        p.appendChild(el('span', 'np-lab', n.label || short(n.id)));
        body.appendChild(p);
        pills.set(n.id, p);
      }
      sec.appendChild(head); sec.appendChild(body);
      A.list.appendChild(sec);
      S.listEls.set(t.id, { sec, head, n: nEl, bad: badEl, body, pills });
    }
  }

  // per-snapshot refresh: state classes, counts, the bad badge
  for (const t of tiers) {
    const e = S.listEls && S.listEls.get(t.id);
    if (!e) continue;
    let bad = 0;
    for (const n of byTier.get(t.id)) {
      const p = e.pills.get(n.id);
      if (!p) continue;
      if (n.state === 'down' || n.state === 'degraded') bad++;
      const cls = 'npill st-' + n.state + (n.id === S.pinned ? ' sel' : '');
      if (p.className !== cls) p.className = cls;
      setText(p.querySelector('.np-lab'), n.label || short(n.id));
      p.title = tipFor(n);
    }
    setText(e.n, String(byTier.get(t.id).length));
    setText(e.bad, bad ? String(bad) : '');
    e.bad.hidden = bad === 0;
  }
}

if (A.list) {
  A.list.addEventListener('click', (e) => {
    const head = e.target.closest && e.target.closest('.tsec-head');
    if (head) {
      const sec = head.parentNode;
      const open = head.getAttribute('aria-expanded') !== 'true';
      head.setAttribute('aria-expanded', String(open));
      sec.setAttribute('aria-collapsed', String(!open));
      const set = collapsedSet();
      if (open) set.delete(sec.dataset.tier); else set.add(sec.dataset.tier);
      saveCollapsed(set);
      return;
    }
    const pill = e.target.closest && e.target.closest('.npill');
    if (pill && pill.dataset.id) {
      const b = S.boxes.get(pill.dataset.id);
      const node = b ? b.node : nodesOf(S.snap).find((n) => n.id === pill.dataset.id);
      if (!node) return;
      S.pinned = pill.dataset.id;
      for (const [, e2] of S.nodeEls) e2.g.classList.toggle('sel', e2 === S.nodeEls.get(S.pinned));
      fillStackDetail(node);
      renderStackList(false);
    }
  });
}

/* ============================================================== VIEW BOX */

function fitStack() {
  const w = A.stage.clientWidth || 900, h = A.stage.clientHeight || 500;
  A.svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  if (av.user || !S.content.w) { applyAView(); return; }
  const k = clamp(G.K_MIN, Math.min(w / S.content.w, h / S.content.h), 1.25);
  av.k = k;
  av.x = (w - S.content.w * k) / 2;
  av.y = (h - S.content.h * k) / 2;
  applyAView();
}
function applyAView() {
  A.vp.setAttribute('transform',
    'translate(' + av.x.toFixed(2) + ' ' + av.y.toFixed(2) + ') scale(' + av.k.toFixed(4) + ')');
}
function resetStackView() { av.user = false; fitStack(); }

/* ============================================================== CHIPS */

function chip(node, value, tone) {
  if (!node) return;
  const b = node.querySelector('b');
  if (b) setText(b, value);
  const cls = 'achip' + (node.id === 'ach-scan' ? ' achip-scan' : '') + (tone ? ' tone-' + tone : '');
  if (node.className !== cls) node.className = cls;
}

function statusTone(st) {
  return st === 'ok' ? 'ok' : st === 'degraded' ? 'warn' : st === 'down' ? 'bad'
    : st === 'unreachable' ? 'bad' : 'dim';
}
function statusGlyph(st) {
  return st === 'ok' ? '●' : st === 'degraded' ? '◐' : st === 'down' ? '✕'
    : st === 'unreachable' ? '✕' : '○';
}

function renderChips() {
  const snap = S.snap;
  const s = (snap && snap.summary) || {};

  chip(A.chStatus, s.status || 'unknown', statusTone(s.status));
  // role flips scan to scan depending on which replica answered - never a signal
  chip(A.chRole, s.role || '-', 'dim');
  A.chRole.title = 'whichever replica answered this probe';
  chip(A.chProd, s.deployedCommit || '-', s.prodMatchesLocal === false ? 'warn' : 'dim');

  const un = s.unshipped, dirty = s.dirty;
  const localTxt = (s.localBranch || '-') +
    (s.localCommit ? ' ' + s.localCommit : '') +
    (Number.isFinite(un) ? ' +' + un + ' unshipped' : '') +
    (Number.isFinite(dirty) ? ' · ' + dirty + ' dirty' : '');
  chip(A.chLocal, localTxt, (un > 0 || dirty > 0) ? 'warn' : 'dim');

  chip(A.chLatency, Number.isFinite(s.httpMs) ? s.httpMs + ' ms' : '-',
    !Number.isFinite(s.httpMs) ? 'dim' : s.httpMs > 1500 ? 'warn' : 'ok');
  chip(A.chIncidents, Number.isFinite(s.incidents) ? String(s.incidents) : '-',
    s.incidents > 0 ? 'bad' : 'dim');

  const scanMs = snap && Number.isFinite(snap.scanMs) ? snap.scanMs : null;
  const age = S.at ? Date.now() - S.at : NaN;
  chip(A.chScan,
    (scanMs != null ? 'scan ' + (scanMs / 1000).toFixed(1) + ' s' : 'scan -') +
    '  ·  ' + (Number.isFinite(age) ? durShort(age) + ' ago' : '-'), 'dim');

  // tier strip under the panel head: how many nodes, and how many are healthy
  if (snap) {
    const counts = new Map();
    for (const n of nodesOf(snap)) {
      if (!counts.has(n.tier)) counts.set(n.tier, { n: 0, bad: 0 });
      const c = counts.get(n.tier);
      c.n++;
      if (n.state === 'down' || n.state === 'degraded') c.bad++;
    }
    const sig = snap.tiers.map((t) => {
      const c = counts.get(t.id) || { n: 0, bad: 0 };
      return t.id + ':' + c.n + ':' + c.bad;
    }).join('|');
    if (A.tierStrip.dataset.sig !== sig) {
      A.tierStrip.dataset.sig = sig;
      A.tierStrip.textContent = '';
      for (const t of snap.tiers) {
        const c = counts.get(t.id) || { n: 0, bad: 0 };
        if (!c.n) continue;
        const w = el('span', 'tchip' + (c.bad ? ' bad' : ''));
        w.appendChild(el('i', null, String(t.label || t.id).toUpperCase()));
        w.appendChild(el('b', null, String(c.n)));
        A.tierStrip.appendChild(w);
      }
    }
    const errs = Array.isArray(snap.errors) ? snap.errors.length : 0;
    setText(A.scanline, (S.fixture ? 'fixture · ' : '') +
      nodesOf(snap).length + ' nodes · ' + edgesOf(snap).length + ' edges' +
      (errs ? ' · ' + errs + ' scan issue' + (errs === 1 ? '' : 's') : ''));
  }

  if (MC.view === 'stack') {
    setText(A.graphSub, snap
      ? stackHost(snap) + '  ·  ' + (s.deployedCommit || '-') +
        (s.deployedAt ? '  ·  deployed ' + rel(Date.now() - (parseTs(s.deployedAt) || Date.now())) : '')
      : 'no ' + MC.stackLower + ' data');
  }
}

/* ============================================================== TIMELINE */

function jobNodes() {
  return nodesOf(S.snap).filter((n) => n.tier === TIMELINE_TIER);
}

function renderTimelineStatic() {
  const jobs = jobNodes();

  /* A job lands in exactly one of three places:
       nextRunUtc  -> a marker on the axis
       everyMs     -> an interval pill ("every 30 s")
       neither     -> a pill reading "off" if it is schedulable but not running
                      (a cron that is never started), otherwise the dynamic note. */
  const pills = [];
  const dyn = [];
  for (const n of jobs) {
    if (n.meta.nextRunUtc) continue;
    if (Number.isFinite(n.meta.everyMs)) { pills.push({ n: n, txt: fmtEvery(n.meta.everyMs), off: false }); continue; }
    if (n.meta.expr || n.state === 'disabled' || n.state === 'hold') {
      pills.push({ n: n, txt: 'off', off: true });
      continue;
    }
    dyn.push(n);
  }

  const sig = pills.map((p) => p.n.id + ':' + p.txt + ':' + p.n.state).join('|');
  if (A.tlIvals.dataset.sig !== sig) {
    A.tlIvals.dataset.sig = sig;
    A.tlIvals.textContent = '';
    for (const p of pills) {
      const n = p.n;
      const w = el('span', 'ival st-' + n.state + (p.off ? ' is-off' : ''));
      w.appendChild(el('i', null, String(n.label || short(n.id)).toUpperCase()));
      w.appendChild(el('b', null, p.txt));
      w.title = nodeTitle(n) +
        (n.meta.expr ? '\ncron ' + n.meta.expr : '') +
        (p.off ? '\nnot scheduled in this deployment' : '\nevery ' + p.txt);
      A.tlIvals.appendChild(w);
    }
  }

  show(A.tlNote, dyn.length > 0);
  if (dyn.length) setText(A.tlNote, '+ per-user schedules (dynamic)');

  // one marker per scheduled job
  const timed = jobs.filter((n) => n.meta.nextRunUtc);
  const tsig = timed.map((n) => n.id).join('|');
  if (A.tlMarks.dataset.sig !== tsig) {
    A.tlMarks.dataset.sig = tsig;
    A.tlMarks.textContent = '';
    S.tlEls = new Map();
    for (const n of timed) {
      const m = el('div', 'mark');
      const box = el('div', 'mk-box');
      // long names blow the collision budget and force extra lanes; the full
      // name is a hover away
      const lab = el('div', 'mk-lab', trunc(String(n.label || short(n.id)).toUpperCase(), 15));
      const cd = el('div', 'mk-cd', '');
      box.appendChild(lab); box.appendChild(cd);
      const stem = el('div', 'mk-stem');
      const dia = el('div', 'mk-dia');
      // stem first so a neighbour's box paints over it, not the other way round
      m.appendChild(stem); m.appendChild(box); m.appendChild(dia);
      A.tlMarks.appendChild(m);
      S.tlEls.set(n.id, { m, box, lab, cd, stem, dia });
    }
  }
  renderTimelineTimes();
}

function renderTimelineTicks() {
  const now = Date.now();
  const sig = Math.floor(now / 300000);      // relabel every 5 min, not every second
  if (A.tlTicks.dataset.sig === String(sig)) return;
  A.tlTicks.dataset.sig = String(sig);
  A.tlTicks.textContent = '';
  for (let h = 0; h <= 24; h += 6) {
    const t = now + h * 3600000;
    const d = el('div', 'tick');
    d.style.left = (h / 24 * 100) + '%';
    d.appendChild(el('span', 'tk-utc', (h === 0 ? 'NOW ' : '+' + h + 'h ') + utcHM(t) + 'Z'));
    d.appendChild(el('span', 'tk-loc', localHM(t)));
    A.tlTicks.appendChild(d);
  }
}

function renderTimelineTimes() {
  renderTimelineTicks();
  const now = Date.now();
  const w = A.tlAxis.clientWidth || 600;
  const all = [];
  for (const n of jobNodes()) {
    const e = S.tlEls.get(n.id);
    if (!e || !n.meta.nextRunUtc) continue;
    let t = parseTs(n.meta.nextRunUtc);
    if (!Number.isFinite(t)) continue;
    // The producer's nextRunUtc goes stale between scans (and never moves at
    // all on the fixture). Once a fire time is well past, roll it forward from
    // the expression rather than leaving the marker stuck on "due".
    if (t - now < -30000 && n.meta.expr) {
      const nx = cronNext(n.meta.expr, now);
      if (Number.isFinite(nx)) { t = nx; n.meta.nextRunUtc = new Date(nx).toISOString(); }
    }
    const inMs = t - now;
    const frac = clamp(0, inMs / DAY_MS, 1);
    all.push({ n, e, t, inMs, frac, px: frac * w, beyond: inMs > DAY_MS });
  }
  all.sort((a, b) => a.inMs - b.inMs);

  /* A job further out than +24h has no honest position on a 24h axis. It used
     to pin to the right edge with a "»", which read as "due at 24h" and sat on
     top of the +24h tick. It goes in the LATER list instead. */
  const rows = all.filter((r) => !r.beyond);
  const later = all.filter((r) => r.beyond);

  // Stack on real overlap, not on a guessed separation: two short labels can sit
  // close together, two long ones need a lane each.
  const laneRight = [];
  for (const r of rows) {
    r.at = r.frac < 0.06 ? 'l' : r.frac > 0.94 ? 'r' : 'c';
    const bw = (r.e.box.offsetWidth || 90) + 10;
    r.l = r.at === 'l' ? r.px : r.at === 'r' ? r.px - bw : r.px - bw / 2;
    r.r = r.l + bw;
    let lane = 0;
    while (lane < laneRight.length && r.l < laneRight[lane]) lane++;
    if (lane > 2) lane = 2;              // the strip only has room for three
    laneRight[lane] = Math.max(laneRight[lane] || 0, r.r);
    r.lane = lane;
  }

  const LANE_H = 24;
  for (const r of rows) {
    const { e, n } = r;
    e.m.style.left = (r.frac * 100) + '%';
    e.box.style.bottom = (5 + r.lane * LANE_H) + 'px';
    e.stem.style.height = (5 + r.lane * LANE_H) + 'px';
    const near = r.at === 'l' ? ' at-left' : r.at === 'r' ? ' at-right' : '';
    e.m.className = 'mark st-' + n.state + near;
    setText(e.cd, fmtIn(r.inMs));
    e.m.title = jobTitle(n, r.t, r.inMs);
  }
  for (const r of later) r.e.m.className = 'mark st-' + r.n.state + ' beyond';

  renderLater(later);
  renderJobList(all);
}

function jobTitle(n, t, inMs) {
  return (n.label || short(n.id)) +
    (n.meta.expr ? '\n' + n.meta.expr : '') +
    '\n' + utcFull(t) +
    '\n' + localFull(t) +
    '\n' + fmtIn(inMs);
}

/* LATER: everything past the right edge of the axis, with the day it actually
   lands on so "in 3d 4h" is not the only clue. */
function renderLater(later) {
  show(A.tlLater, later.length > 0);
  if (!later.length) return;
  const sig = later.map((r) => r.n.id + ':' + Math.floor(r.t / 60000)).join('|');
  if (A.tlLater.dataset.sig !== sig) {
    A.tlLater.dataset.sig = sig;
    A.tlLater.textContent = '';
    A.tlLater.appendChild(el('div', 'lt-head', 'LATER'));
    for (const r of later) {
      const row = el('div', 'lt-row');
      row.appendChild(el('b', null, trunc(String(r.n.label || short(r.n.id)).toUpperCase(), 18)));
      row.appendChild(document.createTextNode(' ' + utcDay(r.t) + ' ' + utcHM(r.t) + 'Z '));
      row.appendChild(el('i', null, fmtIn(r.inMs)));
      row.title = jobTitle(r.n, r.t, r.inMs);
      A.tlLater.appendChild(row);
      r.laterEl = row;
    }
  } else {
    // same jobs, same minute - only the countdown moves
    const kids = A.tlLater.querySelectorAll('.lt-row i');
    later.forEach((r, i) => { if (kids[i]) setText(kids[i], fmtIn(r.inMs)); });
  }
}

/* The phone replacement for the axis: one row per scheduled job, soonest
   first. The axis itself is display:none at that width. */
function renderJobList(all) {
  if (!A.tlList) return;
  const on = MC.phone && MC.phone();
  show(A.tlList, on && all.length > 0);
  if (!on || !all.length) return;
  const sig = all.map((r) => r.n.id + ':' + r.n.state).join('|');
  if (A.tlList.dataset.sig !== sig) {
    A.tlList.dataset.sig = sig;
    A.tlList.textContent = '';
    S.tlListEls = new Map();
    for (const r of all) {
      const row = el('div', 'al-row st-' + r.n.state);
      const cd = el('i', null, '');
      const lab = el('b', null, r.n.label || short(r.n.id));
      const when = el('span', null, '');
      row.appendChild(cd); row.appendChild(lab); row.appendChild(when);
      A.tlList.appendChild(row);
      S.tlListEls.set(r.n.id, { row, cd, when });
    }
  }
  for (const r of all) {
    const e = S.tlListEls && S.tlListEls.get(r.n.id);
    if (!e) continue;
    setText(e.cd, fmtIn(r.inMs));
    setText(e.when, utcDay(r.t) + ' ' + utcHM(r.t) + 'Z  ·  ' + localHM(r.t) + ' local');
    e.row.title = jobTitle(r.n, r.t, r.inMs);
  }
}

/* ============================================================== TOOLTIP */

function stackTip(txt, x, y) {
  setText(A.tooltip, txt);
  A.tooltip.hidden = false;
  const r = A.tooltip.getBoundingClientRect();
  A.tooltip.style.left = Math.min(x + 14, window.innerWidth - r.width - 8) + 'px';
  A.tooltip.style.top = Math.min(y + 14, window.innerHeight - r.height - 8) + 'px';
}
function hideTip() { A.tooltip.hidden = true; }

function tipFor(n) {
  const lines = [(n.label || n.id) + '  ·  ' + String(n.tier).toUpperCase()];
  lines.push(n.state.toUpperCase() + (n.source ? '  ·  ' + n.source : ''));
  if (n.detail) lines.push(n.detail);
  if (n.sub) lines.push(n.sub);
  const m = n.meta || {};
  if (m.expr) lines.push('cron ' + m.expr);
  if (Number.isFinite(m.everyMs)) lines.push('every ' + fmtEvery(m.everyMs));
  if (m.nextRunUtc) {
    const t = parseTs(m.nextRunUtc);
    if (Number.isFinite(t)) lines.push('next ' + utcFull(t) + '  ·  ' + fmtIn(t - Date.now()));
  }
  return lines.join('\n');
}

/* ============================================================== PIN CARD */

function pinStack(id) {
  const b = S.boxes.get(id);
  if (!b) return;
  S.pinned = id;
  for (const [k, e] of S.nodeEls) e.g.classList.toggle('sel', k === id);
  fillStackDetail(b.node);
}
function unpinStack() {
  S.pinned = null;
  for (const [, e] of S.nodeEls) e.g.classList.remove('sel');
  D.detail.hidden = true;
}

function fillStackDetail(n) {
  const tone = n.state === 'up' ? MC.COL.live
    : n.state === 'degraded' || n.state === 'armed' || n.state === 'hold' ? MC.COL.warn
      : n.state === 'down' ? MC.COL.bad : MC.COL.dim;
  D.dDot.style.background = n.state === 'armed' ? MC.COL.d3 : tone;
  setText(D.dType, n.label || n.id);
  setText(D.dStatus, n.state);
  setText(D.dDesc, n.detail || n.sub || '(no detail reported)');

  let inCount = 0, outCount = 0;
  const outTo = [], inFrom = [];
  const labelOf = (id) => {
    const m = nodesOf(S.snap).find((x) => x.id === id);
    return (m && m.label) || short(id);
  };
  for (const e of edgesOf(S.snap)) {
    if (e.to === n.id) { inCount++; if (inFrom.length < 8) inFrom.push(labelOf(e.from)); }
    if (e.from === n.id) { outCount++; if (outTo.length < 8) outTo.push(labelOf(e.to) + (e.kind ? ' (' + e.kind + ')' : '')); }
  }

  const rows = [
    ['TIER', String(n.tier)],
    ['ID', String(n.id)],
    ['SOURCE', n.source || '-'],
    ['EDGES', inCount + ' in / ' + outCount + ' out']
  ];
  /* On a phone the card is the ONLY detail path (no hover, no tooltip), so
     everything tipFor() would have said has to be here too. */
  const nm = n.meta || {};
  if (nm.nextRunUtc) {
    const t = parseTs(nm.nextRunUtc);
    if (Number.isFinite(t)) rows.push(['NEXT', utcFull(t) + '  ·  ' + fmtIn(t - Date.now())]);
  }
  if (Number.isFinite(nm.everyMs)) rows.push(['EVERY', fmtEvery(nm.everyMs)]);
  // on a phone the map is not drawn, so the wiring has to be readable here
  if (outTo.length) rows.push(['CONNECTS TO', outTo.join(', ')]);
  if (inFrom.length) rows.push(['USED BY', inFrom.join(', ')]);
  const m = n.meta || {};
  for (const k of Object.keys(m).slice(0, 8)) {
    let v = m[k];
    if (k === 'inMs') v = fmtIn(v);
    else if (k === 'everyMs') v = 'every ' + fmtEvery(v);
    else if (/At$/.test(k) && typeof v === 'string') {
      const t = parseTs(v);
      v = Number.isFinite(t) ? rel(Date.now() - t) : v;
    } else if (v && typeof v === 'object') {
      try { v = JSON.stringify(v); } catch (_) { v = '[object]'; }
    }
    rows.push([k.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase(), String(v)]);
  }

  if (D.dGrid.dataset.n !== String(rows.length)) {
    D.dGrid.textContent = '';
    for (let i = 0; i < rows.length; i++) { D.dGrid.appendChild(el('dt')); D.dGrid.appendChild(el('dd')); }
    D.dGrid.dataset.n = String(rows.length);
  }
  const kids = D.dGrid.children;
  rows.forEach((r, i) => { setText(kids[i * 2], r[0]); setText(kids[i * 2 + 1], r[1]); });

  setText(D.dLastLabel, n.state === 'down' || n.state === 'degraded' ? 'REASON' : 'NOTES');
  setText(D.dLastText, n.sub || n.detail || '(nothing else reported)');
  D.detail.hidden = false;
}

/* ============================================================== FEED */

const AFEED_KEY = 'mc.feed.stack';
const AFEED_MAX = 200;
const AFEED_TTL = 24 * 60 * 60 * 1000;
let aFeed = [];
let aFeedTimer = 0;

function sevOf(state) {
  return state === 'down' ? 'bad' : state === 'degraded' ? 'warn'
    : state === 'up' ? 'ok' : state === 'armed' ? 'arm' : 'dim';
}

/* Leader election is per-replica: each probe lands on whichever Railway replica
   answers, so this node and summary.role flip every scan without anything
   having happened. Both are excluded from the feed rather than filling it with
   noise every 30 seconds. */
const DIFF_IGNORE_NODES = { 'rt-leadership': 1 };

/* Pure: two snapshots in, feed rows out. Compares STATE only - detail text also
   varies by replica ("not checked on a follower") and is not an event.
   Exposed on MC.stack so it can be exercised without waiting for a second
   live frame. */
function stackDiff(prev, next) {
  if (!prev || !next) return [];
  const out = [];
  const ts = parseTs(next.generatedAt) || Date.now();
  const pn = new Map(nodesOf(prev).map((n) => [n.id, n]));
  const nn = new Map(nodesOf(next).map((n) => [n.id, n]));

  for (const [id, n] of nn) {
    if (DIFF_IGNORE_NODES[id]) continue;
    const p = pn.get(id);
    if (!p) { out.push({ kind: 'stack', ts, sev: sevOf(n.state), text: short(id) + '  appeared ' + n.state }); continue; }
    if (p.state !== n.state) {
      out.push({ kind: 'stack', ts, sev: sevOf(n.state), text: short(id) + '  ' + p.state + ' → ' + n.state });
    }
  }
  for (const [id, p] of pn) {
    if (DIFF_IGNORE_NODES[id]) continue;
    if (!nn.has(id)) out.push({ kind: 'stack', ts, sev: 'dim', text: short(id) + '  gone (was ' + p.state + ')' });
  }

  const a = prev.summary || {}, b = next.summary || {};
  if (a.deployedCommit !== b.deployedCommit) {
    out.push({ kind: 'stack', ts, sev: 'ok', text: 'prod moved ' + (a.deployedCommit || '-') + ' → ' + (b.deployedCommit || '-') });
  }
  if (a.unshipped !== b.unshipped) {
    out.push({ kind: 'stack', ts, sev: b.unshipped > 0 ? 'warn' : 'ok', text: 'unshipped ' + (a.unshipped == null ? '-' : a.unshipped) + ' → ' + (b.unshipped == null ? '-' : b.unshipped) });
  }
  if (a.dirty !== b.dirty) {
    out.push({ kind: 'stack', ts, sev: 'dim', text: 'dirty ' + (a.dirty == null ? '-' : a.dirty) + ' → ' + (b.dirty == null ? '-' : b.dirty) });
  }
  if (a.status !== b.status) {
    out.push({ kind: 'stack', ts, sev: b.status === 'ok' ? 'ok' : 'bad', text: 'status ' + (a.status || '-') + ' → ' + (b.status || '-') });
  }
  // summary.role is deliberately NOT diffed - see DIFF_IGNORE_NODES
  if ((a.incidents || 0) !== (b.incidents || 0)) {
    out.push({ kind: 'stack', ts, sev: b.incidents > 0 ? 'bad' : 'ok', text: 'incidents ' + (a.incidents || 0) + ' → ' + (b.incidents || 0) });
  }
  return out;
}

function aFeedRow(ev, animate) {
  const row = el('div', 'ev k-stack sev-' + (ev.sev || 'dim'));
  const t = el('span', 'ev-t');
  row.appendChild(t);
  row.appendChild(el('span', 'ev-d'));
  row.appendChild(el('span', 'ev-k', 'stack'));
  row.appendChild(el('span', 'ev-x', ev.text));
  ev.tEl = t;
  if (animate !== false) {
    row.classList.add('ev-new');
    setTimeout(() => row.classList.remove('ev-new'), 520);
  }
  return row;
}

function aFeedSave() {
  if (aFeedTimer) return;
  aFeedTimer = setTimeout(() => {
    aFeedTimer = 0;
    const rows = aFeed.slice(0, AFEED_MAX).map((e) => ({ kind: 'stack', ts: e.ts, sev: e.sev, text: e.text }));
    try { lsSet(AFEED_KEY, JSON.stringify({ savedAt: Date.now(), rows: rows })); } catch (_) { }
  }, 1000);
}

function aFeedCount() {
  return aFeed.length + (aFeed.length === 1 ? ' event' : ' events');
}

function aFeedPush(evs) {
  if (!evs || !evs.length) return;
  for (const ev of evs) {
    ev.el = aFeedRow(ev, true);
    A.feedRowsStack.insertBefore(ev.el, A.feedRowsStack.firstChild);
    aFeed.unshift(ev);
  }
  while (aFeed.length > AFEED_MAX) {
    const old = aFeed.pop();
    if (old.el && old.el.parentNode) old.el.remove();
  }
  show(A.feedEmpty, aFeed.length === 0);
  if (MC.view === 'stack') setText(A.feedCount, aFeedCount());
  aFeedTimes();
  aFeedSave();
}

function aFeedTimes() {
  const now = Date.now();
  for (const ev of aFeed) if (ev.tEl) setText(ev.tEl, durShort(now - ev.ts));
}

function aFeedRestore() {
  let rows = [];
  try {
    const raw = lsGet(AFEED_KEY, null);
    if (raw) {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.rows) ? parsed.rows : []);
      if (Array.isArray(arr)) rows = arr;
    }
  } catch (_) { rows = []; }
  const cutoff = Date.now() - AFEED_TTL;
  rows = rows
    .filter((r) => r && typeof r === 'object' && Number.isFinite(r.ts) && r.ts >= cutoff && typeof r.text === 'string')
    .slice(0, AFEED_MAX);
  for (const r of rows) {
    const ev = { kind: 'stack', ts: r.ts, sev: r.sev || 'dim', text: r.text };
    ev.el = aFeedRow(ev, false);
    A.feedRowsStack.appendChild(ev.el);
    aFeed.push(ev);
  }
  show(A.feedEmpty, aFeed.length === 0);
  aFeedTimes();
}

/* ============================================================== APPLY */

function structureSig(snap) {
  const parts = [];
  for (const n of nodesOf(snap)) parts.push(n.id + '@' + n.tier);
  parts.sort();
  const e = edgesOf(snap).map((x) => x.from + '>' + x.to + ':' + (x.kind || '')).sort();
  // the panel size feeds the sub-column split, so it belongs in the signature
  return Math.round(A.stage.clientWidth) + 'x' + Math.round(A.stage.clientHeight) +
    '#' + parts.join(',') + '#' + e.join(',');
}

/* Geometry only: columns, sub-columns, boxes and the bottom lane. */
function relayout() {
  const snap = S.snap;
  if (!snap) return;
  const edges = edgesOf(snap);
  const cols = buildColumns(snap);

  // order the tiers first, then split, then order inside the sub-columns
  const tiered = barycentre(cols.map((c) => c.nodes), edges, 2);
  cols.forEach((c, i) => { c.nodes = tiered[i]; });

  const sw = A.stage.clientWidth || 900;
  const sh = A.stage.clientHeight || 460;
  const placed = layoutBest(cols, edges, sw, sh);

  S.cols = cols;
  S.boxes = placed.boxes;
  S.laneY = placed.bodyBottom + 13;

  let lanes = 0;
  for (const e of edges) {
    const a = placed.boxes.get(e.from), b = placed.boxes.get(e.to);
    if (a && b && isLongHop(a, b, e.kind || 'uses')) lanes++;
  }
  lanes = Math.min(lanes, 4);
  S.content = { w: placed.w, h: Math.max(placed.h, S.laneY + lanes * G.LANE_GAP + 10) };
}

function applyStack(raw, fromFixture) {
  const snap = normalise(raw);
  if (!snap) return;

  if (S.snap) {
    const rows = stackDiff(S.snap, snap);
    if (rows.length) aFeedPush(rows);
  }
  S.prev = S.snap;
  S.snap = snap;
  S.at = Date.now();
  S.fixture = !!fromFixture;
  show(A.fixtureChip, S.fixture && MC.view === 'stack');

  relayout();

  const sig = structureSig(snap);
  const structural = sig !== S.layoutSig;
  S.layoutSig = sig;

  renderMap(structural);
  renderChips();
  renderTimelineStatic();
  renderStackList(false);
  if (structural && MC.view === 'stack') fitStack();
  if (S.pinned) {
    const b = S.boxes.get(S.pinned);
    if (b) fillStackDetail(b.node); else unpinStack();
  }
  if (MC.view === 'stack') MC.setTitle();
  // history-ui folds the fresh probe into the 24h band and runs the alert diff
  if (typeof MC.emit === 'function') MC.emit('stack', snap);
}

/* ============================================================== TRANSPORT */

async function fetchStack() {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch('/api/stack', { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) {
      const err = new Error('/api/stack ' + r.status);
      // the module is off on the server: that is an answer, not an outage
      if (r.status === 404) {
        try { const j = await r.json(); err.moduleDisabled = !!(j && j.error === 'module_disabled'); } catch (_) { }
      }
      throw err;
    }
    return await r.json();
  } finally { clearTimeout(to); }
}

const stackOff = () => S.off || (typeof MC.stackOff === 'function' && MC.stackOff());

/* Settles when app.js has heard from /api/health, or after MODULES_WAIT_MS. */
function modulesGate() {
  const ready = MC.modulesReady && typeof MC.modulesReady.then === 'function'
    ? MC.modulesReady : Promise.resolve(null);
  return Promise.race([ready, new Promise((res) => setTimeout(res, MODULES_WAIT_MS))]);
}

/* The module is off: no fetches, no fixture, no poll. app.js has already
   moved the view off stack and hidden the tab. */
function disableStack() {
  S.off = true;
  if (S.poll) { clearInterval(S.poll); S.poll = 0; }
  show(A.fixtureChip, false);
}

/* A machine's own snapshot (gitignored fixtures/stack.local.json) wins over
   the tracked synthetic demo (fixtures/stack.json, bin/make-fixtures.js). */
async function fetchFixture(name) {
  const local = await fetch('fixtures/' + name + '.local.json', { cache: 'no-store' }).catch(() => null);
  if (local && local.ok) return local;
  return fetch('fixtures/' + name + '.json', { cache: 'no-store' });
}

async function loadFixture() {
  try {
    const r = await fetchFixture('stack');
    if (!r.ok) throw new Error('fixture ' + r.status);
    const j = await r.json();
    applyStack(rehydrate(j), true);
  } catch (err) {
    setText(A.scanline, MC.stackLower + ' fixture unavailable: ' + (err && err.message ? err.message : err));
  }
}

function startPoll() {
  if (S.poll) return;
  S.poll = setInterval(async () => {
    if (S.live || stackOff()) { clearInterval(S.poll); S.poll = 0; return; }
    try { const d = await fetchStack(); applyStack(d, false); }
    catch (err) {
      if (err && err.moduleDisabled) disableStack();
      /* otherwise keep whatever we have; the fixture is already on screen */
    }
  }, POLL_MS);
}

async function bootStack() {
  await modulesGate();
  if (stackOff()) { disableStack(); return; }
  try {
    const d = await fetchStack();
    applyStack(d, false);
  } catch (err) {
    if (err && err.moduleDisabled) { disableStack(); return; }
    await loadFixture();
  }
  startPoll();
}

/* a late /api/health (past MODULES_WAIT_MS) that says off still wins */
if (MC.modulesReady && typeof MC.modulesReady.then === 'function') {
  MC.modulesReady.then(() => { if (stackOff()) disableStack(); });
}

/* an SSE frame is authoritative and cancels the fixture */
MC.hooks.stack = function (d) {
  if (stackOff()) return;
  S.live = true;
  if (S.poll) { clearInterval(S.poll); S.poll = 0; }
  applyStack(d, false);
};

/* ============================================================== VIEW SWITCH */

function applyView(v) {
  const stack = v === 'stack';

  A.tabAgents.setAttribute('aria-selected', String(!stack));
  A.tabStack.setAttribute('aria-selected', String(stack));

  show(A.selWrap, !stack);
  show(A.counters, !stack);
  show(A.toggles, !stack);
  show(A.chips, stack);
  show(A.chipbar, stack);
  show(A.legend, !stack);
  show(A.stackLegend, stack);
  show(A.timeline, stack);
  show(A.hint, !stack);
  /* The bottom-right hint overlapped the lowest DEPENDS ON node at 1440x900.
     It is a `?` in the panel head now - same words, out of the map's way. */
  show(A.stackHint, false);
  show(A.help, stack && !(MC.phone && MC.phone()));
  // the agents-snapshot age has no meaning here, and the topbar needs the room;
  // the Stack snapshot's own age is on the scan chip in the strip below
  show(D.updated, !stack);

  show(D.svg, !stack);
  show(A.svg, stack);
  show(A.feedRows, !stack);
  show(A.feedRowsStack, stack);
  show(A.fixtureChip, stack && S.fixture);

  setText(A.panelTitle, stack ? MC.stackLabel + ' system map' : 'Agent fan-out');
  setText(A.feedTitle, stack ? MC.stackUpper + ' FEED' : 'EVENT FEED');

  if (stack) {
    show(A.focusChip, false);
    show(A.emptyNote, false);
    MC.unpin();                       // the detail card is shared - one owner at a time
    setText(A.feedCount, aFeedCount());
    renderChips();
    renderStackList(true);
    fitStack();
    renderTimelineTimes();
  } else {
    unpinStack();
    MC.refreshFeedCount();
    MC.refreshAgents();          // the shared overlays were suppressed while we had the stage
  }
  hideTip();
}

MC.hooks.viewchange = applyView;
MC.hooks.tick = function () {
  if (MC.view !== 'stack') return;
  renderChips();
  renderTimelineTimes();
  aFeedTimes();
  if (S.hover && S.hoverXY) {
    const b = S.boxes.get(S.hover);
    if (b && !A.tooltip.hidden) stackTip(tipFor(b.node), S.hoverXY[0], S.hoverXY[1]);
  }
};
MC.hooks.resize = function () {
  if (MC.view !== 'stack' || !S.snap) return;
  // a different panel size can pick a different sub-column split
  relayout();
  const sig = structureSig(S.snap);
  if (sig !== S.layoutSig) { S.layoutSig = sig; renderMap(true); }
  fitStack();
  renderTimelineTimes();
};
/* the breakpoint moved: the axis and the vertical job list swap places, and the
   map wants a fresh fit to the new panel width */
MC.hooks.phone = function () {
  if (!S.snap) return;
  renderStackList(true);
  renderTimelineTimes();
  if (MC.view !== 'stack') return;
  relayout();
  S.layoutSig = structureSig(S.snap);
  renderMap(true);
  av.user = false;
  fitStack();
};
MC.hooks.reset = function () { resetStackView(); };
MC.hooks.escape = function () { unpinStack(); hideTip(); };
MC.hooks.statusGlyph = function () {
  const s = (S.snap && S.snap.summary) || {};
  return statusGlyph(s.status);
};

/* ============================================================== INTERACTION */

let adrag = null, asuppress = false;

/* Same two-pointer model as the agents graph: one finger pans, two pinch. */
const aptrs = new Map();
let apinch = null;

function aCenter() {
  let x = 0, y = 0;
  for (const p of aptrs.values()) { x += p.x; y += p.y; }
  return { x: x / aptrs.size, y: y / aptrs.size };
}
function aSpread() {
  const a = Array.from(aptrs.values());
  return a.length < 2 ? 0 : Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
}
function aBeginPan(id, x, y) {
  adrag = { x: x, y: y, vx: av.x, vy: av.y, moved: false, id: id };
}

A.svg.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  aptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (aptrs.size === 2) {
    adrag = null;
    A.svg.classList.remove('dragging');
    hideTip();
    const c = aCenter();
    const r = A.svg.getBoundingClientRect();
    apinch = {
      d: aSpread(), k: av.k, moved: false,
      gx: (c.x - r.left - av.x) / av.k, gy: (c.y - r.top - av.y) / av.k
    };
  } else if (aptrs.size === 1) {
    apinch = null;
    aBeginPan(e.pointerId, e.clientX, e.clientY);
  } else { apinch = null; adrag = null; }
});

window.addEventListener('pointermove', (e) => {
  if (aptrs.has(e.pointerId)) aptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (apinch && aptrs.size === 2) {
    const d = aSpread();
    if (!(d > 0) || !(apinch.d > 0)) return;
    if (!apinch.moved && Math.abs(d - apinch.d) > 6) apinch.moved = true;
    const k = clamp(G.K_MIN, apinch.k * (d / apinch.d), G.K_MAX);
    const c = aCenter();
    const r = A.svg.getBoundingClientRect();
    av.k = k;
    av.x = (c.x - r.left) - apinch.gx * k;
    av.y = (c.y - r.top) - apinch.gy * k;
    av.user = true;
    applyAView();
    return;
  }

  if (!adrag || adrag.id !== e.pointerId) return;
  const dx = e.clientX - adrag.x, dy = e.clientY - adrag.y;
  if (!adrag.moved && Math.hypot(dx, dy) > 3) { adrag.moved = true; A.svg.classList.add('dragging'); hideTip(); }
  if (adrag.moved) { av.x = adrag.vx + dx; av.y = adrag.vy + dy; av.user = true; applyAView(); }
});

const aEnd = (e) => {
  aptrs.delete(e.pointerId);
  if (apinch) {
    if (aptrs.size >= 2) return;
    const moved = apinch.moved;
    apinch = null;
    if (moved) { asuppress = true; setTimeout(() => { asuppress = false; }, 0); }
    if (aptrs.size === 1) {
      const it = aptrs.entries().next().value;
      aBeginPan(it[0], it[1].x, it[1].y);
    }
    return;
  }
  if (!adrag || adrag.id !== e.pointerId) return;
  const moved = adrag.moved;
  adrag = null;
  A.svg.classList.remove('dragging');
  if (moved) { asuppress = true; setTimeout(() => { asuppress = false; }, 0); }
};
window.addEventListener('pointerup', aEnd);
window.addEventListener('pointercancel', aEnd);

A.svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = A.svg.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const gx = (mx - av.x) / av.k, gy = (my - av.y) / av.k;
  const k = clamp(G.K_MIN, av.k * Math.exp(-e.deltaY * 0.0016), G.K_MAX);
  av.k = k; av.x = mx - gx * k; av.y = my - gy * k; av.user = true;
  applyAView();
}, { passive: false });

A.lNodes.addEventListener('pointerover', (e) => {
  const g = e.target.closest && e.target.closest('g.a-node');
  if (!g || adrag) return;
  const id = g.dataset.id;
  S.hoverXY = [e.clientX, e.clientY];
  if (S.hover === id) return;
  if (S.hover) { const p = S.nodeEls.get(S.hover); if (p) p.g.classList.remove('hov'); }
  S.hover = id;
  g.classList.add('hov');
  const b = S.boxes.get(id);
  if (b) stackTip(tipFor(b.node), e.clientX, e.clientY);
});
A.lNodes.addEventListener('pointermove', (e) => {
  if (adrag || !S.hover) return;
  S.hoverXY = [e.clientX, e.clientY];
  const b = S.boxes.get(S.hover);
  if (b) stackTip(tipFor(b.node), e.clientX, e.clientY);
});
A.lNodes.addEventListener('pointerout', (e) => {
  const g = e.target.closest && e.target.closest('g.a-node');
  if (!g) return;
  if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('g.a-node') === g) return;
  g.classList.remove('hov');
  if (S.hover === g.dataset.id) S.hover = null;
  hideTip();
});
A.lNodes.addEventListener('click', (e) => {
  if (asuppress) return;
  const g = e.target.closest && e.target.closest('g.a-node');
  if (!g) return;
  e.stopPropagation();
  pinStack(g.dataset.id);
});
A.svg.addEventListener('click', () => { if (!asuppress) unpinStack(); });

A.tabAgents.addEventListener('click', () => (MC.setTab || MC.setView)('agents'));
A.tabStack.addEventListener('click', () => (MC.setTab || MC.setView)('stack'));

/* the map controls, on demand, from the panel head */
const HELP_TEXT = 'drag to pan  ·  wheel or pinch to zoom  ·  tap a node to pin it\n' +
  '1 / 2 switch view  ·  f feed  ·  n alerts  ·  r reset  ·  esc unpin';
if (A.help) {
  const showHelp = (e) => stackTip(HELP_TEXT, e.clientX != null ? e.clientX : 0, e.clientY != null ? e.clientY : 0);
  A.help.addEventListener('pointerenter', showHelp);
  A.help.addEventListener('focus', () => {
    const r = A.help.getBoundingClientRect();
    stackTip(HELP_TEXT, r.left - 220, r.bottom);
  });
  A.help.addEventListener('pointerleave', hideTip);
  A.help.addEventListener('blur', hideTip);
  // touch has no hover: a tap toggles it
  A.help.addEventListener('click', (e) => {
    if (A.tooltip.hidden) showHelp(e); else hideTip();
  });
  A.help.title = HELP_TEXT;
}

/* ============================================================== EXPORTS / GO */

MC.stack = {
  diff: stackDiff,
  apply: applyStack,
  cronNext: cronNext,
  snapshot: () => S.snap,
  host: (snap) => stackHost(snap === undefined ? S.snap : snap),
  isFixture: () => S.fixture,
  columns: () => S.cols.map((c) => ({ tier: c.tier, label: c.label, count: c.nodes.length, subs: c.subs.map((s) => s.length) })),
  boxes: () => S.boxes,
  content: () => ({ w: S.content.w, h: S.content.h, laneY: S.laneY }),
  markers: () => S.tlEls.size,
  feed: () => aFeed.map((e) => ({ ts: e.ts, sev: e.sev, text: e.text })),
  list: () => (S.listEls ? S.listEls.size : 0)
};

aFeedRestore();
applyView(MC.view);
bootStack();

})();
