'use strict';
/**
 * mission-control / lib/history.js
 * ---------------------------------------------------------------------------
 * Rolling time-series recorder. The server hands every scan it makes to
 * record(); /api/history reads it back with query().
 *
 *   module.exports = { createHistory }
 *
 *   createHistory({ file, maxAgeMs, flushMs, maxPointsPerSeries, log })
 *     -> { record, query, flush, stats, close }
 *
 * Hard rules baked into this file (same house rules as lib/infra.js):
 *   - NOTHING here ever throws. A corrupt snapshot, a hand-edited history
 *     file, a full disk: each becomes one log line and the recorder carries
 *     on. A dashboard that stops serving because its own graph store choked
 *     is worse than a dashboard with a gap in its graph.
 *   - No npm dependencies, no timers unless flushMs > 0, and the one timer
 *     there can be is unref()ed so `node server.js` still exits on its own.
 *   - Pure ASCII source. Log lines go through a cp1252 pipe on this machine,
 *     so a stray middle dot would come out mojibake in server.log.
 *
 * On-disk shape (single JSON file, never pretty-printed - this thing holds a
 * week of 30 s samples and every space costs):
 *
 *   { version: 1,
 *     series: {
 *       stack:    [ { t, status, ms, role, unshipped, incidents } ],
 *       services: { '<itemId>': [ { t, up, ms } ] },
 *       agents:   [ { t, running, agents, sessions } ] } }
 *
 * `t` is epoch ms and every series is strictly ascending in `t` - the append
 * rule below is what enforces that, and both query() and the trimmer rely on
 * it.
 *
 * Zero npm dependencies. CommonJS. Node 20+.
 */

const fs   = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_AGE_MS    = 7 * 24 * 3600e3;
const DEFAULT_FLUSH_MS      = 60000;
const DEFAULT_MAX_POINTS    = 30000;

// Agents frames land every 2 s (the dashboard's live fan-out view polls that
// fast). Storing all of them would put ~300k points a week in one series for
// no visual gain, so the recorder keeps one frame per 10 s and drops the rest.
const AGENTS_SAMPLE_MS = 10000;

// Incident lists are for reading, not for archaeology. Fifty is already more
// than fits on a 24 h chart; older ones are still visible as bad buckets.
const MAX_INCIDENTS = 50;

// Status severity. A Map rather than an object literal so a snapshot that
// somehow reports a status of "constructor" cannot reach Object.prototype.
// An unrecognised status ranks WORSE than every known one (see worstOf): a
// value we do not understand must never be quietly presented as healthy.
const SEVERITY = new Map([['ok', 0], ['degraded', 1], ['down', 2], ['unreachable', 3]]);
const SEVERITY_UNKNOWN = 4;

// ===========================================================================
// Small helpers
// ===========================================================================

function isObj(v) {
  return !!v && typeof v === 'object';
}

function posOr(v, dflt) {
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function numOr(v, dflt) {
  return Number.isFinite(v) ? v : dflt;
}

function clampNum(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function round1(v) {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

/** One short line out of anything thrown. Never itself throws. */
function errText(err) {
  try {
    if (!err) return 'unknown error';
    return String((err && err.message) || err).slice(0, 160);
  } catch { return 'unprintable error'; }
}

/** ISO string for an epoch ms, or null when it is out of Date's range. */
function isoOf(ms) {
  try { return new Date(ms).toISOString(); } catch { return null; }
}

/**
 * `t` for a snapshot. Every scanner stamps generatedAt as an ISO string, so
 * that is the authoritative instant; `fallback` (the caller's clock) covers a
 * snapshot that lost its stamp, which is preferable to dropping the sample.
 */
function parseTime(v, fallback) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : fallback;
}

function severityOf(status) {
  // Deliberately NOT case-folded: uptimePct compares status === 'ok' exactly,
  // so an 'OK' that arrived from somewhere new should rank unrecognised here
  // too rather than have the two halves of the same stat disagree.
  return SEVERITY.has(status) ? SEVERITY.get(status) : SEVERITY_UNKNOWN;
}

/** Worst status across `points` by the table above, or null when empty. */
function worstOf(points) {
  let worst = null;
  let rank = -1;
  for (const p of points) {
    const r = severityOf(p.status);
    if (r > rank) { rank = r; worst = p.status; }
  }
  return worst;
}

/** Median of finite numbers. Even count -> mean of the middle two, 1 dp. */
function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  if (s.length % 2) return s[mid];
  return round1((s[mid - 1] + s[mid]) / 2);
}

/**
 * Nearest-rank percentiles over finite numbers. Nearest-rank rather than an
 * interpolating variant because every value is a real observed round trip -
 * p95 should be a latency that actually happened, not one between two.
 */
function percentiles(values) {
  if (!values.length) return { p50: null, p95: null };
  const s = values.slice().sort((a, b) => a - b);
  const n = s.length;
  const i50 = Math.min(n - 1, Math.max(0, Math.floor(0.50 * n)));
  const i95 = Math.min(n - 1, Math.max(0, Math.ceil(0.95 * n) - 1));
  return { p50: round1(s[i50]), p95: round1(s[i95]) };
}

/** Max of a finite numeric field across `points`, or null when there is none. */
function maxOrNull(points, key) {
  let best = null;
  for (const p of points) {
    const v = p[key];
    if (!Number.isFinite(v)) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}

/** First integer before an "ms" in a detail string. `null` when absent. */
function msFromDetail(detail) {
  if (detail == null) return null;
  let m;
  try { m = /(\d+)\s*ms/.exec(String(detail)); } catch { return null; }
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Point constructors. These are the ONLY way a point enters a series, from
// record() and from the on-disk loader alike, so a hand-edited history file
// cannot smuggle a shape into query() that the aggregators would choke on.
// ---------------------------------------------------------------------------

function makeStackPoint(t, src) {
  return {
    t,
    status:    typeof src.status === 'string' ? src.status : 'unknown',
    ms:        Number.isFinite(src.ms) ? src.ms : null,
    role:      src.role == null ? null : src.role,
    unshipped: Number.isFinite(src.unshipped) ? src.unshipped : null,
    incidents: Number.isFinite(src.incidents) ? src.incidents : null,
  };
}

function makeServicePoint(t, src) {
  // `up` is a strict true test on purpose: infra's "unknown" state means the
  // probe could not answer, and an unanswered probe is not an up service.
  return { t, up: src.up === true, ms: Number.isFinite(src.ms) ? src.ms : null };
}

function makeAgentsPoint(t, src) {
  return {
    t,
    running:  Math.max(0, numOr(src.running, 0)),
    agents:   Math.max(0, numOr(src.agents, 0)),
    sessions: Math.max(0, numOr(src.sessions, 0)),
  };
}

// ===========================================================================
// Downsampling
//
// Buckets, never a stride: dropping every Nth point would let a two-minute
// outage vanish entirely from a 24 h chart. Every raw point lands in exactly
// one bucket and the bucket reports the WORST thing that happened inside it,
// so an outage can be squashed narrow but never averaged away.
// ===========================================================================

function bucketize(points, since, until, maxPoints, reduce) {
  const span = Math.max(1, until - since);
  const bucketMs = Math.max(1, Math.ceil(span / maxPoints));
  const lastIndex = Math.max(0, maxPoints - 1);
  const out = [];
  let index = -1;
  let group = null;

  for (const p of points) {
    // A point sitting exactly on `until` divides into a maxPoints+1'th bucket
    // when the span is an exact multiple, so the index is clamped into the
    // last one. That keeps the promise that a result never exceeds maxPoints.
    const raw = Math.floor((p.t - since) / bucketMs);
    const i = Math.min(lastIndex, Math.max(0, raw));
    if (group && i === index) { group.push(p); continue; }
    if (group) out.push(reduce(since + index * bucketMs, group));
    index = i;
    group = [p];
  }
  if (group) out.push(reduce(since + index * bucketMs, group));
  return out;
}

/** Median of the non-null `ms` values in a bucket. */
function bucketMs(group) {
  const values = [];
  for (const p of group) if (Number.isFinite(p.ms)) values.push(p.ms);
  return median(values);
}

function reduceStack(t, group) {
  return {
    t,
    status: worstOf(group),
    ms: bucketMs(group),
    // Last value wins for role: leadership is a state, not a rate, and the
    // freshest reading is the one worth plotting.
    role: group[group.length - 1].role,
    unshipped: maxOrNull(group, 'unshipped'),
    incidents: maxOrNull(group, 'incidents'),
  };
}

function reduceService(t, group) {
  // false wins - one failed probe inside the bucket makes the bucket bad.
  let up = true;
  for (const p of group) if (p.up !== true) { up = false; break; }
  return { t, up, ms: bucketMs(group) };
}

function reduceAgents(t, group) {
  return {
    t,
    running:  numOr(maxOrNull(group, 'running'), 0),
    agents:   numOr(maxOrNull(group, 'agents'), 0),
    sessions: numOr(maxOrNull(group, 'sessions'), 0),
  };
}

/**
 * Incidents are computed over the DOWNSAMPLED series, not the raw points, so
 * that every incident the API reports lines up exactly with a bad bucket the
 * chart actually draws. A run of adjacent bad buckets is ONE incident.
 */
function incidentRuns(buckets, isBad) {
  const runs = [];
  let cur = null;
  for (const b of buckets) {
    if (isBad(b)) {
      if (cur) { cur.to = b.t; cur.points.push(b); }
      else cur = { from: b.t, to: b.t, points: [b] };
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);
  return runs.length > MAX_INCIDENTS ? runs.slice(-MAX_INCIDENTS) : runs;
}

// ===========================================================================
// Factory
// ===========================================================================

function createHistory(opts) {
  const o = isObj(opts) ? opts : {};

  // A missing/unusable path is not fatal: the recorder still works in memory
  // and simply never persists. That keeps a bad config out of the server's
  // boot path, where it would take the whole dashboard down with it.
  const file = typeof o.file === 'string' && o.file.trim() ? o.file : null;
  const maxAgeMs = posOr(o.maxAgeMs, DEFAULT_MAX_AGE_MS);
  const flushMs = Number.isFinite(o.flushMs) && o.flushMs >= 0
    ? Math.floor(o.flushMs) : DEFAULT_FLUSH_MS;
  const maxPointsPerSeries = Math.max(1, Math.floor(posOr(o.maxPointsPerSeries,
                                                          DEFAULT_MAX_POINTS)));
  const logFn = typeof o.log === 'function' ? o.log : null;

  /** Logging must never be the thing that breaks the recorder. */
  function say(msg) {
    if (!logFn) return;
    try { logFn(String(msg)); } catch { /* a broken logger is not our problem */ }
  }

  // services is a null-prototype map because its keys are ITEM IDS out of a
  // snapshot - untrusted data. On a normal object literal, services.__proto__
  // = [] would silently rewrite the prototype instead of storing a series.
  const store = {
    version: 1,
    series: { stack: [], services: Object.create(null), agents: [] },
  };

  let dirty = false;
  let lastFlushAt = 0;              // epoch ms of the last successful write
  let lastAgentsAcceptedAt = null;  // sampling clock for the agents series
  let timer = null;

  // ------------------------------------------------------------------------
  // Append / ring semantics, shared by every series
  // ------------------------------------------------------------------------

  /**
   * Drop everything older than maxAgeMs relative to the NEWEST point (not to
   * wall-clock now: a paused dashboard should keep the week it recorded, not
   * lose it because nothing has been appended for a while), then cap length.
   */
  function trimSeries(arr) {
    if (!arr.length) return;
    const cutoff = arr[arr.length - 1].t - maxAgeMs;
    let drop = 0;
    while (drop < arr.length && arr[drop].t < cutoff) drop++;
    if (drop) arr.splice(0, drop);
    if (arr.length > maxPointsPerSeries) arr.splice(0, arr.length - maxPointsPerSeries);
  }

  /**
   * The one append path. Returns true only when a point actually landed.
   *
   * The `t <= last.t` test is load-bearing, not paranoia: the server serves
   * ONE cached stack/infra snapshot to every caller that asks inside the
   * cache TTL, so the identical snapshot - same generatedAt - is replayed to
   * record() several times per scan. Deduping on the timestamp is what stops
   * a 30 s scan interval from producing four identical points.
   */
  function appendPoint(arr, point) {
    if (!point || !Number.isFinite(point.t)) return false;
    const last = arr.length ? arr[arr.length - 1] : null;
    if (last && point.t <= last.t) return false;
    arr.push(point);
    trimSeries(arr);
    dirty = true;
    return true;
  }

  /** The series for a service id, created on first sight. */
  function serviceSeries(id) {
    const existing = store.series.services[id];
    if (Array.isArray(existing)) return existing;
    const fresh = [];
    store.series.services[id] = fresh;
    return fresh;
  }

  // ------------------------------------------------------------------------
  // Persistence
  //
  // Atomic rename, always: a crash (or a full disk) halfway through a
  // writeFileSync would leave a truncated JSON file behind, and that file is
  // a week of history. Writing to <file>.tmp and renaming means the reader
  // either sees the whole old file or the whole new one.
  // ------------------------------------------------------------------------

  function quarantine() {
    const dir = path.dirname(file);
    const base = path.basename(file).replace(/\.json$/i, '');
    const name = base + '.corrupt-' + Date.now() + '.json';
    try {
      fs.renameSync(file, path.join(dir, name));
      say('history: corrupt file moved to ' + name);
    } catch (err) {
      // Even a failed rename is survivable - we just start empty and the next
      // flush overwrites the bad file.
      say('history: corrupt file could not be moved: ' + errText(err));
    }
  }

  /** Rebuild one series from disk through the point constructors. */
  function adoptSeries(raw, make) {
    const list = [];
    if (!Array.isArray(raw)) return list;
    for (const p of raw) {
      if (!isObj(p)) continue;
      const t = Number(p.t);
      if (!Number.isFinite(t)) continue;
      list.push(make(t, p));
    }
    list.sort((a, b) => a.t - b.t);
    // Collapse duplicate timestamps so the strictly-ascending invariant that
    // appendPoint() maintains also holds for anything read off disk.
    const out = [];
    for (const p of list) {
      if (out.length && p.t <= out[out.length - 1].t) continue;
      out.push(p);
    }
    trimSeries(out);
    return out;
  }

  function load() {
    if (!file) return;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      // No file yet is the normal first-run case, not an error worth a line.
      if (!err || err.code !== 'ENOENT') {
        say('history: could not read ' + file + ': ' + errText(err));
      }
      return;
    }

    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (!isObj(parsed) || Array.isArray(parsed) || !isObj(parsed.series)) {
      quarantine();
      return;
    }

    try {
      const s = parsed.series;
      store.series.stack  = adoptSeries(s.stack,  makeStackPoint);
      store.series.agents = adoptSeries(s.agents, makeAgentsPoint);
      if (isObj(s.services)) {
        for (const [id, arr] of Object.entries(s.services)) {
          if (typeof id !== 'string' || !id) continue;
          const list = adoptSeries(arr, makeServicePoint);
          if (list.length) store.series.services[id] = list;
        }
      }
    } catch (err) {
      // A shape we could parse but not walk. Keep whatever was adopted and
      // say so rather than losing the run to an exception.
      say('history: could not adopt stored series: ' + errText(err));
    }
  }

  function flush(force) {
    const forced = force === true;
    if (!file) return false;
    if (!dirty && !forced) return false;
    if (!forced && (Date.now() - lastFlushAt) < flushMs) return false;

    let json;
    try {
      json = JSON.stringify(store);
    } catch (err) {
      say('history: could not serialise store: ' + errText(err));
      return false;
    }

    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, file);
    } catch (err) {
      say('history: flush failed: ' + errText(err));
      // Leave `dirty` set so the next flush retries, and take the half-written
      // temp file with us - it is not a valid history file.
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      return false;
    }

    dirty = false;
    lastFlushAt = Date.now();
    return true;
  }

  // ------------------------------------------------------------------------
  // record()
  // ------------------------------------------------------------------------

  function recordStack(snap, at) {
    // A "stack lib not loaded" snapshot is a bare { generatedAt, errors }
    // with no summary. Recording it would draw a hole in the uptime chart
    // that says "down" when the truth is "not measured", so it is skipped.
    const summary = snap.summary;
    if (!isObj(summary)) return false;
    const t = parseTime(snap.generatedAt, at);
    return appendPoint(store.series.stack, makeStackPoint(t, {
      status:    summary.status,
      ms:        summary.httpMs,
      role:      summary.role,
      unshipped: summary.unshipped,
      incidents: summary.incidents,
    }));
  }

  function recordInfra(snap, at) {
    if (!Array.isArray(snap.groups)) return false;
    const group = snap.groups.find(g => isObj(g) && g.id === 'railway');
    if (!group || !Array.isArray(group.items)) return false;

    const t = parseTime(snap.generatedAt, at);
    let appended = false;
    // Data-driven over whatever the group holds. Item ids are NOT hardcoded:
    // infra.js decides what is in the railway group, and a new service added
    // there should start being graphed without a change here.
    for (const it of group.items) {
      if (!isObj(it)) continue;
      const id = typeof it.id === 'string' && it.id ? it.id : null;
      if (!id) continue;
      const metaMs = isObj(it.meta) && Number.isFinite(it.meta.ms) ? it.meta.ms : null;
      const ms = metaMs === null ? msFromDetail(it.detail) : metaMs;
      if (appendPoint(serviceSeries(id), makeServicePoint(t, { up: it.state === 'up', ms }))) {
        appended = true;
      }
    }
    return appended;
  }

  function recordAgents(snap, at) {
    // Sampling gate. The clock is the CALLER's `now`, never the snapshot's
    // own timestamp, so a test passing synthetic now values drives this
    // deterministically and a stale replayed frame cannot reset it.
    if (lastAgentsAcceptedAt !== null && (at - lastAgentsAcceptedAt) < AGENTS_SAMPLE_MS) {
      return false;
    }
    lastAgentsAcceptedAt = at;

    const t = parseTime(snap.generatedAt, at);
    const sessions = Array.isArray(snap.sessions) ? snap.sessions : [];
    let running = 0;
    let agents = 0;
    let active = 0;
    for (const s of sessions) {
      if (!isObj(s)) continue;
      // A shallow session never opened its agents' sidecars: its agentCount is
      // a bare readdir and its runningCount is null. Counting those would make
      // the line jump every time the scanner changes which session it deepens,
      // so only deep sessions contribute counts.
      if (s.shallow !== true) {
        if (Number.isFinite(s.runningCount)) running += s.runningCount;
        if (Number.isFinite(s.agentCount)) agents += s.agentCount;
      }
      // Activity is known for shallow sessions too, so all of them count here.
      if (s.isActive === true) active++;
    }
    return appendPoint(store.series.agents, makeAgentsPoint(t, { running, agents, sessions: active }));
  }

  /**
   * @param {'stack'|'infra'|'agents'} kind
   * @param {object} snapshot   a scanner snapshot, any shape - validated here
   * @param {number} [now]      epoch ms; the agents sampling clock only
   * @returns {boolean} true when at least one point was appended
   */
  function record(kind, snapshot, now) {
    try {
      if (!isObj(snapshot)) return false;
      const at = Number.isFinite(now) ? now : Date.now();
      if (kind === 'stack')  return recordStack(snapshot, at);
      if (kind === 'infra')  return recordInfra(snapshot, at);
      if (kind === 'agents') return recordAgents(snapshot, at);
      return false;                                  // unknown kind, ignored
    } catch (err) {
      say('history: record(' + String(kind) + ') failed: ' + errText(err));
      return false;
    }
  }

  // ------------------------------------------------------------------------
  // query()
  // ------------------------------------------------------------------------

  /** Points with since <= t <= until. Ascending series, so one scan with a break. */
  function windowOf(points, since, until) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const t = points[i].t;
      if (t < since) continue;
      if (t > until) break;
      out.push(points[i]);
    }
    return out;
  }

  /** Non-null `ms` values out of raw points, for the percentile stats. */
  function msValues(points) {
    const out = [];
    for (const p of points) if (Number.isFinite(p.ms)) out.push(p.ms);
    return out;
  }

  function uptimePct(good, samples) {
    if (!samples) return null;
    return Math.round(1000 * good / samples) / 10;
  }

  function emptyQuery(now, since, until, hours) {
    return {
      generatedAt: isoOf(now) || new Date().toISOString(),
      since, until, hours,
      series: { stack: [], services: Object.create(null), agents: [] },
      stats: {
        stack: { samples: 0, uptimePct: null, p50Ms: null, p95Ms: null,
                 worst: null, incidents: [] },
        services: Object.create(null),
        agents: { samples: 0, peakRunning: 0, peakAt: null },
      },
    };
  }

  /**
   * @param {object} [q]
   * @param {number} [q.hours]     1..168, default 24
   * @param {number} [q.maxPoints] 50..2000, default 720
   * @param {number} [q.now]       epoch ms, default Date.now()
   */
  function query(q) {
    const qo = isObj(q) ? q : {};
    let now = Date.now();
    let hours = 24;
    let maxPoints = 720;
    try {
      if (Number.isFinite(qo.now)) now = qo.now;
      if (Number.isFinite(qo.hours)) hours = qo.hours;
      if (Number.isFinite(qo.maxPoints)) maxPoints = qo.maxPoints;
    } catch { /* exotic accessor - keep the defaults */ }

    // The server validates and 400s before it ever gets here; this is the
    // belt to that pair of braces, and it is also what makes the module safe
    // to call directly from a script.
    hours = clampNum(hours, 1, 168);
    maxPoints = Math.round(clampNum(maxPoints, 50, 2000));
    const until = now;
    const since = now - hours * 3600e3;

    try {
      // -- stack ------------------------------------------------------------
      const rawStack = windowOf(store.series.stack, since, until);
      const stackBuckets = bucketize(rawStack, since, until, maxPoints, reduceStack);
      let stackGood = 0;
      for (const p of rawStack) if (p.status === 'ok') stackGood++;
      // Every stat below is computed over the RAW in-window points rather than
      // the buckets: a bucket is a worst-case summary, so p95 or uptime taken
      // from buckets would read far worse than the week actually was. The one
      // exception is incidents, which must match the drawn buckets exactly.
      const stackPct = percentiles(msValues(rawStack));
      const stackStats = {
        samples: rawStack.length,
        uptimePct: uptimePct(stackGood, rawStack.length),
        p50Ms: stackPct.p50,
        p95Ms: stackPct.p95,
        worst: rawStack.length ? worstOf(rawStack) : null,
        incidents: incidentRuns(stackBuckets, b => b.status !== 'ok')
          .map(r => ({ from: r.from, to: r.to, status: worstOf(r.points) })),
      };

      // -- services ---------------------------------------------------------
      // Same null-prototype reasoning as the store: these keys are item ids.
      const seriesServices = Object.create(null);
      const statsServices = Object.create(null);
      for (const [id, points] of Object.entries(store.series.services)) {
        if (!Array.isArray(points)) continue;
        const raw = windowOf(points, since, until);
        if (!raw.length) continue;             // nothing in window -> omitted
        const buckets = bucketize(raw, since, until, maxPoints, reduceService);
        let good = 0;
        for (const p of raw) if (p.up === true) good++;
        const pct = percentiles(msValues(raw));
        seriesServices[id] = buckets;
        statsServices[id] = {
          samples: raw.length,
          uptimePct: uptimePct(good, raw.length),
          p50Ms: pct.p50,
          p95Ms: pct.p95,
          incidents: incidentRuns(buckets, b => b.up !== true)
            .map(r => ({ from: r.from, to: r.to })),
        };
      }

      // -- agents -----------------------------------------------------------
      const rawAgents = windowOf(store.series.agents, since, until);
      const agentBuckets = bucketize(rawAgents, since, until, maxPoints, reduceAgents);
      // Strictly-greater, so peakAt is the FIRST point that reached the peak.
      // The peakAt === null arm seeds from the first sample, which is what
      // makes a window where nothing ever ran report peak 0 at its first point
      // rather than at no point at all.
      let peakRunning = 0;
      let peakAt = null;
      for (const p of rawAgents) {
        if (peakAt === null || p.running > peakRunning) {
          peakRunning = p.running;
          peakAt = p.t;
        }
      }

      return {
        generatedAt: isoOf(now) || new Date().toISOString(),
        since, until, hours,
        series: { stack: stackBuckets, services: seriesServices, agents: agentBuckets },
        stats: {
          stack: stackStats,
          services: statsServices,
          agents: { samples: rawAgents.length, peakRunning, peakAt },
        },
      };
    } catch (err) {
      // The route must always have something well-shaped to serve.
      say('history: query failed: ' + errText(err));
      return emptyQuery(now, since, until, hours);
    }
  }

  // ------------------------------------------------------------------------
  // stats() - cheap introspection for /api/health
  // ------------------------------------------------------------------------

  function stats() {
    try {
      const services = Object.create(null);
      let points = store.series.stack.length + store.series.agents.length;
      let count = 2;                                   // stack + agents
      for (const [id, arr] of Object.entries(store.series.services)) {
        const n = Array.isArray(arr) ? arr.length : 0;
        services[id] = n;
        points += n;
        count++;
      }
      let bytes = null;
      if (file) {
        try { bytes = fs.statSync(file).size; } catch { bytes = null; }
      }
      return {
        file,
        points,
        series: count,
        byKind: {
          stack: store.series.stack.length,
          agents: store.series.agents.length,
          services,
        },
        lastFlushAt: lastFlushAt ? isoOf(lastFlushAt) : null,
        dirty,
        bytes,
      };
    } catch (err) {
      say('history: stats failed: ' + errText(err));
      return { file, points: 0, series: 2,
               byKind: { stack: 0, agents: 0, services: Object.create(null) },
               lastFlushAt: null, dirty, bytes: null };
    }
  }

  function close() {
    if (timer) {
      try { clearInterval(timer); } catch { /* already gone */ }
      timer = null;
    }
    return flush(true);
  }

  // ------------------------------------------------------------------------
  // Construction
  // ------------------------------------------------------------------------

  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (err) {
      say('history: could not create data directory: ' + errText(err));
    }
  }
  load();

  // flushMs === 0 means "no timer at all" - the pure, testable mode, where
  // the caller decides when anything touches the disk. unref() on the timer
  // otherwise, so this recorder never holds the process open by itself.
  if (flushMs > 0) {
    try {
      timer = setInterval(() => { flush(false); }, flushMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    } catch (err) {
      timer = null;
      say('history: could not start flush timer: ' + errText(err));
    }
  }

  return { record, query, flush, stats, close };
}

module.exports = { createHistory };
