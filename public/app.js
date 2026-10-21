/* =============================================================================
   MISSION CONTROL - front end
   Radial agent hub graph + infrastructure rail.
   No frameworks, no libraries, no build step.
   ============================================================================= */
'use strict';

/* app.js is a plain script tag, so every top-level declaration in it used to
   land on `window` - around two hundred names. Wrapped so `window.MC` really is
   the only global the dashboard adds, matching stack-view.js and history-ui.js. */
(function () {

/* ------------------------------------------------------------------ const */

const TAU = Math.PI * 2;
const SVGNS = 'http://www.w3.org/2000/svg';

const COL = {
  hub: '#c084fc', d1: '#60a5fa', d2: '#38bdf8', d3: '#22d3ee',
  live: '#4ade80', dim: '#3f4654', warn: '#fbbf24', bad: '#f87171',
  muted: '#7d8798'
};

const DEPTH_COL = [COL.hub, COL.d1, COL.d2, COL.d3];
const NODE_R    = [26, 9.5, 6.6, 4.6, 3.8, 3.2, 2.8];

const RING_POW      = 0.66;   // sub-linear radius growth
const MORPH_MS      = 480;
const POLL_AGENTS_MS = 3000;
const POLL_INFRA_MS  = 30000;
const BACKOFF       = [1000, 2000, 5000, 10000];
/* How long a finished agent stays on the graph after its last activity, fading
   out over the window so you can still see what just completed. */
const LINGER_MS     = 5 * 60 * 1000;
const LINGER_MIN_OP = 0.25;   // opacity a lingering node reaches at LINGER_MS
const GHOST_OP      = 0.35;   // an ancestor kept only to connect a visible node
const LEAVE_MS      = 380;    // fade-out before the element is dropped

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
/* one breakpoint, shared by the layout (style.css) and the behaviour (here) */
const PHONE = window.matchMedia('(max-width: 820px)');
/* a 4.6px node is an impossible tap target - the invisible hit circle is what
   the finger actually lands on, so it gets a 28px diameter on touch layouts */
function hitR(r) { return PHONE.matches ? Math.max(r + 6, 14) : Math.max(r + 5, 9); }

/* ------------------------------------------------------------------ util */

const $ = (id) => document.getElementById(id);

/* localStorage can throw outright (private mode, blocked site data) */
function lsGet(k, dflt) {
  try { const v = localStorage.getItem(k); return v === null ? dflt : v; } catch (_) { return dflt; }
}
function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (_) { } }
const clamp = (lo, v, hi) => Math.max(lo, Math.min(hi, v));

function svgEl(name, attrs) {
  const e = document.createElementNS(SVGNS, name);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function setText(node, s) { const v = s == null ? '' : String(s); if (node.textContent !== v) node.textContent = v; }
function setAttrIf(node, k, v) { const s = String(v); if (node.getAttribute(k) !== s) node.setAttribute(k, s); }

function parseTs(s) { if (!s) return NaN; const t = Date.parse(s); return Number.isNaN(t) ? NaN : t; }

function rel(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
function dur(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}
function num(n) { return Number.isFinite(n) ? n.toLocaleString('en-US') : '-'; }
function bytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }
function short(id) { return String(id || '').slice(0, 8); }

/* compact duration for dense state lines: 4s / 2m / 3h / 5d */
function durShort(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const sec = Math.floor(ms / 1000); if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60); if (m < 60) return m + 'm';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

/* Model ids come verbatim off disk. Turn claude-fable-5-1 into FABLE 5.1 and
   claude-haiku-4-5-20251001 into HAIKU 4.5, but never mangle an unknown shape
   (e.g. <synthetic>) - fall back to the raw string. */
function formatModel(m) {
  if (typeof m !== 'string') return null;
  const raw = m.trim();
  if (!raw) return null;
  if (raw.slice(0, 7) !== 'claude-') return raw.toUpperCase();
  const parts = raw.slice(7).split('-').filter(Boolean);
  if (!parts.length) return raw.toUpperCase();
  const nums = [];
  for (let i = 1; i < parts.length; i++) {
    if (!/^[0-9]+$/.test(parts[i])) return raw.toUpperCase();
    if (parts[i].length >= 6) break;            // trailing date stamp
    nums.push(parts[i]);
  }
  return (parts[0] + (nums.length ? ' ' + nums.join('.') : '')).toUpperCase();
}

/* ------------------------------------------------------------ tokens / cost */

/* One formatter, shared by every surface that shows a token count:
   2 / 4.3k / 348k / 1.2M. Anything non-numeric is an em dash, never NaN. */
function fmtTokens(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 0) n = 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return n < 10000 ? (n / 1000).toFixed(1) + 'k' : Math.round(n / 1000) + 'k';
  if (n < 1e8) return (n / 1e6).toFixed(1) + 'M';
  return Math.round(n / 1e6) + 'M';
}

/* $0.42 under ten dollars, $12.3 under a hundred, $431 above. */
function fmtUsd(n) {
  if (!Number.isFinite(n)) return '—';
  const v = Math.abs(n);
  if (v < 10) return '$' + n.toFixed(2);
  if (v < 100) return '$' + n.toFixed(1);
  return '$' + Math.round(n).toLocaleString('en-US');
}

/* `tokens` is null on shallow sessions and absent entirely on older frames. */
function tk(o) {
  const t = o && o.tokens;
  return (t && typeof t === 'object') ? t : null;
}
function tkTotal(o) {
  const t = tk(o);
  return t && Number.isFinite(t.total) ? t.total : null;
}
/* in 2 · cache 40k+16k · out 4.3k · 12 turns */
function tokensLine(t) {
  if (!t) return null;
  const parts = ['in ' + fmtTokens(t.in)];
  if (Number.isFinite(t.cacheRead) || Number.isFinite(t.cacheWrite)) {
    parts.push('cache ' + fmtTokens(t.cacheRead || 0) + '+' + fmtTokens(t.cacheWrite || 0));
  }
  parts.push('out ' + fmtTokens(t.out));
  if (Number.isFinite(t.turns)) parts.push(t.turns + ' turn' + (t.turns === 1 ? '' : 's'));
  return parts.join('  ·  ');
}
function tokenBadges(o) {
  if (!o) return '';
  let s = '';
  if (o.tokensPending) s += '  ·  pending';
  if (o.tokensApprox) s += '  ·  approx';
  return s;
}
function tokensTitle(t, label) {
  if (!t) return 'token totals not reported by this scan';
  return (label ? label + '\n' : '') +
    'in           ' + num(t.in) + '\n' +
    'cache read   ' + num(t.cacheRead) + '\n' +
    'cache write  ' + num(t.cacheWrite) +
      (Number.isFinite(t.cacheWrite5m) || Number.isFinite(t.cacheWrite1h)
        ? '  (5m ' + num(t.cacheWrite5m) + ' / 1h ' + num(t.cacheWrite1h) + ')' : '') + '\n' +
    'out          ' + num(t.out) + '\n' +
    'total        ' + num(t.total) +
    (Number.isFinite(t.turns) ? '\nturns        ' + num(t.turns) : '');
}

/* Sum the token blocks of several sessions. Returns null when not one of them
   reported anything, so the counter stays an honest em dash. */
function sumTokens(list) {
  const out = { in: 0, cacheRead: 0, cacheWrite: 0, out: 0, total: 0, turns: 0 };
  let any = false;
  for (const s of list) {
    const t = tk(s);
    if (!t) continue;
    any = true;
    for (const k of ['in', 'cacheRead', 'cacheWrite', 'out', 'total', 'turns']) {
      if (Number.isFinite(t[k])) out[k] += t[k];
    }
  }
  return any ? out : null;
}

/* Three possible sources, in descending order of truth:
     live      - Claude Code's own running total, the same number /cost prints
     reported  - its last checkpoint; exact but it lags
     estimate  - tokens x list price; always current, always an undercount
   An estimate is NEVER shown when an exact figure exists, and the one on screen
   is the only one that gets the approx sign. */
function costOf(sess) {
  const c = sess && sess.cost && typeof sess.cost === 'object' ? sess.cost : null;
  const lv = c && c.live && typeof c.live === 'object' ? c.live : null;
  const rep = c && c.reported && typeof c.reported === 'object' ? c.reported : null;
  const liveUsd = lv && Number.isFinite(lv.totalUsd) ? lv.totalUsd : null;
  const reported = rep && Number.isFinite(rep.totalUsd) ? rep.totalUsd : null;
  const est = c && Number.isFinite(c.estimatedUsd) ? c.estimatedUsd : null;
  if (liveUsd == null && reported == null && est == null) return null;
  const source = liveUsd != null ? 'live' : reported != null ? 'reported' : 'estimate';
  return {
    usd: liveUsd != null ? liveUsd : reported != null ? reported : est,
    approx: source === 'estimate',
    source: source,
    live: liveUsd, reported: reported, estimated: est,
    ageMs: lv && Number.isFinite(lv.ageMs) ? lv.ageMs : null,
    at: lv && lv.at != null ? lv.at : null,
    repAt: rep && (rep.at || rep.checkpointAt) ? (rep.at || rep.checkpointAt) : null,
    byModel: rep && rep.byModel && typeof rep.byModel === 'object' ? rep.byModel : null,
    coverage: c && Number.isFinite(c.estimatedCoverage) ? c.estimatedCoverage : null
  };
}
function sumCost(list) {
  let live = null, reported = null, est = null, ageMs = null;
  const byModel = {};
  let anyModel = false;
  for (const s of list) {
    const c = costOf(s);
    if (!c) continue;
    if (c.live != null) { live = (live || 0) + c.live; if (c.ageMs != null) ageMs = Math.max(ageMs == null ? 0 : ageMs, c.ageMs); }
    if (c.reported != null) reported = (reported || 0) + c.reported;
    if (c.estimated != null) est = (est || 0) + c.estimated;
    if (c.byModel) for (const k of Object.keys(c.byModel)) {
      if (Number.isFinite(c.byModel[k])) { byModel[k] = (byModel[k] || 0) + c.byModel[k]; anyModel = true; }
    }
  }
  if (live == null && reported == null && est == null) return null;
  const source = live != null ? 'live' : reported != null ? 'reported' : 'estimate';
  return {
    usd: live != null ? live : reported != null ? reported : est,
    approx: source === 'estimate', source: source, ageMs: ageMs,
    live: live, reported: reported, estimated: est,
    byModel: anyModel ? byModel : null
  };
}

/* `session.live` is the /usage block: context window + rate-limit windows. */
function liveOf(sess) {
  const l = sess && sess.live && typeof sess.live === 'object' ? sess.live : null;
  return l;
}
/* the counter is compact ($431); the tooltip behind it is exact ($430.67) */
function fmtUsd2(n) { return Number.isFinite(n) ? '$' + n.toFixed(2) : '—'; }

function costTitle(c) {
  if (!c) return 'no cost reported by this scan';
  const lines = [];
  if (c.source === 'live') {
    lines.push("Claude Code's own figure, updated " +
      (c.ageMs != null ? durShort(c.ageMs) + ' ago' : 'this turn') + '  ·  ' + fmtUsd2(c.live));
  } else if (c.source === 'reported') {
    lines.push('Claude Code checkpoint' +
      (c.repAt ? ' from ' + c.repAt : '') + ', may lag  ·  ' + fmtUsd2(c.reported));
  } else {
    lines.push('list-price estimate - it undercounts  ·  ' + fmtUsd2(c.estimated));
  }
  if (c.source !== 'reported' && c.reported != null) lines.push('checkpoint ' + fmtUsd2(c.reported));
  if (c.source !== 'estimate' && c.estimated != null) lines.push('list-price estimate ' + fmtUsd2(c.estimated));
  if (c.byModel) {
    const rows = Object.keys(c.byModel).map((k) => [k, c.byModel[k]]).sort((a, b) => b[1] - a[1]);
    for (const [m, v] of rows.slice(0, 6)) lines.push(m + ' ' + fmtUsd2(v));
  }
  if (c.coverage != null) lines.push('estimate covers ' + Math.round(c.coverage * 100) + '% of agents');
  return lines.join('  ·  ');
}
/* an agent's own dollar figure is always an estimate */
function agentCost(a) {
  if (!a) return null;
  if (a.costUnknownModel) return { usd: null, unknown: true, model: a.costModel || null };
  if (!Number.isFinite(a.costUsd)) return null;
  return { usd: a.costUsd, unknown: false, model: a.costModel || null };
}

/* Prefer what the scanner read off the main transcript; fall back to the most
   common model among this session's agents. */
function sessionModel(s) {
  if (!s) return null;
  let model = formatModel((s.main && s.main.model) || null);
  if (model) return model;
  const counts = new Map();
  for (const a of (s.agents || [])) if (a.model) counts.set(a.model, (counts.get(a.model) || 0) + 1);
  let best = -1;
  for (const [mm, c] of counts) if (c > best) { best = c; model = formatModel(mm); }
  return model;
}

/* The scanner may omit main entirely, or send it with every field null. */
function mainOf(sess) {
  const m = sess && sess.main;
  return (m && typeof m === 'object') ? m : {};
}
function mainIdleMs(sess) {
  const m = mainOf(sess);
  const t = parseTs(m.lastActivityAt);
  if (Number.isFinite(t)) return Date.now() - t;
  if (Number.isFinite(m.idleMs)) return m.idleMs + (Date.now() - (state.agentsAt || Date.now()));
  return NaN;
}
/* working = the main session itself is mid-turn; waiting = it is quiet but its
   agents are not; idle = nothing moving. */
function hubStateOf(sess, running) {
  if (mainOf(sess).status === 'running') return 'working';
  if ((running || 0) > 0) return 'waiting';
  return 'idle';
}
function hubStateLine(st, sess, running) {
  const m = mainOf(sess);
  const age = mainIdleMs(sess);
  const t = Number.isFinite(age) ? '  \u00b7  ' + durShort(age) : '';
  if (st === 'working') return '\u25cf WORKING' + (m.lastTool ? '  \u00b7  ' + m.lastTool : '') + t;
  if (st === 'waiting') return '\u25d0 WAITING ON ' + running + ' AGENT' + (running === 1 ? '' : 'S') + t;
  return '\u25cb IDLE' + t;
}

function pol(r, a) { return { x: r * Math.cos(a - Math.PI / 2), y: r * Math.sin(a - Math.PI / 2) }; }
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpAng(a, b, t) {
  let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + d * t;
}
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

/* Arc from a0 to a1 at radius r. `rev` draws it counter-clockwise, which is what
   keeps text on a textPath upright when the arc sits on the lower half. */
function arcPath(r, a0, a1, rev) {
  const span = a1 - a0;
  if (span <= 0.0005) return '';
  if (span >= TAU - 0.001) {
    const p = pol(r, 0), q = pol(r, Math.PI);
    return `M${p.x.toFixed(2)} ${p.y.toFixed(2)}A${r} ${r} 0 1 1 ${q.x.toFixed(2)} ${q.y.toFixed(2)}A${r} ${r} 0 1 1 ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  }
  const large = span > Math.PI ? 1 : 0;
  const p0 = pol(r, rev ? a1 : a0), p1 = pol(r, rev ? a0 : a1);
  const sweep = rev ? 0 : 1;
  return `M${p0.x.toFixed(2)} ${p0.y.toFixed(2)}A${r} ${r} 0 ${large} ${sweep} ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

/* mid-angle in the lower half of the circle -> the arc must run the other way */
function arcNeedsFlip(a0, a1) {
  const mid = ((a0 + a1) / 2 % TAU + TAU) % TAU;
  return mid > Math.PI * 0.5 && mid < Math.PI * 1.5;
}

/* ============================================================== FIXTURE */

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function distribute(total, n, rnd, min) {
  min = min || 0;
  const w = Array.from({ length: n }, () => 0.35 + rnd() * 1.3);
  const s = w.reduce((a, b) => a + b, 0);
  const out = w.map((x) => Math.max(min, Math.round(total * x / s)));
  let diff = total - out.reduce((a, b) => a + b, 0);
  let i = 0;
  while (diff !== 0 && i < n * 500) {
    const j = i % n;
    if (diff > 0) { out[j]++; diff--; }
    else if (out[j] > min) { out[j]--; diff++; }
    i++;
  }
  return out;
}

const FX_TYPES = ['general-purpose', 'Explore', 'Plan', 'claude', 'code-review', 'fork', 'claude-code-guide'];
const FX_MODELS = ['opus', 'opus', 'opus', 'sonnet'];
const FX_TOOLS = ['Bash', 'Read', 'Grep', 'Edit', 'Glob', 'Write', 'Agent', 'PowerShell', 'WebFetch'];
const FX_DESC = [
  'Audit base.css for unused rules',
  'Trace the SSE reconnect path in server.js',
  'Sweep the docs pages for stale asset hashes',
  'Find why the nightly report runs an hour late',
  'Measure first-paint on the landing page',
  'Rebuild the search index after content edits',
  'Verify the schema migration ran on boot',
  'Check the backup bucket for last night\'s dump',
  'Grep for hardcoded timestamps',
  'Diff local render against production HTML',
  'Enumerate Windows scheduled tasks and owners',
  'Cross-check the welcome email templates',
  'Look for orphaned node processes',
  'Read the CSV import grouping logic',
  'Confirm SPF and DKIM still pass',
  'Inspect cache headers on the og-image',
  'Summarise failed jobs in the last 24h',
  'Locate the form verification helper',
  'Trace rate-limit enforcement on the API',
  'Collect timings for the infra scan'
];
const FX_TEXT = [
  'Found 3 candidate call sites; two are dead code paths behind a feature flag that has been off since August.',
  'The reconnect uses a fixed 1s delay, not the documented backoff. Patch is a two-line change in the transport module.',
  'Every page shares the same ?v= query token, so a single bump invalidates them together.',
  'The job is scheduled in local time but the server runs in UTC, which explains the one-hour drift.',
  'Largest contentful paint lands at 1.24s on a cold cache; the hero font is the long pole.',
  'Regenerated. 412 documents indexed, 0 errors, index size 218 KB.',
  'migrate deploy ran during boot and reported "No pending migrations to apply".',
  'Five archives present, newest 4h old, 61 MB. Retention looks correct.',
  'No hardcoded instants found outside the test fixtures.',
  'Byte-identical except for the build hash and the generated timestamp comment.',
  'Twelve tasks registered; three are disabled and one has no principal set.',
  'Templates match except for the trailing signature block on the reminder email.',
  'Two node processes with no parent console; both are older than the last deploy.',
  'Rows are grouped by repeated header lines, so the parser resets state on each header.',
  'Both pass. The DKIM selector resolves through the DNS provider records.',
  'Cache-Control is public, max-age=14400, which matches the observed 4h staleness.',
  'Nine failed jobs, seven of them the same upstream timeout.',
  'It lives in the middleware layer and short-circuits before the route handler.',
  'Limits are enforced per IP, then per account once a session exists.',
  'Scan completed in 1.84s; the slowest probe is the remote HTTP health check.'
];

function fxAgents(rnd, sessionId, counts, now) {
  const agents = [];
  let seq = 0;
  const mk = (depth, parentId, ageBase) => {
    const idHex = Array.from({ length: 17 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
    const ageMs = Math.floor(ageBase * (0.35 + rnd() * 0.8));
    const idleMs = Math.floor(rnd() * Math.min(ageMs, 900000));
    const a = {
      id: idHex,
      agentType: FX_TYPES[Math.floor(rnd() * FX_TYPES.length)],
      description: FX_DESC[Math.floor(rnd() * FX_DESC.length)],
      model: FX_MODELS[Math.floor(rnd() * FX_MODELS.length)],
      spawnDepth: depth,
      parentId: parentId,
      toolUseId: 'toolu_01' + Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join(''),
      spawnedAt: new Date(now - ageMs).toISOString(),
      lastActivityAt: new Date(now - idleMs).toISOString(),
      ageMs: ageMs,
      idleMs: idleMs,
      status: 'done',
      lines: Math.floor(20 + rnd() * 900),
      bytes: Math.floor(4000 + rnd() * 260000),
      lastTool: FX_TOOLS[Math.floor(rnd() * FX_TOOLS.length)],
      lastText: FX_TEXT[Math.floor(rnd() * FX_TEXT.length)],
      _seq: seq++
    };
    agents.push(a);
    return a;
  };

  const d1 = Array.from({ length: counts[0] }, () => mk(1, null, 4200000));
  const d2spread = distribute(counts[1], counts[0], rnd, 1);
  const d2 = [];
  d1.forEach((p, i) => { for (let k = 0; k < d2spread[i]; k++) d2.push(mk(2, p.id, 2400000)); });
  if (counts[2] > 0 && d2.length) {
    const d3spread = distribute(counts[2], d2.length, rnd, 0);
    d2.forEach((p, i) => { for (let k = 0; k < d3spread[i]; k++) mk(3, p.id, 900000); });
  }

  // a few live workers, biased to the leaves
  const leaves = agents.filter((a) => !agents.some((b) => b.parentId === a.id));
  const nLive = Math.max(1, Math.round(leaves.length * 0.09));
  for (let i = 0; i < nLive; i++) {
    const t = leaves[Math.floor((i * 7 + 3) % leaves.length)];
    t.status = i % 5 === 4 ? 'spawning' : 'running';
    t.idleMs = Math.floor(rnd() * 9000);
    t.lastActivityAt = new Date(now - t.idleMs).toISOString();
  }
  // an agent waiting on a live descendant is itself running
  const byId = new Map(agents.map((a) => [a.id, a]));
  for (const a of agents) {
    if (a.status === 'done') continue;
    let p = a.parentId ? byId.get(a.parentId) : null;
    while (p) { if (p.status === 'done') p.status = 'running'; p = p.parentId ? byId.get(p.parentId) : null; }
  }
  for (const a of agents) delete a._seq;
  return agents;
}

function buildFixture() {
  const now = Date.now();
  const rnd = mulberry32(20260902);

  const s1Agents = fxAgents(rnd, 'a', [5, 18, 76], now);
  const s2Agents = fxAgents(rnd, 'b', [3, 6, 3], now);

  const mkSession = (id, slug, cwd, cwdReal, agents, activeAgo, active) => ({
    sessionId: id,
    projectSlug: slug,
    cwd: cwdReal,
    main: {
      lastTool: active ? 'Bash' : 'Read',
      lastText: active
        ? 'Kicked off the infra sweep; five branches out, waiting on the deepest one.'
        : 'Wrapped up: index regenerated and the changelog updated.',
      lastActivityAt: new Date(now - activeAgo).toISOString(),
      idleMs: activeAgo,
      status: active ? 'running' : 'idle',
      model: 'claude-fable-5-1'
    },
    startedAt: new Date(now - 5400000).toISOString(),
    lastActivityAt: new Date(now - activeAgo).toISOString(),
    isActive: active,
    agentCount: agents.length,
    runningCount: agents.filter((a) => a.status === 'running' || a.status === 'spawning').length,
    maxDepth: agents.reduce((m, a) => Math.max(m, a.spawnDepth), 0),
    agents: agents
  });

  const agentsSnap = {
    generatedAt: new Date(now).toISOString(),
    scanMs: 214,
    errors: [],
    sessions: [
      mkSession('3f6c9a12-5d4e-4b8a-9c21-7e0d5b6a4f83', 'C--Users-you', null, 'C:\\Users\\you', s1Agents, 2000, true),
      mkSession('8c1f2d90-4b77-42ae-9f31-2ad55e10c904', 'C--Users-you-projects-my-app', null, 'C:\\Users\\you\\projects\\my-app', s2Agents, 640000, false),
      mkSession('d42b6e11-0a35-4f18-8c62-71b3c9ff2210', 'C--Users-you-projects-web-app', null, 'C:\\Users\\you\\projects\\web-app', [], 9400000, false)
    ]
  };

  const infraSnap = {
    generatedAt: new Date(now).toISOString(),
    scanMs: 1840,
    errors: ['scheduled-tasks: 1 task could not be read (access denied): \\Microsoft\\Windows\\UpdateOrchestrator\\Reboot'],
    groups: [
      {
        id: 'railway', label: 'Deployed services', items: [
          { id: 'my-app-web', label: 'my-app', state: 'up', detail: '200 \u00b7 412 ms', sub: 'my-app.example.com', meta: { region: 'us-west1', replicas: 1, deploy: '188e232' } },
          { id: 'web-app', label: 'web-app', state: 'up', detail: '200 \u00b7 288 ms', sub: 'app.example.com', meta: { region: 'us-east4', replicas: 1 } },
          { id: 'marketing-site', label: 'Marketing site', state: 'up', detail: '200 \u00b7 173 ms', sub: 'example.com', meta: { region: 'us-east4' } },
          { id: 'worker', label: 'Background worker', state: 'hold', detail: 'manual hold', sub: 'paused 2026-08-13', meta: { reason: 'manual hold, do not restart' } },
          { id: 'staging', label: 'Staging', state: 'idle', detail: 'scaled to zero', sub: 'wakes on request', meta: { mode: 'sleep' } }
        ]
      },
      {
        id: 'crons', label: 'Scheduled jobs', items: [
          { id: 'nightly-backup', label: 'Nightly backup', state: 'armed', detail: 'in 6h 12m', sub: 'hosted cron \u2192 object storage', meta: { schedule: '0 7 * * *', last: 'ok, 61 MB' } },
          { id: 'digest', label: 'Daily digest', state: 'armed', detail: 'in 3h 04m', sub: 'per-account timezone', meta: { schedule: 'hourly fan-out' } },
          { id: 'data-sync', label: 'Data sync', state: 'disabled', detail: 'off', sub: 'manual import only', meta: { disabled_on: '2026-08-25' } },
          { id: 'index-rebuild', label: 'Search index rebuild', state: 'idle', detail: 'on demand', sub: 'search-index.json', meta: { docs: 412 } }
        ]
      },
      {
        id: 'tasks', label: 'Windows tasks', items: [
          { id: 'report-job', label: 'report-job', state: 'armed', detail: 'next 09:28', sub: 'daily report \u00b7 live', meta: { trigger: 'daily 09:28', last_result: '0x0' } },
          { id: 'weekly-cleanup', label: 'weekly-cleanup', state: 'idle', detail: 'ran 3d ago', sub: 'temp files \u00b7 old logs', meta: { last_result: '0x0' } },
          { id: 'mc-server', label: 'mission-control', state: 'up', detail: 'pid 24188', sub: 'localhost:7373', meta: { started: '12:58' } }
        ]
      },
      {
        id: 'local', label: 'Local processes', items: [
          { id: 'node-mc', label: 'node server.js', state: 'up', detail: '112 MB', sub: 'mission-control', meta: { pid: 24188, cpu: '0.4%' } },
          { id: 'chromium', label: 'chromium headless', state: 'idle', detail: '2 pages', sub: 'ms-playwright/chromium-1234', meta: { pid: 9012 } },
          { id: 'postgres', label: 'postgresql 17', state: 'down', detail: 'service stopped', sub: 'local db tests blocked', meta: { note: 'start the service to run them' } },
          { id: 'redis', label: 'redis', state: 'unknown', detail: 'not on PATH', sub: 'cache tests skipped', meta: { note: 'optional for local dev' } }
        ]
      }
    ]
  };

  return { agents: agentsSnap, infra: infraSnap };
}

let FIXTURE = null;

/* ============================================================== STATE */

const state = {
  agents: null,          // last agents snapshot
  infra: null,           // last infra snapshot
  agentsAt: 0,           // local ms when agents snapshot landed
  infraAt: 0,
  sessionId: null,
  activeOnly: lsGet('mc.activeOnly', '1') !== '0',
  scopeThis: true,
  fixture: false,
  haveReal: false,
  focusId: null,
  deepRequest: null,     // sessionId we have asked the server to deep-scan
  pinnedId: null,
  hoverId: null,
  hoverXY: null,
  // a phone has no room for the feed until you ask for it, but a stored choice
  // always wins over the default
  feedCollapsed: lsGet('mc.feedCollapsed', null) === null
    ? window.matchMedia('(max-width: 820px)').matches
    : lsGet('mc.feedCollapsed', '0') === '1',
  railOpen: lsGet('mc.railOpen', '1') !== '0',
  showOlder: lsGet('mc.showOlder', '0') === '1',
  mode: 'connecting'
};

/* view transform on the svg viewport group */
const view = { x: 0, y: 0, k: 1, user: false };

/* current tree */
let tree = { root: null, all: [], byId: new Map(), maxDepth: 0, agentCount: 0, runningCount: 0 };

/* layout: id -> {r, ang, depth, a0, a1} target; rendered: id -> {r, ang} */
let target = new Map();
let rendered = new Map();
let arcTarget = [];       // [{id, r, a0, a1, color, label, count, live}]
let arcGeom = new Map();  // id -> {r, a0, a1}  (geometry only, recomputed on structure change)
let arcRendered = new Map();
let layoutSig = '';
let Rout = 360;

/* dom caches */
const nodeEls = new Map();   // id -> {g, halo, body, hit, cls, r}
const edgeEls = new Map();   // childId -> {path, cls, color}
const arcEls = new Map();    // id -> {g, band, hit, label, count}
const railGroups = new Map();

/* ============================================================== DOM refs */

const D = {
  svg: $('graph'), vp: $('viewport'),
  lGlow: $('l-glow'), lRings: $('l-rings'), lArcs: $('l-arcs'),
  lEdges: $('l-edges'), lNodes: $('l-nodes'), lHub: $('l-hub'),
  stage: $('graph-stage'),
  sel: $('session-select'),
  ctRunning: $('ct-running'), ctAgents: $('ct-agents'), ctDepth: $('ct-depth'),
  ctTokens: $('ct-tokens'), ctTokensWrap: $('ct-tokens-wrap'),
  ctCost: $('ct-cost'), ctCostWrap: $('ct-cost-wrap'),
  ctModel: $('ct-model'), ctModelWrap: $('ct-model-wrap'),
  ct5h: $('ct-5h'), ct5hWrap: $('ct-5h-wrap'), ct5hSep: $('ct-5h-sep'),
  ctWeek: $('ct-week'), ctWeekWrap: $('ct-week-wrap'), ctWeekSep: $('ct-week-sep'),
  topSpend: $('topspend'), topSpendList: $('topspend-list'),
  tglActive: $('tgl-active'), tglScope: $('tgl-scope'),
  fixtureChip: $('fixture-chip'), olderBtn: $('tgl-older'),
  conn: $('conn'), connLabel: $('conn-label'), updated: $('updated'),
  graphSub: $('graph-sub'), railSub: $('rail-sub'),
  railBody: $('rail-body'), rail: $('rail'), railToggle: $('rail-toggle'),
  errStrip: $('err-strip'), errCount: $('err-count'), errList: $('err-list'),
  focusChip: $('focus-chip'), focusLabel: $('focus-label'), focusClear: $('focus-clear'),
  emptyNote: $('empty-note'), emptyText: $('empty-text'),
  emptyShowAll: $('empty-showall'), hint: $('hint'),
  detail: $('detail'), dDot: $('d-dot'), dType: $('d-type'), dStatus: $('d-status'),
  dDesc: $('d-desc'), dGrid: $('d-grid'), dLastText: $('d-lasttext'), dClose: $('d-close'),
  dLastLabel: $('d-lastlabel'),
  tooltip: $('tooltip'), btnReset: $('btn-reset'),
  feed: $('feed'), feedRows: $('feed-rows'),
  feedCount: $('feed-count'), feedToggle: $('feed-toggle'), feedEmpty: $('feed-empty'),
  tabAgents: $('tab-agents'), tabStack: $('tab-stack')
};

/* ============================================================== MC BRIDGE */

/* The one seam between app.js and stack-view.js. Everything the Stack view is
   allowed to reach lives here, so app.js keeps its internals and the second
   script never has to guess at a global. */
/* The stack module's display name and former ids, put in the page by the
   server (lib/modules.js: modules.stack.label / formerIds). Read before
   anything else so saved state under a former id is carried over first. */
const STACK_META = (function () {
  const out = { label: 'Stack', formerIds: [] };
  try {
    const m = document.querySelector('meta[name="mc-stack"]');
    const v = m ? JSON.parse(m.getAttribute('content')) : null;
    if (v && typeof v.label === 'string' && v.label.trim()) out.label = v.label.trim();
    if (v && Array.isArray(v.formerIds)) out.formerIds = v.formerIds.filter((x) => typeof x === 'string' && x);
  } catch (_) { /* an unfilled meta (no server) keeps the defaults */ }
  return out;
})();
(function migrateFormerIds() {
  for (const id of STACK_META.formerIds) {
    if (lsGet('mc.view', null) === id) lsSet('mc.view', 'stack');
    const moves = [['mc.feed.' + id, 'mc.feed.stack'], ['mc.' + id + 'Tiers', 'mc.stackTiers']];
    for (const [from, to] of moves) {
      const v = lsGet(from, null);
      if (v === null) continue;
      if (lsGet(to, null) === null) lsSet(to, v);
      try { localStorage.removeItem(from); } catch (_) { }
    }
  }
})();

const STORED_TAB = lsGet('mc.view', 'agents');

const MC = (window.MC = {
  /* `view` is what gets rendered (agents|stack); `tab` is the phone's four-way
     selection, which is what actually persists. */
  view: STORED_TAB === 'stack' ? 'stack' : 'agents',
  tab: /^(agents|stack|infra|feed)$/.test(STORED_TAB) ? STORED_TAB : 'agents',
  state: state,
  COL: COL,
  D: D,
  REDUCED: REDUCED,
  hooks: {},          // stack-view fills in: stack, viewchange, tick, resize, reset, escape, statusGlyph
  util: { $, el, svgEl, setText, setAttrIf, clamp, lsGet, lsSet, parseTs, rel, dur, durShort, num, bytes, trunc, short,
    fmtTokens, fmtUsd, tokensLine, tokensTitle },
  railGroups: railGroups,
  stackLabel: STACK_META.label,                       // as configured, e.g. "Stack"
  stackUpper: STACK_META.label.toUpperCase(),
  stackLower: STACK_META.label.toLowerCase(),
  setView: setView,
  unpin: unpin,
  refreshFeedCount: refreshFeedCount,
  refreshAgents: function () { applyFocus(true); renderGraph(); },
  setTitle: updateTitle,
  /* the symmetric partners of MC.stack.apply - a frame can be pushed in without
     waiting for the server to produce one */
  applyAgents: function (snap) { applyAgents(snap); },
  applyInfra: function (snap) { applyInfra(snap); }
});

function callHook(name, arg) {
  const f = MC.hooks[name];
  if (typeof f !== 'function') return undefined;
  try { return f(arg); } catch (err) { console.error('[stack hook ' + name + ']', err); }
}

/* `hooks` is one slot per name - the Stack view owns those. Anything that wants
   to observe a stream WITHOUT taking it over subscribes here instead, so
   history-ui.js and stack-view.js can both watch the same frames. */
const listeners = Object.create(null);
MC.on = function (name, fn) {
  if (typeof fn !== 'function') return;
  (listeners[name] || (listeners[name] = [])).push(fn);
};
MC.emit = function (name, arg) {
  const l = listeners[name];
  if (!l) return;
  for (const f of l) {
    try { f(arg); } catch (err) { console.error('[mc:' + name + ']', err); }
  }
};

/* OPTIONAL SERVER MODULES. /api/health lists the optional modules the server
   runs (`modules: { stack: { enabled, reason } }`). Only an explicit
   `enabled: false` turns one off: no answer, an error, or an older server with
   no `modules` leaves every view exactly as it always was. */
function moduleOffIn(modules, name) {
  const m = (modules && typeof modules === 'object') ? modules[name] : null;
  return !!(m && typeof m === 'object' && m.enabled === false);
}
MC.modules = null;                                  // set once /api/health answers
MC.moduleOff = (name) => moduleOffIn(MC.modules, name);
MC.stackOff = () => moduleOffIn(MC.modules, 'stack');

/* AGENTS <-> STACK. The rail and the feed strip stay in both; only the panel
   body, the header widgets and the feed rows swap. */
function setView(v) {
  const next = v === 'stack' && !MC.stackOff() ? 'stack' : 'agents';
  if (MC.view === next) return;
  MC.view = next;
  lsSet('mc.view', next);
  hideTooltip();
  callHook('viewchange', next);
  // TOP SPEND is about agents; renderGraph is what normally hides it and it does
  // not run on a bare view switch
  renderSpend();
  MC.emit('view', next);
  // a direct setView (keys, desktop tabs) must not leave the phone nav stale
  if (MC.tab !== next && MC.tab !== 'infra' && MC.tab !== 'feed') {
    MC.tab = next;
    document.body.dataset.tab = next;
    paintNav();
  }
  updateTitle();
}

/* ============================================================== TREE */

function nodeKey(sessionId, agentId) { return 'A|' + sessionId + '|' + agentId; }

/* A shallow session is listed but not scanned: agentCount is real, agents[] is
   empty and runningCount/maxDepth are null until we ask for it by id. */
function isShallow(s) { return !!(s && s.shallow === true); }
function sessionById(id) {
  const snap = state.agents;
  if (!snap || !id) return null;
  return (snap.sessions || []).find((s) => s.sessionId === id) || null;
}
/* Weight a session with no loaded agents by its agentCount so the overview does
   not give a 184-agent history session the same sliver as a 1-agent one. */
function sessionWeight(s) { return clamp(1, Math.round(Math.sqrt((s && s.agentCount) || 1)), 14); }

function buildTree() {
  const snap = state.agents;
  const sessions = snap && Array.isArray(snap.sessions) ? snap.sessions.slice() : [];
  sessions.sort((a, b) => (parseTs(b.lastActivityAt) || 0) - (parseTs(a.lastActivityAt) || 0));

  const multi = !state.scopeThis && sessions.length > 1;
  const picked = multi ? sessions : sessions.filter((s) => s.sessionId === state.sessionId);

  const root = {
    id: '__hub__', kind: 'hub', depth: 0, parent: null, children: [],
    data: multi ? null : (picked[0] || null),
    live: false
  };
  const byId = new Map([[root.id, root]]);

  for (const s of picked) {
    let parentForRoots = root;
    if (multi) {
      const sn = {
        id: 'S|' + s.sessionId, kind: 'session', depth: 1, parent: root, children: [],
        data: s, live: !!s.isActive, status: s.runningCount > 0 ? 'running' : 'done'
      };
      root.children.push(sn); byId.set(sn.id, sn);
      parentForRoots = sn;
    }
    const agents = Array.isArray(s.agents) ? s.agents : [];
    const local = new Map();
    for (const a of agents) {
      const n = {
        id: nodeKey(s.sessionId, a.id), kind: 'agent', depth: 0, parent: null, children: [],
        data: a, session: s, status: a.status || 'done'
      };
      local.set(a.id, n); byId.set(n.id, n);
    }
    // stable ordering: spawn time, then id
    const ordered = agents.slice().sort((x, y) => {
      const dx = parseTs(x.spawnedAt) || 0, dy = parseTs(y.spawnedAt) || 0;
      return dx - dy || String(x.id).localeCompare(String(y.id));
    });
    for (const a of ordered) {
      const n = local.get(a.id);
      const p = a.parentId ? local.get(a.parentId) : null;
      n.parent = p || parentForRoots;
      n.parent.children.push(n);
    }
  }

  // Full-session numbers are taken BEFORE pruning: the history is hidden from
  // the graph, never from the counters.
  let fullAgents = 0, fullRunning = 0, fullDepth = 0;
  for (const s of picked) {
    fullAgents += (s.agentCount || 0);
    const arr = Array.isArray(s.agents) ? s.agents : [];
    if (arr.length) {
      for (const a of arr) {
        if (a.status === 'running' || a.status === 'spawning') fullRunning++;
        if ((a.spawnDepth || 0) > fullDepth) fullDepth = a.spawnDepth || 0;
      }
    } else {
      if (s.runningCount != null) fullRunning += s.runningCount;
      if (s.maxDepth != null && s.maxDepth > fullDepth) fullDepth = s.maxDepth;
    }
  }

  // ACTIVE ONLY keeps three kinds of node:
  //   live     - running / spawning
  //   linger   - finished within LINGER_MS, fading out over that window
  //   ancestor - neither, but on the path from the hub to something visible
  if (state.activeOnly) {
    const keep = (n) => {
      n.children = n.children.filter(keep);
      let self = false;
      if (n.kind === 'agent') {
        if (n.status === 'running' || n.status === 'spawning') { n.vis = 'live'; self = true; }
        else if (agentIdleMs(n.data, state.agentsAt) < LINGER_MS) { n.vis = 'linger'; self = true; }
        else { n.vis = 'ancestor'; }
      } else {
        // a session earns its own place if it is live or has busy agents
        n.vis = 'live';
        self = !!(n.data && (n.data.isActive || (n.data.runningCount || 0) > 0));
      }
      return self || n.children.length > 0;
    };
    root.children = root.children.filter(keep);
  } else {
    const clear = (n) => { n.vis = 'full'; for (const c of n.children) clear(c); };
    for (const c of root.children) clear(c);
  }

  // depths + collect reachable
  const all = [];
  let maxDepth = 0, agentCount = 0, runningCount = 0;
  const walk = (n, d) => {
    n.depth = d;
    if (d > maxDepth) maxDepth = d;
    all.push(n);
    if (n.kind === 'agent') {
      agentCount++;
      if (n.status === 'running' || n.status === 'spawning') runningCount++;
    }
    for (const c of n.children) walk(c, d + 1);
    n.live = n.kind === 'agent'
      ? (n.status === 'running' || n.status === 'spawning' || n.children.some((c) => c.live))
      : n.children.some((c) => c.live) || !!n.live;
  };
  walk(root, 0);

  const reachable = new Map(all.map((n) => [n.id, n]));
  const hubSess = multi ? null : (picked[0] || null);
  const hubState = multi
    ? (picked.some((x) => mainOf(x).status === 'running') ? 'working' : (fullRunning > 0 ? 'waiting' : 'idle'))
    : hubStateOf(hubSess, fullRunning);
  tree = { root, all, byId: reachable, maxDepth, agentCount, runningCount, multi, sessions, picked,
    fullAgents, fullRunning, fullDepth, hubState };
  return tree;
}

/* ============================================================== LAYOUT */

function computeLeaves(n) {
  if (!n.children.length) {
    n.leaves = n.kind === 'session' ? sessionWeight(n.data) : 1;
    return n.leaves;
  }
  let s = 0;
  for (const c of n.children) s += computeLeaves(c);
  n.leaves = s;
  return s;
}

function assignSpans(n, a0, a1, depth) {
  n.a0 = a0; n.a1 = a1; n.ang = (a0 + a1) / 2;
  const kids = n.children;
  if (!kids.length) return;
  const total = kids.reduce((s, k) => s + k.leaves, 0) || 1;
  const span = a1 - a0;
  // breathing room between sibling subtrees, strongest near the hub
  const gapFrac = depth === 0 ? 0.16 : depth === 1 ? 0.10 : depth === 2 ? 0.05 : 0;
  const gapTotal = kids.length > 1 ? span * gapFrac : 0;
  const gap = kids.length > 1 ? gapTotal / kids.length : 0;
  const usable = span - gapTotal;
  let cur = a0 + gap / 2;
  for (const k of kids) {
    const w = usable * (k.leaves / total);
    assignSpans(k, cur, cur + w, depth + 1);
    cur += w + gap;
  }
}

/* A shallow visible set should not be flung out onto the geometry of a deep one:
   four running agents on a one-ring tree belong close in, not on a 105-node rim. */
const DEPTH_SCALE = [0, 0.46, 0.74, 1, 1, 1];
function ringR(d, D_) {
  if (d <= 0) return 0;
  const outer = Rout * DEPTH_SCALE[Math.min(D_, DEPTH_SCALE.length - 1)];
  return outer * Math.pow(d / D_, RING_POW);
}

function nodeRadius(n) {
  if (n.kind === 'hub') return NODE_R[0];
  if (n.kind === 'session') {
    return isShallow(n.data)
      ? clamp(2.4, 1.8 + Math.sqrt((n.data && n.data.agentCount) || 0) * 0.42, 5.5)
      : clamp(6, 4 + Math.sqrt(n.leaves || 1) * 0.9, 12);
  }
  return NODE_R[Math.min(n.depth, NODE_R.length - 1)];
}

function depthColor(n) {
  if (n.kind === 'hub' || n.kind === 'session') return COL.hub;
  const i = tree.multi ? n.depth - 1 : n.depth;
  return DEPTH_COL[clamp(1, i, 3)];
}

function structureSig() {
  const parts = [];
  for (const n of tree.all) parts.push(n.id + '>' + (n.parent ? n.parent.id : '-'));
  parts.sort();
  return tree.maxDepth + '#' + Math.round(Rout) + '#' + parts.join(',');
}

/* Geometry only. Runs when the id set / parent structure / panel size changes. */
function computeLayout() {
  const D_ = Math.max(1, tree.maxDepth);
  assignSpans(tree.root, 0, TAU, 0);

  target = new Map();
  for (const n of tree.all) {
    target.set(n.id, { r: ringR(n.depth, D_), ang: n.ang, depth: n.depth, a0: n.a0, a1: n.a1 });
  }

  // subtree bands: the top-level branches of the hub
  const bandR = ringR(D_, D_) + 24;
  arcGeom = new Map();
  for (const c of tree.root.children) arcGeom.set(c.id, { r: bandR, a0: c.a0, a1: c.a1 });
}

/* Metadata refresh - runs every snapshot so live/count stay current. */
function buildArcTarget() {
  arcTarget = [];
  for (const c of tree.root.children) {
    const g = arcGeom.get(c.id);
    if (!g) continue;
    // a band groups a subtree; a childless node (or a one/two-leaf branch) has
    // nothing to group and the sliver just reads as debris
    if (!c.children.length || c.leaves < 3) continue;
    const label = c.kind === 'session'
      ? (c.data ? c.data.projectSlug || short(c.data.sessionId) : 'session')
      : (c.data ? (c.data.description || c.data.agentType || 'agent') : 'agent');
    // the label rides the arc, so it can only be as long as the arc is
    const arcLen = (g.r + 12) * Math.max(0, g.a1 - g.a0);
    const maxChars = clamp(0, Math.floor(arcLen / 6.9) - 5, 34);
    arcTarget.push({
      id: c.id, r: g.r, a0: g.a0, a1: g.a1,
      color: depthColor(c),
      label: maxChars >= 6 ? trunc(String(label).toUpperCase(), maxChars) : '',
      count: c.leaves, live: c.live
    });
  }
}

/* ============================================================== MORPH */

let morph = null, morphRaf = 0;

function beginMorph() {
  if (REDUCED.matches || rendered.size === 0) { snapToTarget(); return; }
  const from = new Map();
  for (const [id, p] of rendered) from.set(id, { r: p.r, ang: p.ang });
  const fromArc = new Map(arcRendered);
  morph = { t0: performance.now(), from, fromArc };
  if (!morphRaf) morphRaf = requestAnimationFrame(morphStep);
}

function snapToTarget() {
  rendered = new Map();
  for (const [id, p] of target) rendered.set(id, { r: p.r, ang: p.ang });
  arcRendered = new Map();
  for (const a of arcTarget) arcRendered.set(a.id, { r: a.r, a0: a.a0, a1: a.a1 });
  paintPositions();
}

function morphStep(now) {
  morphRaf = 0;
  if (!morph) return;
  const t = clamp(0, (now - morph.t0) / MORPH_MS, 1);
  const e = easeOut(t);
  rendered = new Map();
  for (const [id, p] of target) {
    const f = morph.from.get(id);
    rendered.set(id, f ? { r: lerp(f.r, p.r, e), ang: lerpAng(f.ang, p.ang, e) } : { r: p.r, ang: p.ang });
  }
  arcRendered = new Map();
  for (const a of arcTarget) {
    const f = morph.fromArc.get(a.id);
    arcRendered.set(a.id, f
      ? { r: lerp(f.r, a.r, e), a0: lerpAng(f.a0, a.a0, e), a1: lerpAng(f.a1, a.a1, e) }
      : { r: a.r, a0: a.a0, a1: a.a1 });
  }
  paintPositions();
  if (t < 1) morphRaf = requestAnimationFrame(morphStep);
  else morph = null;
}

/* Writes only geometry (transforms + path d). Called per morph frame. */
function paintPositions() {
  for (const [id, e] of nodeEls) {
    const p = rendered.get(id); if (!p) continue;
    const q = pol(p.r, p.ang);
    e.g.setAttribute('transform', `translate(${q.x.toFixed(2)} ${q.y.toFixed(2)})`);
  }
  for (const [id, e] of edgeEls) {
    const n = tree.byId.get(id); if (!n || !n.parent) continue;
    const cp = rendered.get(id), pp = rendered.get(n.parent.id);
    if (!cp || !pp) continue;
    const c = pol(cp.r, cp.ang), p = pol(pp.r, pp.ang);
    const mx = (c.x + p.x) / 2, my = (c.y + p.y) / 2;
    const k = 0.72; // pull the control point toward the hub -> bundled curves
    e.path.setAttribute('d',
      `M${p.x.toFixed(2)} ${p.y.toFixed(2)}Q${(mx * k).toFixed(2)} ${(my * k).toFixed(2)} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`);
  }
  for (const [id, e] of arcEls) {
    const p = arcRendered.get(id); if (!p) continue;
    const d = arcPath(p.r, p.a0, p.a1, false);
    e.band.setAttribute('d', d);
    e.hit.setAttribute('d', d);
    // the label rides a second, slightly wider arc, reversed on the lower half
    const flip = arcNeedsFlip(p.a0, p.a1);
    // glyphs grow outward on a clockwise path and inward on a reversed one, so
    // the two radii differ in order to land the text in the same band either way
    e.lpath.setAttribute('d', arcPath(p.r + (flip ? 22 : 13), p.a0, p.a1, flip));
  }
}

/* ============================================================== GRAPH RENDER */

function ensureStaticLayers() {
  if (!D.lGlow.firstChild) {
    D.lGlow.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 200, fill: 'url(#hubGlow)' }));
  }
}

function renderRings() {
  D.lRings.textContent = '';
  if (!tree.root.children.length) return;
  const D_ = Math.max(1, tree.maxDepth);
  const want = [];
  for (let d = 1; d <= D_; d++) want.push(d);
  for (const d of want) {
    const r = ringR(d, D_);
    D.lRings.appendChild(svgEl('circle', { class: 'ring-guide', cx: 0, cy: 0, r: r.toFixed(2) }));
    const t = svgEl('text', { class: 'ring-label', x: 0, y: (-r + 3).toFixed(2) });
    t.textContent = tree.multi && d === 1 ? 'SESSIONS' : 'D' + (tree.multi ? d - 1 : d);
    D.lRings.appendChild(t);
  }
  const glow = D.lGlow.firstChild;
  if (glow) glow.setAttribute('r', Math.max(140, ringR(1, D_) * 1.5).toFixed(0));
}

let arcSeq = 0;

function renderArcs() {
  const seen = new Set();
  for (const a of arcTarget) {
    seen.add(a.id);
    let e = arcEls.get(a.id);
    if (!e) {
      const pathId = 'mc-arc-' + (arcSeq++);
      const g = svgEl('g', { class: 'arc-g' });
      g.dataset.id = a.id;
      const band = svgEl('path', { class: 'arc-band' });
      const hit = svgEl('path', { class: 'arc-hit' });
      const lpath = svgEl('path', { class: 'arc-labelpath', id: pathId });
      const label = svgEl('text', { class: 'arc-label' });
      const tp = svgEl('textPath', { href: '#' + pathId, startOffset: '50%', 'text-anchor': 'middle' });
      const tspan = document.createElementNS(SVGNS, 'tspan');
      const cspan = document.createElementNS(SVGNS, 'tspan');
      cspan.setAttribute('class', 'arc-count');
      tp.appendChild(tspan); tp.appendChild(cspan);
      label.appendChild(tp);
      g.appendChild(band); g.appendChild(lpath); g.appendChild(hit); g.appendChild(label);
      D.lArcs.appendChild(g);
      e = { g, band, hit, lpath, label, tspan, cspan, cls: '' };
      arcEls.set(a.id, e);
    }
    setAttrIf(e.band, 'stroke', a.color);
    setText(e.tspan, a.label ? a.label + '  ' : '');
    setText(e.cspan, a.label ? String(a.count) : '');
    const cls = 'arc-g' + (a.live ? ' has-live' : '');
    if (e.cls !== cls) { e.g.setAttribute('class', cls); e.cls = cls; }
  }
  for (const [id, e] of arcEls) if (!seen.has(id)) { e.g.remove(); arcEls.delete(id); }
}

function renderHub() {
  const root = tree.root;
  let g = D.lHub.firstChild;
  if (!g) {
    g = svgEl('g', { class: 'hub' });
    g.appendChild(svgEl('circle', { class: 'hub-pulse', cx: 0, cy: 0, r: 30 }));
    const p2 = svgEl('circle', { class: 'hub-pulse p2', cx: 0, cy: 0, r: 30 });
    g.appendChild(p2);
    g.appendChild(svgEl('circle', { class: 'hub-core', cx: 0, cy: 0, r: 26 }));
    g.appendChild(svgEl('circle', { class: 'hub-inner', cx: 0, cy: 0, r: 6 }));
    const l1 = svgEl('text', { class: 'hub-label l1', x: 0, y: 46 });
    const l2 = svgEl('text', { class: 'hub-label l2', x: 0, y: 60 });
    const l3 = svgEl('text', { class: 'hub-label l3', x: 0, y: 73 });
    g.appendChild(l1); g.appendChild(l2); g.appendChild(l3);
    D.lHub.appendChild(g);
  }
  const [l1, l2, l3] = [g.children[4], g.children[5], g.children[6]];
  const s = root.data;
  const st = tree.hubState || 'idle';
  if (tree.multi) {
    setText(l1, 'MISSION CONTROL');
    setText(l2, tree.picked.length + ' SESSIONS');
    setText(l3, '\u25cf ' + tree.fullRunning + ' RUNNING  \u00b7  ' + tree.fullAgents + ' agents');
  } else if (s) {
    const model = sessionModel(s);
    // MODEL · ctx 34% · 1.2M tok · $431 - each clause appears only once reported
    const mt = tkTotal(mainOf(s));
    const lv = liveOf(s);
    const ctx = lv && Number.isFinite(lv.contextPct) ? Math.round(lv.contextPct) : null;
    // prefer the session's EXACT dollar figure; the main-transcript estimate is
    // only the fallback, and an estimated session total is the last resort
    const sc = costOf(s);
    const hubUsd = sc && !sc.approx ? sc.usd
      : Number.isFinite(mainOf(s).costUsd) ? mainOf(s).costUsd
        : (sc ? sc.usd : null);
    const hubApprox = !(sc && !sc.approx);
    setText(l1, 'MAIN SESSION');
    setText(l2, PHONE.matches
      ? (model || 'CLAUDE') + (ctx != null ? ' · ctx ' + ctx + '%' : '')
      : (model || 'CLAUDE') +
        (ctx != null ? ' · ctx ' + ctx + '%' : '') +
        (mt != null ? ' · ' + fmtTokens(mt) + ' tok' : '') +
        (Number.isFinite(hubUsd) ? ' · ' + (hubApprox ? '≈' : '') + fmtUsd(hubUsd) : ''));
    setText(l3, hubStateLine(st, s, tree.fullRunning));
  } else {
    setText(l1, 'MAIN SESSION'); setText(l2, '\u2014'); setText(l3, '');
  }
  setAttrIf(l3, 'class', 'hub-label l3 hub-state s-' + st);
  setAttrIf(g, 'class', 'hub');
  setAttrIf(g, 'data-state', st);
}

function nodeClass(n) {
  let c = 'node st-' + (n.kind === 'agent' ? n.status : (n.live ? 'running' : 'done'));
  if (n.kind === 'session') c += ' is-session';
  if (n.kind === 'session' && isShallow(n.data)) c += ' is-shallow';
  return c;
}

/* 1.0 the instant it finishes, LINGER_MIN_OP by the time it drops off */
function lingerOpacity(n) {
  const t = clamp(0, agentIdleMs(n.data, state.agentsAt) / LINGER_MS, 1);
  return Math.round((1 - (1 - LINGER_MIN_OP) * t) * 100) / 100;
}

/* Mark an element as departing so it fades instead of vanishing; revive it if
   the same id comes back before the fade finishes. */
function setDeparting(e, el, gone, drop) {
  if (gone && !e.dead) {
    e.dead = true;
    el.style.opacity = '';
    e.fade = undefined;
    el.classList.add('leaving');
    e.deadTimer = setTimeout(drop, LEAVE_MS);
  } else if (!gone && e.dead) {
    e.dead = false;
    clearTimeout(e.deadTimer);
    el.classList.remove('leaving');
  }
  return e.dead;
}

function renderNodes() {
  // departed nodes fade out rather than blinking away
  for (const [id, e] of nodeEls) {
    if (id === '__hub__') { e.g.remove(); nodeEls.delete(id); continue; }
    setDeparting(e, e.g, !tree.byId.has(id), () => { e.g.remove(); nodeEls.delete(id); });
  }
  for (const [id, e] of edgeEls) {
    const nn = tree.byId.get(id);
    setDeparting(e, e.path, !nn || !nn.parent, () => { e.path.remove(); edgeEls.delete(id); });
  }

  for (const n of tree.all) {
    if (n.kind === 'hub') continue;
    const r = nodeRadius(n);
    const col = depthColor(n);

    // edge
    if (n.parent) {
      let ee = edgeEls.get(n.id);
      if (!ee) {
        const path = svgEl('path', { class: 'edge' });
        D.lEdges.appendChild(path);
        ee = { path, cls: '', color: '' };
        edgeEls.set(n.id, ee);
      }
      if (ee.color !== col) { ee.path.setAttribute('stroke', col); ee.color = col; }
      const ecls = 'edge'
        + ((n.status === 'running' || n.status === 'spawning' || (n.kind !== 'agent' && n.live)) ? ' live' : '')
        + (n.kind === 'session' && isShallow(n.data) ? ' faint' : '')
        + (n.vis === 'ancestor' ? ' is-ghost' : '');
      if (ee.cls !== ecls) { ee.path.setAttribute('class', ecls); ee.cls = ecls; }
      // a lingering node's edge fades with it (0.34 is the .edge base opacity)
      if (n.vis === 'linger') {
        const eo = +(0.34 * lingerOpacity(n)).toFixed(2);
        if (ee.fade !== eo) { ee.path.style.opacity = String(eo); ee.fade = eo; }
      } else if (ee.fade !== undefined) { ee.path.style.opacity = ''; ee.fade = undefined; }
    }

    // node
    let e = nodeEls.get(n.id);
    if (!e) {
      const g = svgEl('g', { class: 'node enter' });
      g.dataset.id = n.id;
      const halo = svgEl('circle', { class: 'halo', cx: 0, cy: 0, r: r });
      const body = svgEl('circle', { class: 'body', cx: 0, cy: 0, r: r });
      const hit = svgEl('circle', { class: 'hit', cx: 0, cy: 0, r: hitR(r) });
      g.appendChild(halo); g.appendChild(body); g.appendChild(hit);
      D.lNodes.appendChild(g);
      e = { g, halo, body, hit, cls: '', r: 0, hr: hitR(r), color: '' };
      nodeEls.set(n.id, e);
      setTimeout(() => g.classList.remove('enter'), 500);
    }
    if (e.r !== r) {
      e.halo.setAttribute('r', r); e.body.setAttribute('r', r); e.r = r;
    }
    const hr = hitR(r);
    if (e.hr !== hr) { e.hit.setAttribute('r', hr); e.hr = hr; }
    if (e.color !== col) {
      e.body.setAttribute('fill', col); e.body.setAttribute('stroke', col); e.color = col;
    }
    let cls = nodeClass(n);
    if (n.vis === 'ancestor') cls += ' is-ghost';
    if (n.id === state.pinnedId) cls += ' sel';
    if (n.id === state.hoverId) cls += ' hov';
    if (e.cls !== cls) { e.g.setAttribute('class', cls); e.cls = cls; }
    // inline so the 1s tick can walk it continuously without a re-render
    if (n.vis === 'linger') {
      const o = lingerOpacity(n);
      if (e.fade !== o) { e.g.style.opacity = String(o); e.fade = o; }
    } else if (e.fade !== undefined) { e.g.style.opacity = ''; e.fade = undefined; }
  }
}

let lastFocusSig = ' ';

/* ============================================================== SPEND */

/* The TOKENS and COST counters and the TOP SPEND line. Every field here is
   optional - an older frame, a shallow session or a scan that could not price
   a model all land on an em dash rather than a zero or a throw. */
function renderSpend() {
  const picked = Array.isArray(tree.picked) ? tree.picked : [];
  const tot = sumTokens(picked);
  setText(D.ctTokens, tot ? fmtTokens(tot.total) : '—');
  const pend = picked.some((s) => s && (s.tokensPending || mainOf(s).tokensPending));
  const appr = picked.some((s) => s && (s.tokensApprox || mainOf(s).tokensApprox));
  D.ctTokensWrap.title = tokensTitle(tot, picked.length === 1 ? 'session tokens' : picked.length + ' sessions') +
    (pend ? '\n(still counting)' : '') + (appr ? '\n(approximate)' : '');

  const c = sumCost(picked);
  setText(D.ctCost, c ? (c.approx ? '≈' : '') + fmtUsd(c.usd) : '—');
  D.ctCostWrap.title = costTitle(c);

  // the phone chip grid carries a sixth cell the topbar has no room for
  if (D.ctModel) {
    const m = picked.length === 1 ? sessionModel(picked[0]) : null;
    setText(D.ctModel, m || (tree.multi ? String(picked.length) + ' SESS' : '—'));
    D.ctModelWrap.title = m ? 'model reported by the main transcript' : 'no model reported';
  }

  // the /usage windows, when Claude Code reported them
  const rl = (picked.length === 1 ? (liveOf(picked[0]) || {}).rateLimits : null) || null;
  limitChip(D.ct5h, D.ct5hWrap, D.ct5hSep, rl && rl.fiveHour, '5-hour');
  limitChip(D.ctWeek, D.ctWeekWrap, D.ctWeekSep, rl && rl.sevenDay, '7-day');

  // the three most expensive agents in the watched session
  let rows = [];
  for (const s of picked) {
    for (const a of (Array.isArray(s.agents) ? s.agents : [])) {
      if (Number.isFinite(a.costUsd)) rows.push(a);
    }
  }
  const show = rows.length >= 3 && MC.view === 'agents';
  if (D.topSpend.hidden === show) D.topSpend.hidden = !show;
  if (!show) return;
  rows.sort((x, y) => y.costUsd - x.costUsd);
  rows = rows.slice(0, 3);
  // "$28.2 general-purpose x3" says nothing; when the types collide the task is
  // the only thing that tells the three apart
  const types = rows.map((a) => String(a.agentType || 'agent'));
  const collide = new Set(types).size < types.length;
  setText(D.topSpendList, rows
    .map((a, i) => fmtUsd(a.costUsd) + ' ' +
      trunc(collide ? String(a.description || types[i]) : types[i], 22))
    .join('  ·  '));
  D.topSpend.title = 'most expensive agents in this session\n' + rows
    .map((a) => fmtUsd2(a.costUsd) + '  ' + (a.agentType || 'agent') + '  ·  ' + trunc(a.description || '', 60))
    .join('\n');
}

/* A rate-limit window as a percent chip. Hidden - along with its separator -
   whenever the scan did not report one. */
function limitChip(bEl, wrap, sep, lim, label) {
  if (!bEl || !wrap) return;
  const on = !!(lim && Number.isFinite(lim.pct));
  if (wrap.hidden === on) wrap.hidden = !on;
  if (sep && sep.hidden === on) sep.hidden = !on;
  if (!on) return;
  const p = Math.round(lim.pct);
  setText(bEl, p + '%');
  const cls = 'ct ct-lim' + (p >= 90 ? ' lim-bad' : p >= 70 ? ' lim-warn' : '');
  if (wrap.className !== cls) wrap.className = cls;
  const left = Number.isFinite(lim.resetsAt) ? lim.resetsAt - Date.now() : NaN;
  wrap.title = label + ' window at ' + p + '%' +
    (Number.isFinite(left) && left > 0 ? '\nresets in ' + dur(left) : '');
}

function applyFocus(force) {
  const sig = String(state.focusId);
  if (!force && sig === lastFocusSig) return;
  lastFocusSig = sig;
  const focusSet = new Set();
  if (state.focusId && tree.byId.has(state.focusId)) {
    const root = tree.byId.get(state.focusId);
    const down = (n) => { focusSet.add(n.id); for (const c of n.children) down(c); };
    down(root);
    let p = root.parent; while (p) { focusSet.add(p.id); p = p.parent; }
  }
  const on = focusSet.size > 0;
  for (const [id, e] of nodeEls) e.g.classList.toggle('dimmed', on && !focusSet.has(id));
  for (const [id, e] of edgeEls) e.path.classList.toggle('dimmed', on && !focusSet.has(id));
  for (const [id, e] of arcEls) e.g.classList.toggle('dimmed', on && !focusSet.has(id));

  // both overlays live in the shared stage, so they stay down over the Stack map
  D.focusChip.hidden = !on || MC.view !== 'agents';
  if (on) {
    const n = tree.byId.get(state.focusId);
    const d = n.data || {};
    setText(D.focusLabel, trunc(d.description || d.projectSlug || d.agentType || 'subtree', 48) +
      '  \u00b7  ' + (n.leaves != null ? n.leaves : n.children.length) + ' leaves');
  }
}

function fitView() {
  const w = D.stage.clientWidth || 900, h = D.stage.clientHeight || 600;
  D.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const nextR = clamp(180, Math.min(w, h) / 2 - 72, 470);
  const changed = Math.abs(nextR - Rout) > 0.5;
  Rout = nextR;
  if (!view.user) { view.x = w / 2; view.y = h / 2; view.k = 1; applyView(); }
  return changed;
}

function applyView() {
  D.vp.setAttribute('transform', `translate(${view.x.toFixed(2)} ${view.y.toFixed(2)}) scale(${view.k.toFixed(4)})`);
}

function renderGraph() {
  buildTree();
  ensureStaticLayers();
  computeLeaves(tree.root);

  const sig = structureSig();
  const structural = sig !== layoutSig;
  if (structural) {
    layoutSig = sig;
    computeLayout();
    renderRings();
  }
  buildArcTarget();
  renderNodes();
  renderArcs();
  if (structural) beginMorph();
  renderHub();
  applyFocus(structural);

  // A shallow session with agentCount > 0 is not empty, it is unscanned.
  const selSession = tree.multi ? null : tree.root.data;
  const selShallow = !!(selSession && isShallow(selSession));
  const selCount = selSession ? (selSession.agentCount || 0) : 0;
  const empty = tree.root.children.length === 0;
  const showEmpty = empty && MC.view === 'agents';
  if (D.emptyNote.hidden === showEmpty) D.emptyNote.hidden = !showEmpty;
  if (empty) {
    let txt, chip = false;
    if (selShallow && selCount > 0) {
      txt = 'scanning ' + selCount + ' agents\u2026';
    } else if (tree.multi && state.activeOnly) {
      txt = 'no active sessions  \u00b7  ' + tree.sessions.length + ' total';
      chip = true;
    } else if (state.activeOnly && tree.fullAgents > 0) {
      const done = Math.max(0, tree.fullAgents - tree.fullRunning);
      txt = 'no subagents running  \u00b7  ' + done + ' finished' + (tree.multi ? '' : ' this session');
      chip = true;
    } else if (tree.fullAgents > 0) {
      txt = 'loading ' + tree.fullAgents + ' agents\u2026';
    } else {
      txt = 'no subagents running';
    }
    setText(D.emptyText, txt);
    if (D.emptyShowAll.hidden === chip) D.emptyShowAll.hidden = !chip;
  }

  // Counters describe the whole session, not the filtered graph.
  setText(D.ctRunning, selShallow ? '\u2014' : tree.fullRunning);
  setText(D.ctAgents, selShallow ? selCount : tree.fullAgents);
  setText(D.ctDepth, selShallow ? '\u2014' : tree.fullDepth);
  renderSpend();

  const snap = state.agents;
  if (MC.view !== 'agents') {
    // the sub-line belongs to whichever view owns the panel
  } else if (tree.multi) {
    setText(D.graphSub, tree.picked.length + ' sessions \u00b7 scan ' + (snap && snap.scanMs != null ? snap.scanMs + 'ms' : '-'));
  } else {
    const s = tree.root.data;
    setText(D.graphSub, s
      ? (s.projectSlug || short(s.sessionId)) + ' \u00b7 ' + (s.cwd || '') +
        (isShallow(s) ? ' \u00b7 history (not scanned)' : '') +
        (snap && snap.scanMs != null ? ' \u00b7 scan ' + snap.scanMs + 'ms' : '')
      : 'no session');
  }

  updateTitle();
  flushRipples();

  if (state.pinnedId && !tree.byId.has(state.pinnedId)) unpin();
  else if (state.pinnedId) fillDetail(tree.byId.get(state.pinnedId));
  if (state.focusId && !tree.byId.has(state.focusId)) { state.focusId = null; applyFocus(); }
}

/* ============================================================== SESSIONS UI */

function renderSessions() {
  const snap = state.agents;
  const sessions = snap && Array.isArray(snap.sessions) ? snap.sessions.slice() : [];
  sessions.sort((a, b) => (parseTs(b.lastActivityAt) || 0) - (parseTs(a.lastActivityAt) || 0));

  const sig = sessions.map((s) => {
    const c = costOf(s);
    return s.sessionId + ':' + s.agentCount + ':' + (s.isActive ? 1 : 0) + ':' + (isShallow(s) ? 1 : 0) +
      ':' + (c ? c.usd.toFixed(2) : '-');
  }).join('|');
  if (D.sel.dataset.sig !== sig) {
    D.sel.dataset.sig = sig;
    D.sel.textContent = '';
    for (const s of sessions) {
      const o = document.createElement('option');
      const c = costOf(s);
      o.value = s.sessionId;
      o.textContent = (s.isActive ? '\u25cf ' : '\u25cb ') + trunc(s.projectSlug || 'session', 26) +
        '  \u00b7  ' + short(s.sessionId) + '  \u00b7  ' + (s.agentCount || 0) + ' agents' +
        (c ? '  \u00b7  ' + (c.approx ? '\u2248' : '') + fmtUsd(c.usd) : '') +
        (isShallow(s) ? '  \u00b7 history' : '');
      D.sel.appendChild(o);
    }
  }
  if (!sessions.some((s) => s.sessionId === state.sessionId)) {
    state.sessionId = sessions.length ? sessions[0].sessionId : null;
    // the newest session is deep by default, but do not strand the user if it is not
    if (state.haveReal && state.sessionId && isShallow(sessions[0])) requestDeepScan(state.sessionId);
  }
  if (state.sessionId && D.sel.value !== state.sessionId) D.sel.value = state.sessionId;
  const dis = !state.scopeThis || sessions.length === 0;
  if (D.sel.disabled !== dis) D.sel.disabled = dis;
  const op = state.scopeThis ? '1' : '0.45';
  if (D.sel.style.opacity !== op) D.sel.style.opacity = op;
}

/* ============================================================== DETAIL / TOOLTIP */

function statusColor(st) {
  if (st === 'running') return COL.live;
  if (st === 'spawning') return COL.warn;
  return COL.dim;
}

function agentIdleMs(a, snapAt) {
  const t = parseTs(a.lastActivityAt);
  if (Number.isFinite(t)) return Date.now() - t;
  return (a.idleMs || 0) + (Date.now() - (snapAt || Date.now()));
}
function agentAgeMs(a, snapAt) {
  const t = parseTs(a.spawnedAt);
  if (Number.isFinite(t)) return Date.now() - t;
  return (a.ageMs || 0) + (Date.now() - (snapAt || Date.now()));
}

function fillHubDetail(n) {
  const sess = n.data;
  const st = tree.hubState || 'idle';
  const m = mainOf(sess);
  D.dDot.style.background = st === 'working' ? COL.live : st === 'waiting' ? COL.warn : COL.dim;
  setText(D.dType, tree.multi ? 'all sessions' : 'main session');
  setText(D.dStatus, st);

  const rows = tree.multi ? [
    ['SESSIONS', String(tree.picked.length)],
    ['RUNNING', String(tree.fullRunning)],
    ['AGENTS', String(tree.fullAgents)],
    ['DEPTH', String(tree.fullDepth)]
  ] : [
    ['MODEL', formatModel(m.model) || '-'],
    ['LAST TOOL', m.lastTool || '-'],
    ['ACTIVITY', Number.isFinite(mainIdleMs(sess)) ? rel(mainIdleMs(sess)) : '-'],
    ['AGENTS', tree.fullRunning + ' / ' + tree.fullAgents],
    ['STARTED', sess && sess.startedAt ? rel(Date.now() - (parseTs(sess.startedAt) || Date.now())) : '-'],
    ['SESSION', sess ? short(sess.sessionId) : '-'],
    ['SCAN', isShallow(sess) ? 'history' : 'deep'],
    ['DEPTH', String(tree.fullDepth)]
  ];

  // tokens + dollars, but only once the scan actually reports them
  const sessTok = tk(sess) || sumTokens(tree.picked);
  if (sessTok) rows.push(['TOKENS', tokensLine(sessTok) + tokenBadges(sess) + tokenBadges(m)]);
  const sessCost = tree.multi ? sumCost(tree.picked) : costOf(sess);
  if (sessCost) {
    rows.push(['COST', (sessCost.approx ? '≈ ' : '') + fmtUsd(sessCost.usd) +
      (sessCost.approx ? ' (estimate)' : ' (reported)')]);
  }

  setText(D.dDesc, tree.multi
    ? tree.picked.length + ' sessions on this machine'
    : ((sess && sess.cwd) || ''));

  if (D.dGrid.dataset.n !== String(rows.length)) {
    D.dGrid.textContent = '';
    for (let i = 0; i < rows.length; i++) { D.dGrid.appendChild(el('dt')); D.dGrid.appendChild(el('dd')); }
    D.dGrid.dataset.n = String(rows.length);
  }
  const kids = D.dGrid.children;
  rows.forEach((r, i) => { setText(kids[i * 2], r[0]); setText(kids[i * 2 + 1], r[1]); });

  setText(D.dLastText, m.lastText ? '\u201c' + m.lastText + '\u201d' : '(no recent output from the main session)');
  D.detail.hidden = false;
}

function fillDetail(n) {
  if (!n) return;
  if (n.kind === 'hub') return fillHubDetail(n);
  const isAgent = n.kind === 'agent';
  const a = n.data || {};
  const snapAt = state.agentsAt;

  D.dDot.style.background = isAgent ? statusColor(n.status) : COL.hub;
  setText(D.dType, isAgent ? (a.agentType || 'agent') : (a.projectSlug || 'session'));
  setText(D.dStatus, isAgent ? n.status : (a.isActive ? 'active' : 'idle'));
  setText(D.dDesc, isAgent ? (a.description || '(no description)') : (a.cwd || ''));

  const rows = isAgent ? [
    ['MODEL', a.model || '-'],
    ['DEPTH', String(a.spawnDepth != null ? a.spawnDepth : n.depth)],
    ['PARENT', a.parentId ? short(a.parentId) : 'main session'],
    ['LAST TOOL', a.lastTool || '-'],
    ['LINES', num(a.lines)],
    ['BYTES', bytes(a.bytes)],
    ['SPAWNED', rel(agentAgeMs(a, snapAt))],
    ['ACTIVITY', rel(agentIdleMs(a, snapAt))],
    ['CHILDREN', String(n.children.length)],
    ['ID', short(a.id)]
  ].concat(tk(a) ? [['TOKENS', tokensLine(tk(a)) + tokenBadges(a)]] : [])
   .concat(agentCost(a) ? [['COST', agentCost(a).unknown
     ? 'unknown model' + (agentCost(a).model ? ' (' + agentCost(a).model + ')' : '')
     : '≈ ' + fmtUsd(agentCost(a).usd) + (agentCost(a).model ? ' (' + agentCost(a).model + ')' : '')]] : []) : [
    ['AGENTS', String(a.agentCount != null ? a.agentCount : n.children.length)],
    ['RUNNING', isShallow(a) ? '\u2014' : String(a.runningCount || 0)],
    ['DEPTH', isShallow(a) ? '\u2014' : String(a.maxDepth || 0)],
    ['SCAN', isShallow(a) ? 'history' : 'deep'],
    ['STARTED', rel(Date.now() - (parseTs(a.startedAt) || Date.now()))],
    ['ACTIVITY', rel(Date.now() - (parseTs(a.lastActivityAt) || Date.now()))],
    ['ID', short(a.sessionId)]
  ];

  if (D.dGrid.dataset.n !== String(rows.length)) {
    D.dGrid.textContent = '';
    for (const _ of rows) { D.dGrid.appendChild(el('dt')); D.dGrid.appendChild(el('dd')); }
    D.dGrid.dataset.n = String(rows.length);
  }
  const kids = D.dGrid.children;
  rows.forEach((r, i) => { setText(kids[i * 2], r[0]); setText(kids[i * 2 + 1], r[1]); });

  setText(D.dLastText, isAgent ? (a.lastText || '(no output captured)') : (a.cwd || ''));
  D.detail.hidden = false;
}

function pin(id) {
  const n = tree.byId.get(id);
  if (!n) return;
  if (state.pinnedId) { const p = nodeEls.get(state.pinnedId); if (p) p.g.classList.remove('sel'); }
  state.pinnedId = id;
  const e = nodeEls.get(id); if (e) { e.g.classList.add('sel'); e.cls += ' sel'; }
  fillDetail(n);
}
function unpin() {
  if (state.pinnedId) { const p = nodeEls.get(state.pinnedId); if (p) { p.g.classList.remove('sel'); p.cls = p.cls.replace(' sel', ''); } }
  state.pinnedId = null;
  D.detail.hidden = true;
}

function showTooltip(id, x, y) {
  const n = tree.byId.get(id);
  if (!n) return;
  const a = n.data || {};
  let txt;
  if (n.kind === 'agent') {
    const at = tk(a);
    const ac = agentCost(a);
    txt = (a.agentType || 'agent') + '  \u00b7  D' + (a.spawnDepth != null ? a.spawnDepth : n.depth) + '\n' +
      n.status.toUpperCase() + '  \u00b7  idle ' + dur(agentIdleMs(a, state.agentsAt)) +
      (at && Number.isFinite(at.out) ? '  \u00b7  out ' + fmtTokens(at.out) : '') +
      (ac && ac.usd != null ? '  \u00b7  ' + fmtUsd(ac.usd) : '') + '\n' +
      trunc(a.description || '', 90);
  } else {
    const sst = hubStateOf(a, a.runningCount || 0);
    txt = (a.projectSlug || 'session') + '\n' +
      hubStateLine(sst, a, a.runningCount || 0) + '\n' +
      (isShallow(a)
        ? (a.agentCount || 0) + ' agents \u00b7 not scanned (select the session to load)'
        : (a.agentCount || 0) + ' agents') +
      '\n' + trunc(a.cwd || '', 60);
  }
  setText(D.tooltip, txt);
  D.tooltip.hidden = false;
  const r = D.tooltip.getBoundingClientRect();
  const px = Math.min(x + 14, window.innerWidth - r.width - 8);
  const py = Math.min(y + 14, window.innerHeight - r.height - 8);
  D.tooltip.style.left = px + 'px';
  D.tooltip.style.top = py + 'px';
}
function hideTooltip() { D.tooltip.hidden = true; }

/* ============================================================== INFRA RAIL */

function metaTitle(item) {
  const parts = [item.label || '', 'state: ' + (item.state || 'unknown')];
  if (item.detail) parts.push(item.detail);
  if (item.sub) parts.push(item.sub);
  const m = item.meta;
  if (m && typeof m === 'object') {
    for (const k of Object.keys(m)) {
      let v = m[k];
      if (v && typeof v === 'object') { try { v = JSON.stringify(v); } catch (_) { v = '[object]'; } }
      parts.push(k + ': ' + v);
    }
  }
  return parts.join('\n');
}

function renderInfra() {
  const snap = state.infra;
  const groups = snap && Array.isArray(snap.groups) ? snap.groups : [];

  const seen = new Set();
  for (const g of groups) {
    seen.add(g.id);
    let ge = railGroups.get(g.id);
    if (!ge) {
      const wrap = el('section', 'grp');
      const head = el('div', 'grp-head');
      const lab = el('span', 'grp-label');
      const cnt = el('span', 'grp-count');
      head.appendChild(lab); head.appendChild(cnt);
      const body = el('div', 'grp-items');
      wrap.appendChild(head); wrap.appendChild(body);
      ge = { wrap, lab, cnt, body, items: new Map() };
      railGroups.set(g.id, ge);
    }
    setText(ge.lab, g.label || g.id);
    const items = Array.isArray(g.items) ? g.items : [];
    setText(ge.cnt, items.length + ' \u00b7 ' + items.filter((i) => i.state === 'up').length + ' up');

    const seenI = new Set();
    for (const it of items) {
      seenI.add(it.id);
      let ie = ge.items.get(it.id);
      if (!ie) {
        const row = el('div', 'item');
        const dot = el('span', 'i-dot');
        const lab = el('span', 'i-label');
        const det = el('span', 'i-detail');
        const sub = el('span', 'i-sub');
        row.appendChild(dot); row.appendChild(lab); row.appendChild(det); row.appendChild(sub);
        ie = { row, lab, det, sub, state: '', title: '' };
        ge.items.set(it.id, ie);
      }
      const st = it.state || 'unknown';
      if (ie.state !== st) { ie.row.setAttribute('data-state', st); ie.state = st; }
      setText(ie.lab, it.label || it.id);
      setText(ie.det, it.detail || '');
      setText(ie.sub, it.sub || '');
      ie.sub.style.display = it.sub ? '' : 'none';
      const t = metaTitle(it);
      if (ie.title !== t) { ie.row.title = t; ie.title = t; }
      ge.body.appendChild(ie.row);
    }
    for (const [id, ie] of ge.items) if (!seenI.has(id)) { ie.row.remove(); ge.items.delete(id); }
    D.railBody.appendChild(ge.wrap);
  }
  for (const [id, ge] of railGroups) if (!seen.has(id)) { ge.wrap.remove(); railGroups.delete(id); }

  const total = groups.reduce((s, g) => s + (g.items ? g.items.length : 0), 0);
  const down = groups.reduce((s, g) => s + (g.items || []).filter((i) => i.state === 'down').length, 0);
  const up = groups.reduce((s, g) => s + (g.items || []).filter((i) => i.state === 'up').length, 0);
  // on a phone this line is the only thing visible while the rail is collapsed,
  // so it carries the headline count as well as the scan time
  setText(D.railSub, total + ' checks \u00b7 ' + up + ' up' + (down ? ' \u00b7 ' + down + ' down' : '') +
    (snap && snap.scanMs != null ? ' \u00b7 ' + snap.scanMs + 'ms' : ''));

  renderErrors();
  MC.emit('infra', snap);
}

function renderErrors() {
  const errs = []
    .concat(state.agents && Array.isArray(state.agents.errors) ? state.agents.errors : [])
    .concat(state.infra && Array.isArray(state.infra.errors) ? state.infra.errors : []);
  if (!errs.length) { D.errStrip.hidden = true; return; }
  D.errStrip.hidden = false;
  setText(D.errCount, errs.length + (errs.length === 1 ? ' scan issue' : ' scan issues'));
  const sig = errs.join('\u0000');
  if (D.errList.dataset.sig === sig) return;
  D.errList.dataset.sig = sig;
  D.errList.textContent = '';
  for (const e of errs) {
    const li = document.createElement('li');
    li.textContent = typeof e === 'string' ? e : (function () { try { return JSON.stringify(e); } catch (_) { return String(e); } })();
    D.errList.appendChild(li);
  }
}

/* ============================================================== APPLY SNAPSHOTS */

let pendingGraph = 0;
function scheduleGraph() {
  if (pendingGraph) return;
  pendingGraph = requestAnimationFrame(() => { pendingGraph = 0; renderGraph(); });
}

/* Cheap render signature over exactly the fields the UI draws, so an
   unchanged snapshot costs one string build instead of a full re-render. */
function agentsSig(snap) {
  const out = [];
  for (const s of snap.sessions) {
    out.push(s.sessionId, s.isActive ? '1' : '0', s.agentCount, s.runningCount, s.maxDepth,
      s.projectSlug, s.lastActivityAt || '', isShallow(s) ? 'S' : 'D',
      // tokens and dollars move on their own between structurally identical
      // snapshots; leaving them out of the signature froze both counters
      tkTotal(s), tkTotal(mainOf(s)), (costOf(s) || {}).usd, mainOf(s).costUsd,
      (liveOf(s) || {}).contextPct,
      (((liveOf(s) || {}).rateLimits || {}).fiveHour || {}).pct,
      (((liveOf(s) || {}).rateLimits || {}).sevenDay || {}).pct);
    for (const a of (s.agents || [])) {
      out.push(a.id, a.status, a.spawnDepth, a.parentId || '', a.lastActivityAt || '',
        a.lastTool || '', a.lines, a.bytes, (a.lastText || '').length,
        tkTotal(a), a.costUsd, a.tokensPending ? 'P' : '', a.tokensApprox ? 'A' : '');
    }
  }
  return out.join('');
}
function infraSig(snap) {
  const out = [];
  for (const g of snap.groups) {
    out.push(g.id, g.label);
    for (const i of (g.items || [])) out.push(i.id, i.label, i.state, i.detail || '', i.sub || '');
  }
  out.push((snap.errors || []).join(''));
  return out.join('');
}

let lastAgentsSig = null, lastInfraSig = null;

function applyAgents(snap) {
  if (!snap || !Array.isArray(snap.sessions)) return;
  const sig = agentsSig(snap);
  const same = sig === lastAgentsSig;
  lastAgentsSig = sig;
  state.agents = snap;
  state.agentsAt = Date.now();
  if (!same) {
    renderSessions();
    diffFeed(snap);
    scheduleGraph();
    renderErrors();
  }
  paintOlderBtn();
  MC.emit('agents', snap);
  tickClock();
}

function applyInfra(snap) {
  if (!snap || !Array.isArray(snap.groups)) return;
  const sig = infraSig(snap);
  const same = sig === lastInfraSig;
  lastInfraSig = sig;
  state.infra = snap;
  state.infraAt = Date.now();
  if (!same) renderInfra();
}

/* ============================================================== EVENT FEED */

const FEED_MAX = 200;
const FEED_TTL_MS = 24 * 60 * 60 * 1000;
let feedItems = [];        // newest first
let feedPrev = null;       // last seen shape of the SELECTED session
let feedSessionId = null;  // which session the rows on screen belong to
let feedSaveTimer = 0;
let pendingRipples = [];

function feedKey(sid) { return 'mc.feed.' + sid; }

function refreshFeedCount() {
  setText(D.feedCount, feedItems.length + (feedItems.length === 1 ? ' event' : ' events'));
}

/* Stored feeds are {savedAt, rows}. Anything not touched in a week is dead
   weight from a session that will never be selected again - drop it. Bare
   arrays are the pre-savedAt format; stamp them once instead of binning them. */
const FEED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function pruneFeedKeys() {
  let ls;
  try { ls = window.localStorage; if (!ls) return; } catch (_) { return; }
  const migrating = lsGet('mc.feedStamped', '0') !== '1';
  const now = Date.now();
  const keys = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k && k.slice(0, 8) === 'mc.feed.') keys.push(k);
  }
  const doomed = [];
  for (const k of keys) {
    let v = null;
    try { v = JSON.parse(ls.getItem(k)); } catch (_) { doomed.push(k); continue; }
    if (Array.isArray(v)) {
      if (migrating) { try { ls.setItem(k, JSON.stringify({ savedAt: now, rows: v })); } catch (_) { } }
      else doomed.push(k);
      continue;
    }
    if (!v || typeof v !== 'object' || !Number.isFinite(v.savedAt) || now - v.savedAt > FEED_KEEP_MS) doomed.push(k);
  }
  for (const k of doomed) { try { ls.removeItem(k); } catch (_) { } }
  if (migrating) lsSet('mc.feedStamped', '1');
  return doomed.length;
}

/* Rows are written back debounced - a busy session pushes every couple of
   seconds and the payload is a few tens of KB. */
function writeFeed(sid) {
  if (!sid) return;
  const rows = feedItems.slice(0, FEED_MAX)
    .map((e) => ({ kind: e.kind, ts: e.ts, depth: e.depth || 0, text: e.text }));
  try { lsSet(feedKey(sid), JSON.stringify({ savedAt: Date.now(), rows: rows })); } catch (_) { }
}
function saveFeedSoon() {
  if (!feedSessionId || feedSaveTimer) return;
  const sid = feedSessionId;
  feedSaveTimer = setTimeout(() => {
    feedSaveTimer = 0;
    if (feedSessionId !== sid) return;   // swapped away; these rows are not that session's
    writeFeed(sid);
  }, 1000);
}
function flushFeedSave() {
  if (feedSaveTimer) { clearTimeout(feedSaveTimer); feedSaveTimer = 0; }
  if (feedSessionId) writeFeed(feedSessionId);
}

/* Swap the visible feed over to a session, restoring whatever we stored for it
   last time. Called before the first snapshot lands so an arrival line ends up
   on top of the restored history. */
function ensureFeedFor(sid) {
  if (!sid || feedSessionId === sid) return;
  flushFeedSave();          // the outgoing session keeps its own rows
  feedSessionId = sid;
  feedItems = [];
  D.feedRows.textContent = '';
  D.feedRows.appendChild(D.feedEmpty);

  let rows = [];
  try {
    const raw = lsGet(feedKey(sid), null);
    if (raw) {
      const parsed = JSON.parse(raw);
      // {savedAt, rows} today; a bare array is the pre-savedAt format
      const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.rows) ? parsed.rows : null);
      if (arr) rows = arr;
    }
  } catch (_) { rows = []; }

  const cutoff = Date.now() - FEED_TTL_MS;
  rows = rows
    .filter((r) => r && typeof r === 'object' && Number.isFinite(r.ts) && r.ts >= cutoff && typeof r.text === 'string')
    .slice(0, FEED_MAX);

  // stored newest-first; append in order so the newest stays on top
  for (const r of rows) {
    const ev = { kind: String(r.kind || 'main'), ts: r.ts, depth: r.depth || 0, text: r.text };
    ev.el = feedRow(ev, false);
    D.feedRows.appendChild(ev.el);
    feedItems.push(ev);
  }
  if (MC.view === 'agents') refreshFeedCount();
  D.feedEmpty.hidden = feedItems.length > 0;
  renderFeedTimes();
}

function feedRow(ev, animate) {
  const row = el('div', 'ev k-' + ev.kind);
  const t = el('span', 'ev-t');
  const dcls = 'ev-d' + (ev.kind === 'main' || ev.kind === 'session' ? ' main'
    : ev.depth ? ' d' + Math.min(ev.depth, 3) : '');
  row.appendChild(t);
  row.appendChild(el('span', dcls));
  row.appendChild(el('span', 'ev-k', ev.kind === 'session' ? 'session' : ev.kind));
  row.appendChild(el('span', 'ev-x', ev.text));
  ev.tEl = t;
  if (animate !== false) {
    row.classList.add('ev-new');
    setTimeout(() => row.classList.remove('ev-new'), 520);
  }
  return row;
}

function pushEvents(evs) {
  if (!evs || !evs.length) return;
  for (const ev of evs) {
    ev.el = feedRow(ev, true);
    D.feedRows.insertBefore(ev.el, D.feedRows.firstChild);
    feedItems.unshift(ev);
  }
  while (feedItems.length > FEED_MAX) {
    const old = feedItems.pop();
    if (old.el && old.el.parentNode) old.el.remove();
  }
  if (MC.view === 'agents') refreshFeedCount();
  if (D.feedEmpty.hidden !== (feedItems.length > 0)) D.feedEmpty.hidden = feedItems.length > 0;
  renderFeedTimes();
  saveFeedSoon();
}

function renderFeedTimes() {
  const now = Date.now();
  for (const ev of feedItems) if (ev.tEl) setText(ev.tEl, durShort(now - ev.ts));
}

/* Derived purely from consecutive snapshots of the SELECTED session. The first
   snapshot of a session is a baseline, so switching does not dump 105 rows. */
function diffFeed(snap) {
  const sid = state.sessionId;
  const sess = (snap.sessions || []).find((x) => x.sessionId === sid);
  if (!sess) return;

  const cur = { sessionId: sid, agents: new Map(), main: null };
  for (const a of (sess.agents || [])) {
    cur.agents.set(a.id, { status: a.status, lastTool: a.lastTool || null, lastActivityAt: a.lastActivityAt || null });
  }
  const m = mainOf(sess);
  cur.main = { lastTool: m.lastTool || null, lastActivityAt: m.lastActivityAt || null };

  const prev = feedPrev;
  feedPrev = cur;
  if (!prev || prev.sessionId !== sid) {
    // First sight of this session. Restore its stored rows, then log one
    // arrival line so the feed is never blank while agents are visibly running.
    ensureFeedFor(sid);
    const running = sess.runningCount != null
      ? sess.runningCount
      : (sess.agents || []).filter((a) => a.status === 'running' || a.status === 'spawning').length;
    pushEvents([{ kind: 'watching', ts: Date.now(), depth: 0,
      text: running + ' running  \u00b7  ' + (sess.agentCount || 0) + ' agents' }]);
    return;
  }

  const evs = [];
  for (const a of (sess.agents || [])) {
    const p = prev.agents.get(a.id);
    const label = (a.agentType || 'agent') + '  \u00b7  ' + trunc(a.description || '', 68);
    if (!p) {
      evs.push({ kind: 'spawned', ts: parseTs(a.spawnedAt) || Date.now(), depth: a.spawnDepth, text: label });
      continue;
    }
    // a real completion is stamped with the agent's own last write, not the
    // moment our scan window noticed it
    if (p.status !== 'done' && a.status === 'done') {
      const at = tk(a), ac = agentCost(a);
      evs.push({ kind: 'done', ts: parseTs(a.lastActivityAt) || Date.now(), depth: a.spawnDepth,
        text: label +
          (at && Number.isFinite(at.out) ? '  ·  ' + fmtTokens(at.out) + ' out' : '') +
          (ac && ac.usd != null ? '  ·  ' + fmtUsd(ac.usd) : '') });
    }
    if (p.lastTool !== (a.lastTool || null) || p.lastActivityAt !== (a.lastActivityAt || null)) {
      pendingRipples.push(nodeKey(sid, a.id));
    }
  }
  if (prev.main.lastTool !== cur.main.lastTool || prev.main.lastActivityAt !== cur.main.lastActivityAt) {
    evs.push({ kind: 'main', ts: parseTs(cur.main.lastActivityAt) || Date.now(),
      text: cur.main.lastTool || 'activity' });
    pendingRipples.push('__hub__');
  }
  if (evs.length) { evs.sort((x, y) => x.ts - y.ts); pushEvents(evs); }
}

function feedSessionSwitched(sess) {
  if (sess && sess.sessionId) ensureFeedFor(sess.sessionId);
  pushEvents([{ kind: 'session', ts: Date.now(),
    text: ((sess && sess.projectSlug) || 'session') + '  \u00b7  ' + short(sess && sess.sessionId) }]);
}

function setFeedCollapsed(v) {
  state.feedCollapsed = !!v;
  lsSet('mc.feedCollapsed', state.feedCollapsed ? '1' : '0');
  D.feed.classList.toggle('collapsed', state.feedCollapsed);
  setText(D.feedToggle, state.feedCollapsed ? 'SHOW' : 'HIDE');
  D.feedToggle.setAttribute('aria-expanded', String(!state.feedCollapsed));
}

/* One-shot expanding ring when something touches a tool. Purely additive: it
   lives inside the node group so it rides the layout, and never touches the
   body, halo or the linger fade. */
function fireRipple(id) {
  if (REDUCED.matches) return;
  let host = null, r = 8;
  if (id === '__hub__') { host = D.lHub; r = 30; }        // layer, not the hub <g> (index-addressed children)
  else {
    const e = nodeEls.get(id);
    if (!e || e.dead) return;
    host = e.g; r = e.r || 6;
  }
  if (!host) return;
  const c = svgEl('circle', { class: 'ripple', cx: 0, cy: 0, r: r });
  host.appendChild(c);
  const kill = () => { if (c.parentNode) c.remove(); };
  c.addEventListener('animationend', kill, { once: true });
  setTimeout(kill, 1400);
}

function flushRipples() {
  if (!pendingRipples.length) return;
  const ids = pendingRipples;
  pendingRipples = [];
  for (const id of ids) fireRipple(id);
}

/* ============================================================== TRANSPORT */

const T = { es: null, attempts: 0, retry: 0, polling: false, pa: 0, pi: 0 };

/* The server deep-scans active sessions only. To see a history session we have
   to name it. The stream is shared, so the payload may also carry other
   clients' requested sessions - harmless, we just render the selected one. */
function apiUrl(base) {
  const q = [];
  if (state.deepRequest) q.push('session=' + encodeURIComponent(state.deepRequest));
  if (state.showOlder) q.push('older=1');
  return q.length ? base + '?' + q.join('&') : base;
}

/* Re-open the stream against a different requested session. */
function requestDeepScan(id) {
  if (state.deepRequest === id) return false;
  state.deepRequest = id;
  T.attempts = 0;
  clearTimeout(T.retry);
  if (T.polling) { stopPolling(); startPolling(); }
  connectSSE();
  return true;
}

/* The server hides sessions that predate this dashboard unless asked. The
   button only disappears when there is nothing hidden AND nothing being shown -
   otherwise you could turn it on and never find the way back. */
function paintOlderBtn() {
  const btn = D.olderBtn;
  if (!btn) return;
  const f = state.agents && state.agents.filter;
  const hidden = f && Number.isFinite(f.hidden) ? f.hidden : 0;
  const show = state.showOlder || hidden > 0;
  if (btn.hidden === show) btn.hidden = !show;
  if (!show) return;
  setText(btn, state.showOlder ? 'HIDE OLDER' : 'SHOW OLDER (' + hidden + ')');
  btn.setAttribute('aria-pressed', String(state.showOlder));
  btn.title = state.showOlder
    ? 'Showing every session on disk'
    : hidden + ' session' + (hidden === 1 ? '' : 's') + ' started before this dashboard existed';
}

function setShowOlder(v) {
  const next = !!v;
  if (state.showOlder === next) return;
  state.showOlder = next;
  lsSet('mc.showOlder', next ? '1' : '0');
  paintOlderBtn();
  T.attempts = 0;
  clearTimeout(T.retry);
  if (T.polling) { stopPolling(); startPolling(); }
  connectSSE();
  pollAgents();          // do not wait a whole SSE cadence for the new list
}

function setMode(m) {
  if (state.mode === m) return;
  state.mode = m;
  D.conn.dataset.state = m === 'live' ? 'live'
    : m === 'polling' ? 'polling'
      : m === 'fixture' ? 'fixture'
        : m === 'dead' ? 'dead' : 'connecting';
  setText(D.connLabel, m === 'live' ? 'SSE LIVE'
    : m === 'polling' ? 'POLLING'
      : m === 'fixture' ? 'FIXTURE'
        : m === 'dead' ? 'OFFLINE' : 'CONNECTING');
  D.conn.title = m === 'live' ? 'Server-sent events connected'
    : m === 'polling' ? 'SSE unavailable - polling REST endpoints'
      : m === 'fixture' ? 'Server unreachable - showing built-in fixture data'
        : m === 'dead' ? 'No data source reachable' : 'Connecting';
  D.fixtureChip.hidden = m !== 'fixture';
}

function enterFixture() {
  if (state.haveReal) return;
  if (!FIXTURE) FIXTURE = buildFixture();
  state.fixture = true;
  applyAgents(FIXTURE.agents);
  applyInfra(FIXTURE.infra);
  setMode('fixture');
}
function gotReal(kind) {
  state.haveReal = true;
  if (state.fixture) {
    state.fixture = false;
    // clear fixture-derived selection so we land on the freshest real session
    state.sessionId = null;
  }
}

async function fetchJSON(url) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return await r.json();
  } finally { clearTimeout(to); }
}

function connectSSE() {
  clearTimeout(T.retry);
  if (T.es) { try { T.es.close(); } catch (_) { } T.es = null; }
  let es;
  try { es = new EventSource(apiUrl('/api/stream')); }
  catch (_) { onSSEError(); return; }
  T.es = es;

  es.addEventListener('open', () => { T.attempts = 0; stopPolling(); setMode('live'); });
  es.addEventListener('agents', (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch (_) { return; }
    gotReal(); applyAgents(d); T.attempts = 0; stopPolling(); setMode('live');
  });
  es.addEventListener('infra', (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch (_) { return; }
    gotReal(); applyInfra(d); T.attempts = 0; stopPolling(); setMode('live');
  });
  // The Stack scan rides the same stream on the infra cadence. It is a separate
  // data source with its own fallback, so it does not touch haveReal/fixture -
  // an stack frame must never rescue the agents view, or mask its loss.
  es.addEventListener('stack', (ev) => {
    if (MC.stackOff()) return;     // a server with the module off never sends one
    let d; try { d = JSON.parse(ev.data); } catch (_) { return; }
    T.attempts = 0;
    callHook('stack', d);
  });
  es.addEventListener('ping', () => { if (!T.polling) setMode('live'); });
  es.addEventListener('error', onSSEError);
}

function onSSEError() {
  if (T.es) { try { T.es.close(); } catch (_) { } T.es = null; }
  T.attempts++;
  if (T.attempts >= 3) startPolling();
  else if (!state.haveReal && !state.fixture) setMode('dead');
  const d = BACKOFF[Math.min(T.attempts - 1, BACKOFF.length - 1)];
  clearTimeout(T.retry);
  T.retry = setTimeout(connectSSE, d);
}

function startPolling() {
  if (T.polling) return;
  T.polling = true;
  if (!state.fixture) setMode('polling');
  pollAgents(); pollInfra();
  T.pa = setInterval(pollAgents, POLL_AGENTS_MS);
  T.pi = setInterval(pollInfra, POLL_INFRA_MS);
}
function stopPolling() {
  if (!T.polling) return;
  T.polling = false;
  clearInterval(T.pa); clearInterval(T.pi);
}

async function pollAgents() {
  try {
    const d = await fetchJSON(apiUrl('/api/agents'));
    gotReal(); applyAgents(d);
    if (state.mode !== 'live') setMode('polling');
  } catch (_) {
    if (!state.haveReal) enterFixture(); else setMode('dead');
  }
}
async function pollInfra() {
  try {
    const d = await fetchJSON('/api/infra');
    gotReal(); applyInfra(d);
  } catch (_) {
    if (!state.haveReal) enterFixture();
  }
}

async function boot() {
  // no ?session on first connect - the newest session is deep by default
  const [a, i] = await Promise.allSettled([fetchJSON(apiUrl('/api/agents')), fetchJSON('/api/infra')]);
  let ok = false;
  if (a.status === 'fulfilled') { gotReal(); applyAgents(a.value); ok = true; }
  if (i.status === 'fulfilled') { gotReal(); applyInfra(i.value); ok = true; }
  if (!ok) enterFixture();
  connectSSE();
}

/* ============================================================== CLOCK */

function updateTitle() {
  const nr = tree.fullRunning || 0;
  const base = nr > 0 ? '\u25cf ' + nr + ' running \u00b7 Mission Control' : 'Mission Control';
  const t = MC.view === 'stack'
    ? '[' + MC.stackUpper + ' ' + (callHook('statusGlyph') || '\u25cb') + '] ' + base
    : base;
  // history-ui raises this when an alert fires and drops it on focus / a click;
  // it is also the whole notification when the browser has denied permission
  const flag = (MC.alerts && MC.alerts.flag) ? '\u26a0 ' : '';
  if (document.title !== flag + t) document.title = flag + t;
}

function tickClock() {
  if (state.agentsAt) {
    const age = Date.now() - state.agentsAt;
    setText(D.updated, 'updated ' + rel(age));
    // if SSE claims to be live but nothing has arrived in 40s, be honest about it
    if (state.mode === 'live' && age > 40000) setMode('dead');
  } else {
    setText(D.updated, '\u2014');
  }
  if (tree.root) { renderHub(); updateTitle(); }
  if (state.pinnedId) { const n = tree.byId.get(state.pinnedId); if (n) fillDetail(n); }
  if (state.hoverId && state.hoverXY && !D.tooltip.hidden) {
    showTooltip(state.hoverId, state.hoverXY[0], state.hoverXY[1]);
  }
  tickFade();
  renderFeedTimes();
  callHook('tick');
  MC.emit('tick');
}

/* Walk the linger fade between snapshots, and drop anything that has aged out
   of the window. Only touches the handful of lingering nodes. */
function tickFade() {
  if (!state.activeOnly || !tree.all || !tree.all.length) return;
  for (const n of tree.all) {
    if (n.vis !== 'linger') continue;
    if (agentIdleMs(n.data, state.agentsAt) >= LINGER_MS) { renderGraph(); return; }
  }
  for (const n of tree.all) {
    if (n.vis !== 'linger') continue;
    const e = nodeEls.get(n.id);
    if (e && !e.dead) {
      const o = lingerOpacity(n);
      if (e.fade !== o) { e.g.style.opacity = String(o); e.fade = o; }
    }
    const ee = edgeEls.get(n.id);
    if (ee && !ee.dead) {
      const eo = +(0.34 * lingerOpacity(n)).toFixed(2);
      if (ee.fade !== eo) { ee.path.style.opacity = String(eo); ee.fade = eo; }
    }
  }
}

setInterval(tickClock, 1000);

/* ============================================================== INTERACTION */

let drag = null;
let suppressClick = false;

/* Every live pointer on the graph surface. One entry pans; two pinch-zoom.
   `touch-action:none` on #graph is what makes the browser hand us the second
   finger instead of scrolling the page with it. */
const ptrs = new Map();
let pinch = null;

function ptrCenter() {
  let x = 0, y = 0;
  for (const p of ptrs.values()) { x += p.x; y += p.y; }
  return { x: x / ptrs.size, y: y / ptrs.size };
}
function ptrSpread() {
  const a = Array.from(ptrs.values());
  return a.length < 2 ? 0 : Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
}
function beginPinch() {
  const c = ptrCenter();
  const r = D.svg.getBoundingClientRect();
  const mx = c.x - r.left, my = c.y - r.top;
  pinch = {
    d: ptrSpread(), k: view.k, moved: false,
    gx: (mx - view.x) / view.k, gy: (my - view.y) / view.k
  };
}
function beginPan(id, x, y) {
  drag = { x: x, y: y, vx: view.x, vy: view.y, moved: false, id: id };
}

D.svg.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) {
    drag = null;
    D.svg.classList.remove('dragging');
    hideTooltip();
    beginPinch();
  } else if (ptrs.size === 1) {
    pinch = null;
    beginPan(e.pointerId, e.clientX, e.clientY);
  } else {
    pinch = null; drag = null;
  }
});

window.addEventListener('pointermove', (e) => {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pinch && ptrs.size === 2) {
    const d = ptrSpread();
    if (!(d > 0) || !(pinch.d > 0)) return;
    if (!pinch.moved && Math.abs(d - pinch.d) > 6) pinch.moved = true;
    const k = clamp(0.3, pinch.k * (d / pinch.d), 5);
    const c = ptrCenter();
    const r = D.svg.getBoundingClientRect();
    view.k = k;
    view.x = (c.x - r.left) - pinch.gx * k;
    view.y = (c.y - r.top) - pinch.gy * k;
    view.user = true;
    applyView();
    return;
  }

  if (!drag || drag.id !== e.pointerId) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) > 3) { drag.moved = true; D.svg.classList.add('dragging'); hideTooltip(); }
  if (drag.moved) { view.x = drag.vx + dx; view.y = drag.vy + dy; view.user = true; applyView(); }
});

const endDrag = (e) => {
  ptrs.delete(e.pointerId);
  if (pinch) {
    if (ptrs.size >= 2) return;
    const wasMoved = pinch.moved;
    pinch = null;
    if (wasMoved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
    // one finger lifted mid-pinch: re-seat the survivor as a pan anchor rather
    // than jumping the map the next time it moves
    if (ptrs.size === 1) {
      const it = ptrs.entries().next().value;
      beginPan(it[0], it[1].x, it[1].y);
    }
    return;
  }
  if (!drag || drag.id !== e.pointerId) return;
  const wasMoved = drag.moved;
  drag = null;
  D.svg.classList.remove('dragging');
  if (wasMoved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
};
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

D.svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = D.svg.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const gx = (mx - view.x) / view.k, gy = (my - view.y) / view.k;
  const k = clamp(0.3, view.k * Math.exp(-e.deltaY * 0.0016), 5);
  view.k = k; view.x = mx - gx * k; view.y = my - gy * k; view.user = true;
  applyView();
}, { passive: false });

D.lNodes.addEventListener('pointerover', (e) => {
  const g = e.target.closest && e.target.closest('g.node');
  if (!g || drag) return;
  const id = g.dataset.id;
  state.hoverXY = [e.clientX, e.clientY];
  if (state.hoverId === id) return;
  if (state.hoverId) { const p = nodeEls.get(state.hoverId); if (p) p.g.classList.remove('hov'); }
  state.hoverId = id;
  g.classList.add('hov');
  showTooltip(id, e.clientX, e.clientY);
});
D.lNodes.addEventListener('pointermove', (e) => {
  if (drag || !state.hoverId) return;
  state.hoverXY = [e.clientX, e.clientY];
  showTooltip(state.hoverId, e.clientX, e.clientY);
});
D.lNodes.addEventListener('pointerout', (e) => {
  const g = e.target.closest && e.target.closest('g.node');
  if (!g) return;
  if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('g.node') === g) return;
  g.classList.remove('hov');
  if (state.hoverId === g.dataset.id) state.hoverId = null;
  hideTooltip();
});

D.lNodes.addEventListener('click', (e) => {
  if (suppressClick) return;
  const g = e.target.closest && e.target.closest('g.node');
  if (!g) return;
  e.stopPropagation();
  pin(g.dataset.id);
});
D.lNodes.addEventListener('dblclick', (e) => {
  const g = e.target.closest && e.target.closest('g.node');
  if (!g) return;
  e.stopPropagation();
  setFocus(g.dataset.id);
});
D.lArcs.addEventListener('click', (e) => {
  if (suppressClick) return;
  const g = e.target.closest && e.target.closest('g.arc-g');
  if (!g) return;
  e.stopPropagation();
  setFocus(state.focusId === g.dataset.id ? null : g.dataset.id);
});

D.lHub.addEventListener('click', (e) => {
  if (suppressClick) return;
  e.stopPropagation();
  pin('__hub__');
});

D.svg.addEventListener('click', () => { if (!suppressClick) unpin(); });

function setFocus(id) { state.focusId = id; applyFocus(); }

D.focusClear.addEventListener('click', () => setFocus(null));
D.dClose.addEventListener('click', unpin);

document.addEventListener('keydown', (e) => {
  const ae = document.activeElement;
  const typing = !!ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName);
  if (e.key === 'Escape') {
    if (MC.view === 'stack') callHook('escape');
    if (state.focusId) setFocus(null);
    unpin(); hideTooltip();
    if (typing && ae.blur) ae.blur();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const stack = MC.view === 'stack';
  if (k === '1') { setTab('agents'); e.preventDefault(); }
  else if (k === '2' && !MC.stackOff()) { setTab('stack'); e.preventDefault(); }
  else if (k === '3') { if (PHONE.matches) setTab('infra'); e.preventDefault(); }
  else if (k === '4') { if (PHONE.matches) setTab('feed'); e.preventDefault(); }
  else if (k === 'a') { if (!stack) setActiveOnly(!state.activeOnly); e.preventDefault(); }
  else if (k === 's') { if (!stack) toggleScope(); e.preventDefault(); }
  else if (k === 'r' || k === '0') { resetView(); e.preventDefault(); }
  else if (k === 'f') { setFeedCollapsed(!state.feedCollapsed); e.preventDefault(); }
  else if (k === '/') { if (!stack) D.sel.focus(); e.preventDefault(); }
});

function resetView() {
  if (MC.view === 'stack') { callHook('reset'); return; }
  view.user = false;
  fitView();
}
D.btnReset.addEventListener('click', resetView);

function selectSession(id) {
  state.sessionId = id;
  unpin(); setFocus(null);
  layoutSig = ''; // force re-layout for the new tree
  // Only a session the server has not scanned needs a reconnect; one that is
  // already deep is in the payload we are receiving.
  const s = sessionById(id);
  feedSessionSwitched(s);
  if (state.haveReal && isShallow(s)) requestDeepScan(id);
  renderGraph();
}

D.sel.addEventListener('change', () => selectSession(D.sel.value));
if (D.olderBtn) D.olderBtn.addEventListener('click', () => setShowOlder(!state.showOlder));

function setActiveOnly(v) {
  state.activeOnly = !!v;
  lsSet('mc.activeOnly', state.activeOnly ? '1' : '0');
  D.tglActive.setAttribute('aria-pressed', String(state.activeOnly));
  layoutSig = '';        // the visible set defines the layout, so relayout (glide)
  renderGraph();
}

D.tglActive.addEventListener('click', () => setActiveOnly(!state.activeOnly));
D.emptyShowAll.addEventListener('click', () => setActiveOnly(false));
function toggleScope() {
  state.scopeThis = !state.scopeThis;
  D.tglScope.setAttribute('aria-pressed', String(state.scopeThis));
  setText(D.tglScope, state.scopeThis ? 'THIS SESSION' : 'ALL SESSIONS');
  unpin(); setFocus(null);
  layoutSig = '';
  renderSessions();
  renderGraph();
}
D.tglScope.addEventListener('click', toggleScope);
D.feedToggle.addEventListener('click', () => setFeedCollapsed(!state.feedCollapsed));

/* resize */
const ro = new ResizeObserver(() => {
  const changed = fitView();
  if (changed && tree.root) { layoutSig = ''; renderGraph(); }
  callHook('resize');
});
ro.observe(D.stage);

/* ============================================================== GO */

/* ============================================================== PHONE */

/* On a phone the rail lives below the map as a collapsible section; on desktop
   the toggle is not in the layout at all. */
function setRailOpen(v) {
  state.railOpen = !!v;
  lsSet('mc.railOpen', state.railOpen ? '1' : '0');
  if (D.rail) D.rail.classList.toggle('collapsed', !state.railOpen);
  if (D.railToggle) {
    D.railToggle.setAttribute('aria-expanded', String(state.railOpen));
    D.railToggle.title = state.railOpen ? 'Collapse infrastructure' : 'Expand infrastructure';
  }
}
if (D.railToggle) D.railToggle.addEventListener('click', () => setRailOpen(!state.railOpen));

/* --- tabs --------------------------------------------------------------- */

/* A phone gets four tabs; a desktop has two views. `tab` is the persisted
   thing, `view` stays exactly what it always was (agents|stack) so every
   `MC.view === 'stack'` check in the other two files keeps working - the INFRA
   and FEED tabs simply render on top of the agents view. */
const TABS = { agents: 1, stack: 1, infra: 1, feed: 1 };

function setTab(t) {
  const tab = TABS[t] && !(t === 'stack' && MC.stackOff()) ? t : 'agents';
  if (MC.tab === tab) return;
  MC.tab = tab;
  document.body.dataset.tab = tab;
  setView(tab === 'stack' ? 'stack' : 'agents');
  lsSet('mc.view', tab);          // after setView, which writes the view name
  paintNav();
  if (tab === 'agents' || tab === 'stack') { view.user = false; fitView(); }
  MC.emit('tab', tab);
}

function paintNav() {
  const nav = $('botnav');
  if (!nav) return;
  for (const b of nav.querySelectorAll('.bn')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === MC.tab));
  }
}
(function () {
  const nav = $('botnav');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.bn');
    if (b && b.dataset.tab) setTab(b.dataset.tab);
  });
})();

/* --- reparenting -------------------------------------------------------- */

/* The counters, toggles and Stack chips belong in the topbar on a desktop and
   under the panel head on a phone. Rather than duplicating the markup they get
   physically moved, and put back in a known order - restoring by appendChild in
   sequence avoids ever holding a stale nextSibling. */
function toPhoneHead() {
  const host = $('phone-head');
  if (!host) return;
  for (const el of [$('stack-chips'), $('counters'), $('toggles'), $('alerts-wrap'), $('tgl-older')]) {
    if (el && el.parentNode !== host) host.appendChild(el);
  }
}
function toTopbar() {
  const row = $('tb-row2');
  if (!row) return;
  const spacer = row.querySelector('.topbar-spacer') || document.querySelector('.topbar-spacer');
  for (const el of [$('sel-wrap'), $('tgl-older'), $('counters'), $('stack-chips'), spacer, $('toggles'), $('alerts-wrap')]) {
    if (el) row.appendChild(el);
  }
}

function applyPhone() {
  const on = PHONE.matches;
  const nav = $('botnav');
  const head = $('phone-head');
  const modelChip = $('ct-model-wrap');

  if (nav && nav.hidden === on) nav.hidden = !on;
  if (head && head.hidden === on) head.hidden = !on;
  if (modelChip && modelChip.hidden === on) modelChip.hidden = !on;
  if (D.railToggle && D.railToggle.hidden === on) D.railToggle.hidden = !on;

  if (on) toPhoneHead(); else toTopbar();

  // the rail is only ever collapsed on a phone - at desktop width it is a column
  setRailOpen(on ? state.railOpen : true);
  if (D.rail && !on) D.rail.classList.remove('collapsed');
  // infra/feed exist only on a phone; coming back to a desktop lands on agents
  if (!on && (MC.tab === 'infra' || MC.tab === 'feed')) setTab(MC.view);
  paintNav();
  callHook('phone', on);
  MC.emit('phone', on);
}
const onBreakpoint = () => { applyPhone(); layoutSig = ''; renderGraph(); fitView(); };
try { PHONE.addEventListener('change', onBreakpoint); }
catch (_) { if (PHONE.addListener) PHONE.addListener(onBreakpoint); }

MC.phone = () => PHONE.matches;
MC.setRailOpen = setRailOpen;
MC.setTab = setTab;
/* the feed rows this session is holding, for the phone's merged list */
MC.feedItems = () => feedItems.map((e) => ({ kind: e.kind, ts: e.ts, depth: e.depth || 0, text: e.text }));

/* --- optional modules ---------------------------------------------------- */

/* Called once with the /api/health body. A body without `modules` changes
   nothing. A module that is off loses its tab and its key, and a stored or
   current stack view falls back to agents. */
function applyModules(health) {
  const mods = health && typeof health === 'object' ? health.modules : null;
  if (!mods || typeof mods !== 'object') return;
  MC.modules = mods;
  if (!MC.stackOff()) return;
  if (D.tabStack) D.tabStack.hidden = true;
  const bn = document.querySelector('#botnav .bn[data-tab="stack"]');
  if (bn) bn.hidden = true;
  if (MC.tab === 'stack') setTab('agents');
  if (MC.view === 'stack') setView('agents');
}
/* stack-view.js and history-ui.js wait on this (it settles on success AND on
   failure, with the server's modules or null) before touching stack data. */
MC.modulesReady = fetchJSON('/api/health')
  .then((h) => { try { applyModules(h); } catch (err) { console.error('[modules]', err); } },
    () => { /* unreachable or older server: everything stays on */ })
  .then(() => MC.modules);

/* ============================================================== GO */

D.tglActive.setAttribute('aria-pressed', String(state.activeOnly));
D.tglScope.setAttribute('aria-pressed', 'true');
setFeedCollapsed(state.feedCollapsed);
document.body.dataset.tab = MC.tab;
lsSet('mc.view', MC.tab);      // a first-run phone must survive a reload
paintNav();
applyPhone();
pruneFeedKeys();
fitView();
boot();

})();
