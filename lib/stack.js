'use strict';
/**
 * mission-control / lib/stack.js
 * ---------------------------------------------------------------------------
 * READ-ONLY system map of ONE web app ("the stack"): its public origin, the
 * deployed version, the components its health endpoint reports on, the
 * third-party services it is wired to, its scheduled jobs, and its checkout
 * and dev server on this machine. This is the OPTIONAL stack module:
 * server.js only loads it when data/config.json sets modules.stack.enabled
 * (see lib/modules.js).
 *
 * This file is a generic ENGINE. It runs the probes (HTTP, git, netstat),
 * keeps every string clean, validates the result, and hands the map itself to
 * a PROFILE:
 *   - the built-in profile (lib/stack-profile.js), driven by a plain `map`
 *     object from config - enough for most apps, see that file's header; or
 *   - a profile module of your own (opts.profile = an absolute path), for an
 *     app whose map needs code: custom tiers, file probes, bespoke wording.
 *
 *   module.exports = { scanStack, helpers, _internals }
 *
 *   scanStack({ baseUrl,              deployed origin, e.g. https://app.example.com
 *               stackRoot,            the app's checkout on this machine
 *               localPort = 3000,     local dev server port
 *               label     = 'Stack',  display name used in error lines
 *               profile   = null,     absolute path of a profile module
 *               map       = null,     config for the built-in profile
 *                                     (ignored when `profile` is set)
 *               timeoutMs = 4000 })   -> Promise<StackSnapshot>
 *
 *   StackSnapshot = { generatedAt, scanMs, errors[], summary, tiers[],
 *                     nodes[], edges[] }
 *
 * Without baseUrl + stackRoot the options come from data/config.json
 * (MC_CONFIG_FILE overrides the path) through lib/modules.js:
 * modules.stack.scan = { baseUrl, stackRoot, localPort, label, profile, map }.
 *
 * Node ids are STABLE across scans - the dashboard feed diffs `state` by `id`
 * between two snapshots, so a profile must never recycle or reshuffle an id.
 *
 * Profile interface. A profile is a CommonJS module exporting:
 *   tiers         [{ id, label }]             required, display order
 *   builders      [(ctx, h) => node[]]        required, called in order; the
 *                                             nodes of earlier builders are in
 *                                             ctx.byId when later ones run
 *   edges         (ctx, h) => edge[]          optional; deduped + validated
 *   scanFiles     (root, h) => Promise<obj>   optional local file probe; its
 *                                             result is ctx.files and its
 *                                             errors[] become error lines
 *   filesFallback (root) => obj               optional; ctx.files when
 *                                             scanFiles misses the deadline
 *   paths         { health, version, config, incidents }   optional probe
 *                                             path overrides; null skips one
 *                                             (health cannot be skipped)
 *   prodRef       'origin/HEAD'               optional; the deployed git ref
 *                                             that "unshipped" counts against
 *   headers       ['x-...']                   optional extra response headers
 *                                             kept on probe results
 * `h` is the exported `helpers` object (node(), edge(), clamp(), git(), the
 * time formatters, ...). A profile must not require() files of this repo by
 * relative path - everything it needs arrives as `h`. A profile file is
 * re-required when its mtime changes, so an edit needs no restart; one that
 * fails to load becomes an error line naming the file, and the scan falls back
 * to the built-in profile.
 *
 *   ctx = { label, baseUrl, host, stackRoot, localPort, timeoutMs, now,
 *           prodRef, paths, urls, healthUrl,
 *           health, version, config, incidents,   probe results (below)
 *           hj,               health JSON object, or null
 *           reachable,        health answered with a JSON object
 *           deployedCommit,   /api/version commit, if it looks like a sha
 *           git, files, dev,  checkout / profile file probe / dev server
 *           byId }            Map of the nodes built so far
 *   probe result = { ok, reached, status, ms, url, headers, json, error,
 *                    cached, cacheAgeMs }  (null when the path is skipped)
 *
 * Hard rules baked into this file (same house rules as lib/infra.js):
 *   - NEVER rejects. Every probe is individually time-boxed and its failure
 *     becomes a node in state "unknown" plus one human line in errors[]. A
 *     profile that throws becomes an error line too.
 *   - Read-only. Nothing is started, stopped, written or installed. No npm
 *     script is ever run inside the checkout. Only read-only git plumbing is
 *     spawned, via execFile (never a shell string), and NEVER `git fetch` -
 *     staleness of the deploy ref is inferred from .git/FETCH_HEAD.
 *   - No secrets. .env* files are never opened. Every emitted string passes
 *     through scrub() (infra.redact + a local credential-shaped guard).
 *   - Honest states. A third-party dependency with no public probe is
 *     "wired" ("in the code path, not observable from here"), never "up".
 *   - Rate-limit friendly. Many apps rate-limit /api/* and exempt only the
 *     health route, so health is fetched fresh every scan and version /
 *     config / incidents are served from a short in-process TTL cache (see
 *     REMOTE_TTL). Cache age is reported in each node's meta.
 *
 * Vocabulary
 *   state  : up | degraded | down | armed | idle | hold | disabled | wired | unknown
 *   source : health | version | config | incidents | probe | repo | git | cron
 *            | process | file | static
 *   kind   : serves | runs | uses | stores | schedules | deploys | notifies
 *
 * Standalone:  node lib/stack.js
 *   -> JSON snapshot on stdout, readable tier/node table on stderr (ASCII).
 *
 * Zero npm dependencies. CommonJS. Node 20+.
 */

const https        = require('node:https');
const http         = require('node:http');
const fs           = require('node:fs');
const fsp          = require('node:fs/promises');
const path         = require('node:path');
const os           = require('node:os');
const { execFile } = require('node:child_process');

const USER_AGENT = 'mission-control/1.0 (+local dashboard probe)';

// U+00B7 MIDDLE DOT, kept as an escape so this source file stays pure ASCII.
// lib/infra.js already emits it in `detail`; the dashboard renders UTF-8.
const DOT = ' \u00b7 ';

// ---------------------------------------------------------------------------
// Reuse lib/infra.js's verified helpers where they exist, degrade if they do
// not. infra.js has no top-level side effects (its CLI is behind
// require.main === module), so requiring it here is free and safe.
// ---------------------------------------------------------------------------

let INF = {};
let INFRA_LOAD_ERR = null;
try {
  const m = require('./infra');
  INF = (m && m._internals) || {};
  if (!INF || typeof INF !== 'object') INF = {};
} catch (err) {
  INF = {};
  INFRA_LOAD_ERR = (err && err.message) || String(err);
}
const has = name => typeof INF[name] === 'function';

/** Resolve `p`, or `fallback` after `ms`. Never rejects. */
const withTimeout = has('withTimeout') ? INF.withTimeout : function (p, ms, fallback) {
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    if (t.unref) t.unref();
    Promise.resolve(p).then(
      v => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(t); resolve(fallback); } }
    );
  });
};

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fmtUTC = has('fmtUTC') ? INF.fmtUTC : function (d) {
  const p = n => String(n).padStart(2, '0');
  return `${DOW_NAMES[d.getUTCDay()]} ${p(d.getUTCDate())} ${MON_NAMES[d.getUTCMonth()]}`
       + ` ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
};

function spanText(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
const relFromNow = has('relFromNow') ? INF.relFromNow
  : (future, now = new Date()) => `in ${spanText(future.getTime() - now.getTime())}`;
const relSince = has('relSince') ? INF.relSince
  : (past, now = new Date()) => spanText(now.getTime() - past.getTime());

const redact = has('redact') ? INF.redact : function (s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s/@]*:[^\s/@]*@/gi, '$1://<redacted>@')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<redacted>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted>');
};

// Cron evaluation is the one piece worth NOT reimplementing: infra.js's
// nextCronFireUTC is the verified version. Without it, jobs still report
// their expression but cannot claim a next fire, so they degrade to
// "unknown" rather than inventing a time.
const CRON_OK = has('nextCronFireUTC');
const nextCronFireUTC = CRON_OK ? INF.nextCronFireUTC : () => null;

// ===========================================================================
// Output hygiene
// ===========================================================================

// Second line of defence, on top of infra's redact(). Anything shaped like a
// credential is replaced wholesale rather than trimmed - a partial key is
// still a leak.
const LEAK_RE = new RegExp([
  'postgres(?:ql)?://\\S+',
  '\\b(?:sk|pk|rk|xox[abps])[-_][A-Za-z0-9_-]{6,}',
  '\\b(?:api[_-]?key|apikey|key|token|secret|password|passwd|pwd|bearer|credential)\\b\\s*[:=]\\s*\\S+',
  '\\b[\\w.+-]+@[a-z0-9.-]+\\.[a-z]{2,}\\b',
].join('|'), 'gi');

/** Every string that leaves this module goes through here. */
function scrub(s) {
  if (s == null) return '';
  let out = String(s);
  // Control characters are never allowed in the payload - newlines and tabs
  // included. They break the dashboard's one-line rows and can smuggle
  // terminal escapes into the CLI output.
  out = out.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  try { out = redact(out); } catch { /* fall through to the local guard */ }
  out = out.replace(LEAK_RE, '[redacted]');
  return out.replace(/\s{2,}/g, ' ').trim();
}

function clamp(s, n) {
  const t = scrub(s);
  return t.length <= n ? t : (t.slice(0, Math.max(0, n - 3)).trimEnd() + '...');
}

const LABEL_MAX  = 26;
const DETAIL_MAX = 60;

/** Recursively scrub a meta object before it can reach the dashboard. */
function scrubMeta(v, depth = 0) {
  if (depth > 6) return null;
  if (typeof v === 'string') return scrub(v);
  if (Array.isArray(v)) return v.slice(0, 50).map(x => scrubMeta(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v).slice(0, 50)) {
      if (val === undefined) continue;
      o[k] = scrubMeta(val, depth + 1);
    }
    return o;
  }
  return v;
}

const STATES = new Set(['up', 'degraded', 'down', 'armed', 'idle', 'hold',
                        'disabled', 'wired', 'unknown']);
const SOURCES = new Set(['health', 'version', 'config', 'incidents', 'probe',
                         'repo', 'git', 'cron', 'process', 'file', 'static']);
const KINDS = new Set(['serves', 'runs', 'uses', 'stores', 'schedules',
                       'deploys', 'notifies']);

/** The one way a node is made: enums enforced, every string clamped. */
function node(id, tier, label, state, detail, sub, source, meta) {
  return {
    id,
    tier,
    label:  clamp(label, LABEL_MAX),
    state:  STATES.has(state) ? state : 'unknown',
    detail: clamp(detail, DETAIL_MAX),
    sub:    clamp(sub, 90),
    source: SOURCES.has(source) ? source : 'static',
    meta:   meta ? scrubMeta(meta) : {},
  };
}

const edge = (from, to, kind) => ({ from, to, kind: KINDS.has(kind) ? kind : 'uses' });

function shortErr(err) {
  if (!err) return 'unknown error';
  const map = {
    ENOTFOUND: 'DNS lookup failed', ECONNREFUSED: 'connection refused',
    ECONNRESET: 'connection reset', ETIMEDOUT: 'timed out',
    EHOSTUNREACH: 'host unreachable', ENETUNREACH: 'network unreachable',
    EAI_AGAIN: 'DNS temporarily unavailable', CERT_HAS_EXPIRED: 'TLS cert expired',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS hostname mismatch',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS verify failed',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed TLS cert',
    ENOENT: 'not found', EACCES: 'permission denied', EPERM: 'permission denied',
  };
  const code = err.code || '';
  if (map[code]) return map[code];
  return scrub(String(err.message || code || err)).slice(0, 90) || 'request failed';
}

function isoOrNull(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A health-field value -> node state. 'ok' -> up, failures -> down. */
function healthState(value, reachable) {
  if (!reachable) return 'unknown';
  if (value == null) return 'unknown';
  const v = String(value).toLowerCase();
  if (v === 'ok') return 'up';
  if (v === 'error' || v === 'down' || v === 'fail') return 'down';
  if (v === 'mismatch') return 'down';
  if (v === 'unknown') return 'degraded';
  return 'degraded';
}

// ===========================================================================
// HTTP probe
//
// lib/infra.js has an httpProbe, but it drains response headers - and the
// edge tier's job includes saying what sits in front of the origin, from the
// `server` / `cf-ray` style headers. So this is a local variant that keeps a
// short list of headers, parses JSON, and hard-bounds the body. Never rejects.
// ===========================================================================

const KEEP_HEADERS = ['server', 'cf-ray', 'cf-cache-status', 'content-type', 'retry-after'];

/**
 * GET `url` and parse JSON. Options: timeoutMs, maxBytes, label (named in the
 * HTTP 429 message), keepHeaders (header names to keep; default KEEP_HEADERS).
 */
function getJson(url, { timeoutMs = 4000, maxBytes = 256 * 1024,
                        redirectsLeft = 2, _started, label = null,
                        keepHeaders = KEEP_HEADERS } = {}) {
  const started = _started == null ? Date.now() : _started;
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    const fail = (error, status) => done({
      ok: false, reached: false, error, status: status || 0,
      ms: Date.now() - started, url, headers: {}, json: null,
    });

    let u;
    try { u = new URL(url); } catch { return fail('malformed URL'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return fail(`unsupported protocol ${u.protocol}`);
    }
    const mod = u.protocol === 'https:' ? https : http;

    let req;
    try {
      req = mod.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: (u.pathname || '/') + (u.search || ''),
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, accept: 'application/json,*/*',
                   connection: 'close' },
        timeout: Math.max(200, timeoutMs),
      }, res => {
        const status = res.statusCode || 0;
        const raw = res.headers || {};
        const headers = {};
        for (const h of keepHeaders) if (raw[h] != null) headers[h] = String(raw[h]);
        res.on('error', () => {});

        const loc = raw.location;
        if (status >= 300 && status < 400 && loc && redirectsLeft > 0) {
          let next;
          try { next = new URL(loc, url).toString(); }
          catch { res.resume(); return fail('bad redirect target', status); }
          res.resume();
          const remaining = Math.max(250, timeoutMs - (Date.now() - started));
          return getJson(next, { timeoutMs: remaining, maxBytes, label, keepHeaders,
                                 redirectsLeft: redirectsLeft - 1, _started: started })
            .then(r => done({ ...r, url, redirected: true }));
        }

        let buf = '', bytes = 0, over = false;
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (over) return;
          bytes += Buffer.byteLength(chunk, 'utf8');
          if (bytes > maxBytes) {
            over = true; buf = '';
            try { res.destroy(); } catch { /* already gone */ }
            return;
          }
          buf += chunk;
        });
        const finish = () => {
          let json = null, parseErr = null;
          if (over) {
            parseErr = `body exceeded ${maxBytes} bytes`;
          } else if (buf) {
            try { json = JSON.parse(buf); }
            catch { parseErr = 'response was not JSON'; }
          } else {
            parseErr = 'empty body';
          }
          // Rate limiters commonly answer with a PLAIN TEXT body, so a 429
          // shows up as "not JSON" unless it is named explicitly.
          if (status === 429) parseErr = `rate limited by ${label || 'the server'} (HTTP 429)`;
          done({
            // A 503 from a health route is a real answer, not a probe failure -
            // `ok` means "we got an HTTP response we could read", and the
            // caller decides what the status code means.
            ok: status >= 200 && status < 500 && json != null,
            reached: status > 0,
            status, ms: Date.now() - started, url, headers, json,
            error: parseErr,
          });
        };
        res.on('end', finish);
        res.on('close', finish);            // done() is idempotent
      });
    } catch (err) { return fail(shortErr(err)); }

    req.on('timeout', () => {
      const e = new Error('timed out'); e.code = 'ETIMEDOUT';
      req.destroy(e);
    });
    req.on('error', err => fail(shortErr(err)));
    try { req.end(); } catch (err) { fail(shortErr(err)); }
  });
}

// ---------------------------------------------------------------------------
// TTL cache for the endpoints that are polled less often than health. Only
// successful reads are cached - a failure is always retried on the next scan,
// so "unreachable" can never be masked by a stale hit.
// ---------------------------------------------------------------------------

const REMOTE_TTL = { version: 120000, config: 120000, incidents: 300000 };
const REMOTE_CACHE = new Map();          // url -> { at, value }
const REMOTE_CACHE_MAX = 12;

async function cachedJson(url, ttlMs, opts) {
  const now = Date.now();
  const hit = REMOTE_CACHE.get(url);
  if (hit && (now - hit.at) < ttlMs) {
    return { ...hit.value, cached: true, cacheAgeMs: now - hit.at };
  }
  const res = await getJson(url, opts);
  if (res && res.reached && res.json != null) {
    if (REMOTE_CACHE.size >= REMOTE_CACHE_MAX) {
      REMOTE_CACHE.delete(REMOTE_CACHE.keys().next().value);
    }
    REMOTE_CACHE.set(url, { at: now, value: res });
  }
  return { ...res, cached: false, cacheAgeMs: 0 };
}

// ===========================================================================
// git - read-only plumbing, execFile only, never a shell string, never fetch
// ===========================================================================

const GIT_TIMEOUT = 2000;

/**
 * Turn a git failure into ONE short human line. Node's execFile error message
 * is "Command failed: <the whole command line>\n<stderr>", and a command line
 * must never reach the dashboard - so only git's own first `fatal:`/`error:`
 * line is kept, newline-free and length-capped.
 */
function gitErrText(err, stderr, timeoutMs) {
  if (err && err.killed) return `timed out after ${timeoutMs} ms`;
  const line = String(stderr || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => /^(fatal|error|warning):/i.test(l) || l.length > 0);
  if (line) return clamp(line.replace(/^(fatal|error):\s*/i, ''), 80);
  const code = err && Number.isFinite(err.code) ? ` (exit ${err.code})` : '';
  return `git failed${code}`;
}

/** Run one read-only git command in `root`. Resolves { ok, out, err }. */
function git(root, args, timeoutMs = GIT_TIMEOUT) {
  return new Promise(resolve => {
    let child;
    const finish = (ok, out, err) => resolve({ ok, out: String(out || '').trim(), err });
    try {
      child = execFile('git', ['-C', root, ...args], {
        timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
        killSignal: 'SIGKILL', encoding: 'utf8',
        // Keep git from prompting for anything, ever.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      }, (err, stdout, stderr) => {
        if (err) return finish(false, stdout, gitErrText(err, stderr, timeoutMs));
        finish(true, stdout, null);
      });
    } catch (err) { return finish(false, '', shortErr(err)); }
    if (child) child.on('error', e => finish(false, '', shortErr(e)));
  });
}

const US = '\u001f';   // ASCII unit separator - safe field delimiter for git

// The ref "unshipped" is counted against. A local branch usually tracks the
// branch it was cloned from, which is not always the one that deploys, so the
// profile names the deployed ref explicitly; origin/HEAD (the remote's
// default branch) is the neutral default.
const DEFAULT_PROD_REF = 'origin/HEAD';

async function scanGit(root, prodRef = DEFAULT_PROD_REF) {
  const out = {
    present: false, branch: null, commit: null, unshipped: null, dirty: null,
    lastCommitAt: null, lastCommitSubject: null, lastFetchAt: null,
    prodRefCommit: null, upstreamRef: prodRef, errors: [],
  };

  // Settle "is this a checkout at all?" from disk before spawning anything.
  // `.git` is a directory in a normal clone and a FILE in a linked worktree,
  // so either counts. Bailing here turns a missing checkout into ONE error
  // line instead of five identical git failures, and skips five processes.
  try { out.present = fs.statSync(path.join(root, '.git')) != null; }
  catch { out.present = false; }
  if (!out.present) {
    let rootThere = false;
    try { rootThere = fs.statSync(root).isDirectory(); } catch { rootThere = false; }
    out.errors.push(rootThere ? `${root} is not a git checkout`
                              : `checkout directory ${root} does not exist`);
    return out;
  }

  // .git/FETCH_HEAD mtime says how stale our idea of the deploy ref is. We
  // deliberately do NOT run `git fetch` - a scanner must not mutate the repo.
  try {
    const st = await fsp.stat(path.join(root, '.git', 'FETCH_HEAD'));
    out.lastFetchAt = new Date(st.mtimeMs).toISOString();
  } catch { out.lastFetchAt = null; }

  const [branch, log, ahead, status, prodRefOut] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['log', '-1', `--format=%h${US}%cI${US}%s`]),
    git(root, ['rev-list', '--count', `${prodRef}..HEAD`]),
    git(root, ['status', '--porcelain']),
    git(root, ['rev-parse', '--short', prodRef]),
  ]);

  if (branch.ok && branch.out) out.branch = branch.out.split(/\r?\n/)[0];
  else out.errors.push(`git branch: ${branch.err || 'no output'}`);

  if (log.ok && log.out) {
    const [sha, when, subject] = log.out.split(US);
    out.commit = (sha || '').trim() || null;
    out.lastCommitAt = isoOrNull(when);
    out.lastCommitSubject = (subject || '').trim() || null;
    out.present = true;
  } else {
    out.errors.push(`git log: ${log.err || 'no output'}`);
  }

  if (ahead.ok && /^\d+$/.test(ahead.out)) out.unshipped = Number(ahead.out);
  else out.errors.push(`git rev-list ${prodRef}..HEAD: ${ahead.err || 'no output'}`);

  if (status.ok) out.dirty = status.out ? status.out.split(/\r?\n/).filter(Boolean).length : 0;
  else out.errors.push(`git status: ${status.err || 'no output'}`);

  if (prodRefOut.ok && /^[0-9a-f]{7,40}$/i.test(prodRefOut.out)) out.prodRefCommit = prodRefOut.out;

  return out;
}

// ===========================================================================
// Local filesystem helpers (for profiles' scanFiles)
// ===========================================================================

async function statOrNull(p) {
  try { return await fsp.stat(p); } catch { return null; }
}

/** Newest file in `dir` matching `filterFn`. Filter runs BEFORE the cap. */
async function newestIn(dir, filterFn, cap = 500) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return null; }
  const wanted = (filterFn ? names.filter(filterFn) : names).slice(0, cap);
  let best = null, count = 0;
  for (const name of wanted) {
    const st = await statOrNull(path.join(dir, name));
    if (!st || !st.isFile()) continue;
    count++;
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { name, mtimeMs: st.mtimeMs, size: st.size };
    }
  }
  return { best, count };
}

/** First candidate path that exists as a file. */
async function firstFile(candidates) {
  for (const p of candidates) {
    const st = await statOrNull(p);
    if (st && st.isFile()) return { path: p, mtimeMs: st.mtimeMs, size: st.size };
  }
  return null;
}

// ===========================================================================
// Local dev server - is anything LISTENING on <localPort>, and does it answer?
//
// netstat is parsed rather than PowerShell'd: `netstat -ano -p tcp` is a
// single ~110 ms native call, where Get-NetTCPConnection pays PowerShell
// startup. The parse is locale-independent - it keys off the foreign address
// being the wildcard (0.0.0.0:0 / [::]:0), not the localised state word
// ("LISTENING" is translated on non-English Windows, the addresses are not).
// ===========================================================================

function netstatTcp(timeoutMs = 1200) {
  return new Promise(resolve => {
    let child;
    const done = v => resolve(v);
    try {
      child = execFile('netstat', ['-ano', '-p', 'tcp'], {
        timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        killSignal: 'SIGKILL', encoding: 'utf8',
      }, (err, stdout) => {
        if (err && !stdout) return done({ ok: false, error: shortErr(err), lines: [] });
        done({ ok: true, lines: String(stdout).split(/\r?\n/) });
      });
    } catch (err) { return done({ ok: false, error: shortErr(err), lines: [] }); }
    if (child) child.on('error', e => done({ ok: false, error: shortErr(e), lines: [] }));
  });
}

function findListener(lines, port) {
  const suffix = ':' + port;
  for (const line of lines) {
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    if (!/^tcp$/i.test(p[0])) continue;
    if (!p[1].endsWith(suffix)) continue;
    if (p[2] !== '0.0.0.0:0' && p[2] !== '[::]:0' && p[2] !== '*:*') continue;
    const pid = Number(p[p.length - 1]);
    return { local: p[1], pid: Number.isFinite(pid) ? pid : null };
  }
  return null;
}

async function scanDevServer(port, timeoutMs, healthPath = '/api/health', probeOpts = {}) {
  const started = Date.now();
  const out = { port, listening: false, pid: null, netstatOk: false,
                netstatMs: 0, probe: null, error: null };

  const ns = await withTimeout(netstatTcp(1200), 1400,
                               { ok: false, error: 'netstat exceeded hard timeout', lines: [] });
  out.netstatOk = !!ns.ok;
  out.netstatMs = Date.now() - started;
  if (!ns.ok) {
    out.error = ns.error || 'netstat failed';
    // Fall through and probe anyway - a failed netstat must not be reported
    // as "nothing is running".
  } else {
    const hit = findListener(ns.lines, port);
    if (hit) { out.listening = true; out.pid = hit.pid; }
    else return out;                       // nothing bound: skip the probe
  }

  // Loopback only, so 1.2 s is generous. In the common case (nothing bound)
  // we never get here at all, which is what keeps the local group under 1 s.
  const budget = Math.min(1200, Math.max(400, timeoutMs));
  out.probe = await withTimeout(
    getJson(`http://127.0.0.1:${port}${healthPath}`,
            { ...probeOpts, timeoutMs: budget, maxBytes: 64 * 1024 }),
    budget + 200,
    { ok: false, reached: false, error: 'local probe exceeded hard timeout',
      status: 0, ms: budget, headers: {}, json: null });
  return out;
}

// ===========================================================================
// Profiles
// ===========================================================================

const BUILTIN = require('./stack-profile');

const DEFAULT_PATHS = { health: '/api/health', version: '/api/version',
                        config: '/api/config', incidents: '/api/status/incidents' };

/** Why `p` is not a usable profile, or null when it is. */
function profileProblem(p) {
  if (!p || typeof p !== 'object') return 'module did not export an object';
  if (!Array.isArray(p.tiers) || !p.tiers.length
      || !p.tiers.every(t => t && typeof t.id === 'string' && typeof t.label === 'string')) {
    return 'tiers must be a non-empty array of { id, label }';
  }
  if (!Array.isArray(p.builders) || !p.builders.every(b => typeof b === 'function')) {
    return 'builders must be an array of functions';
  }
  if (p.edges != null && typeof p.edges !== 'function') return 'edges must be a function';
  if (p.scanFiles != null && typeof p.scanFiles !== 'function') return 'scanFiles must be a function';
  return null;
}

// file -> { mtimeMs, result: { profile, error } }. A profile is re-required
// when its mtime changes, so editing it needs no server restart; a broken
// file is remembered as broken until it changes again.
const PROFILE_CACHE = new Map();

function loadProfile(file) {
  let st;
  try { st = fs.statSync(file); }
  catch (err) { return { profile: null, error: `profile ${file}: ${shortErr(err)}` }; }
  const hit = PROFILE_CACHE.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.result;
  let result;
  try {
    const resolved = require.resolve(file);
    delete require.cache[resolved];
    const mod = require(resolved);
    const problem = profileProblem(mod);
    result = problem ? { profile: null, error: `profile ${file} is unusable: ${problem}` }
                     : { profile: mod, error: null };
  } catch (err) {
    result = { profile: null, error: `profile ${file} failed to load: ${shortErr(err)}` };
  }
  if (PROFILE_CACHE.size >= 8) PROFILE_CACHE.delete(PROFILE_CACHE.keys().next().value);
  PROFILE_CACHE.set(file, { mtimeMs: st.mtimeMs, result });
  return result;
}

// ===========================================================================
// Public API
// ===========================================================================

const DEFAULTS = {
  timeoutMs: 4000,
  localPort: 3000,
  label: 'Stack',
};

// Stand-ins used only when nothing is configured: an unreachable origin and a
// checkout path that cannot exist, so every probe reports "unknown" honestly
// instead of scanning some other repo.
const UNCONFIGURED_BASE_URL = 'http://127.0.0.1:9';
const UNCONFIGURED_ROOT = path.join(__dirname, '..', 'data', '.stack-root-not-configured');

/**
 * Scan options from data/config.json (modules.stack), for a caller that does
 * not pass them - the CLI, or an older server.js hot-reloading this file.
 * server.js itself always passes them.
 */
function configuredScanOpts() {
  try {
    const file = process.env.MC_CONFIG_FILE || path.join(__dirname, '..', 'data', 'config.json');
    const m = require('./modules').loadModules(file).modules;
    const s = m && m.stack;
    if (!s) return { reason: 'lib/modules.js returned no modules.stack' };
    if (!s.enabled) return { reason: s.reason };
    const sc = s.scan || {};
    return Object.assign({}, sc, { label: sc.label != null ? sc.label : s.label });
  } catch (err) {
    return { reason: 'lib/modules.js failed: ' + ((err && err.message) || err) };
  }
}

/** opts (+ config fallback) -> the resolved settings scanStack runs with. */
function resolveScanOpts(opts = {}) {
  const notes = [];
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.floor(opts.timeoutMs) : DEFAULTS.timeoutMs;
  const conf = opts.baseUrl && opts.stackRoot ? {} : configuredScanOpts();
  if (!opts.baseUrl && !conf.baseUrl) {
    notes.push('stack module not configured: '
               + (conf.reason || 'no modules.stack.baseUrl'));
  }
  const pick = k => (opts[k] != null ? opts[k] : conf[k]);
  const stackRoot = String(opts.stackRoot || conf.stackRoot || UNCONFIGURED_ROOT).replace(/\\/g, '/');
  const baseUrl   = String(opts.baseUrl || conf.baseUrl || UNCONFIGURED_BASE_URL).replace(/\/+$/, '');
  const portIn    = pick('localPort');
  const localPort = Number.isFinite(portIn) && portIn > 0 ? Math.floor(portIn) : DEFAULTS.localPort;
  const labelIn   = pick('label');
  const label     = typeof labelIn === 'string' && labelIn.trim()
    ? labelIn.trim() : DEFAULTS.label;
  let profile     = pick('profile');
  profile = typeof profile === 'string' && profile.trim()
    ? path.resolve(path.join(__dirname, '..'), profile.trim()) : null;
  const mapIn = pick('map');
  const map = mapIn && typeof mapIn === 'object' && !Array.isArray(mapIn) ? mapIn : null;
  return { timeoutMs, stackRoot, baseUrl, localPort, label, profile, map, notes };
}

/**
 * @param {object}  [opts]
 * @param {number}  [opts.timeoutMs=4000]  hard per-probe budget
 * @param {string}  [opts.stackRoot]       the app's checkout on this machine
 * @param {string}  [opts.baseUrl]         deployed origin
 * @param {number}  [opts.localPort=3000]  local dev server port
 * @param {string}  [opts.label='Stack']   display name used in error lines
 * @param {string}  [opts.profile]         absolute path of a profile module
 * @param {object}  [opts.map]             config for the built-in profile
 * @returns {Promise<object>} never rejects
 */
async function scanStack(opts = {}) {
  const t0 = Date.now();
  const now = new Date();
  const errors = [];

  const o = resolveScanOpts(opts || {});
  const { timeoutMs, stackRoot, baseUrl, localPort, label } = o;
  errors.push(...o.notes);

  let profile = null;
  if (o.profile) {
    const loaded = loadProfile(o.profile);
    if (loaded.error) errors.push(`${loaded.error} - using the built-in profile`);
    profile = loaded.profile;
  }
  if (!profile) profile = BUILTIN.makeProfile(o.map);

  if (INFRA_LOAD_ERR) {
    errors.push(`lib/infra.js helpers unavailable (${INFRA_LOAD_ERR}) - using local fallbacks`);
  } else if (!CRON_OK) {
    errors.push('lib/infra.js exposed no cron evaluator - job fire times unavailable');
  }

  let host = baseUrl;
  try { host = new URL(baseUrl).host; } catch { /* keep the raw string */ }

  const paths = Object.assign({}, DEFAULT_PATHS, profile.paths || {});
  if (typeof paths.health !== 'string' || !paths.health) paths.health = DEFAULT_PATHS.health;
  const urlOf = p => (typeof p === 'string' && p ? `${baseUrl}${p}` : null);
  const urls = { health: urlOf(paths.health), version: urlOf(paths.version),
                 config: urlOf(paths.config), incidents: urlOf(paths.incidents) };
  const healthUrl = urls.health;
  const prodRef = typeof profile.prodRef === 'string' && profile.prodRef
    ? profile.prodRef : DEFAULT_PROD_REF;
  const keepHeaders = KEEP_HEADERS.concat(
    (Array.isArray(profile.headers) ? profile.headers : [])
      .filter(x => typeof x === 'string').map(x => x.toLowerCase()));
  const probe = { label, keepHeaders };

  // One shared deadline. withTimeout is the hard backstop in case a socket's
  // own timeout is bypassed (a wedged DNS resolver, for instance); nothing
  // below can reject, so scanStack always resolves inside ~timeoutMs + 400.
  const guard = (p, fb) => withTimeout(p, timeoutMs + 300, fb);
  const httpFallback = url => ({ ok: false, reached: false, status: 0, ms: timeoutMs,
                                 url, headers: {}, json: null, cached: false,
                                 cacheAgeMs: 0, error: 'probe exceeded hard timeout' });
  const remote = (key, maxBytes) => (urls[key]
    ? guard(cachedJson(urls[key], REMOTE_TTL[key], { ...probe, timeoutMs, maxBytes }),
            httpFallback(urls[key]))
    : null);

  const filesFallback = () => {
    let fb = null;
    try { fb = typeof profile.filesFallback === 'function' ? profile.filesFallback(stackRoot) : null; }
    catch { fb = null; }
    return fb && typeof fb === 'object' ? fb : { errors: ['file probe exceeded hard timeout'] };
  };
  const filesProbe = typeof profile.scanFiles === 'function'
    ? guard(Promise.resolve()
              .then(() => profile.scanFiles(stackRoot, helpers))
              .catch(err => Object.assign(filesFallback(),
                                          { errors: [`file probe failed: ${shortErr(err)}`] })),
            filesFallback())
    : null;

  const [health, version, config, incidents, gitInfo, files, dev] = await Promise.all([
    // Health is always fetched fresh.
    guard(getJson(healthUrl, { ...probe, timeoutMs, maxBytes: 64 * 1024 }), httpFallback(healthUrl)),
    remote('version', 32 * 1024),
    remote('config', 32 * 1024),
    // An incidents feed can carry prose bodies; 512 KB is headroom. Only the
    // OPEN count is read out of it - no description text is ever emitted.
    remote('incidents', 512 * 1024),
    guard(scanGit(stackRoot, prodRef), { present: false, branch: null, commit: null,
                                         unshipped: null, dirty: null, lastCommitAt: null,
                                         lastCommitSubject: null, lastFetchAt: null,
                                         prodRefCommit: null,
                                         errors: ['git probe exceeded hard timeout'] }),
    filesProbe,
    guard(scanDevServer(localPort, timeoutMs, paths.health, probe),
          { port: localPort, listening: false, pid: null, netstatOk: false,
            netstatMs: 0, probe: null, error: 'local probe exceeded hard timeout' }),
  ]);

  // -- surface probe failures ------------------------------------------------
  const hj = health && health.json && typeof health.json === 'object'
             && !Array.isArray(health.json) ? health.json : null;
  const reachable = !!(health && health.reached && hj);

  if (!health || !health.reached) {
    errors.push(`${label} health probe failed: ${(health && health.error) || 'unreachable'} (${healthUrl})`);
  } else if (!hj) {
    errors.push(`${label} ${paths.health} returned HTTP ${health.status} with no readable JSON`);
  }
  for (const [key, res] of [['version', version], ['config', config],
                            ['incidents', incidents]]) {
    if (!urls[key]) continue;                // this profile skips the probe
    if (res && res.cached) continue;         // served from cache, not re-fetched
    if (!res || !res.reached) {
      errors.push(`${label} ${paths[key]} unreachable: ${(res && res.error) || 'no response'}`);
    } else if (res.json == null) {
      errors.push(`${label} ${paths[key]} returned HTTP ${res.status}: `
                + `${res.error || 'unreadable body'}`);
    }
  }
  for (const e of (gitInfo.errors || [])) errors.push(`${label} checkout: ${e}`);
  for (const e of ((files && files.errors) || [])) errors.push(`${label} files: ${e}`);
  if (dev && dev.error) errors.push(`local dev server: ${dev.error}`);

  // -- summary ---------------------------------------------------------------
  let status;
  if (!health || !health.reached) status = 'unreachable';
  else if (hj && ['ok', 'degraded', 'down'].includes(String(hj.status).toLowerCase())) {
    status = String(hj.status).toLowerCase();
  } else if (health.status >= 500) status = 'down';
  else status = 'degraded';

  const vj = version && version.json && typeof version.json === 'object'
             && !Array.isArray(version.json) ? version.json : null;
  let deployedCommit = vj && typeof vj.commit === 'string' ? vj.commit.trim() : null;
  if (deployedCommit && !/^[0-9a-f]{7,40}$/i.test(deployedCommit)) deployedCommit = null;

  // The engine does not infer a deploy time: a version endpoint's start
  // stamp is often process start or first-request time, not a deploy, and
  // reporting it as one would be a fabricated uptime.
  const deployedAt = null;

  const localCommit = gitInfo.commit || null;
  let prodMatchesLocal = null;
  if (deployedCommit && localCommit) {
    const a = deployedCommit.toLowerCase(), b = localCommit.toLowerCase();
    const n = Math.min(a.length, b.length);
    prodMatchesLocal = n >= 7 && a.slice(0, n) === b.slice(0, n);
  }

  // Open == resolved_at null. Accept a bare array or { incidents: [...] };
  // anything else (an { error } body, say) counts as "not known".
  const isOpen = x => x && typeof x === 'object'
                   && x.resolved_at == null && x.resolvedAt == null;
  let openIncidents = null;
  if (incidents && Array.isArray(incidents.json)) {
    openIncidents = incidents.json.filter(isOpen).length;
  } else if (incidents && incidents.json && Array.isArray(incidents.json.incidents)) {
    openIncidents = incidents.json.incidents.filter(isOpen).length;
  }

  const summary = {
    status,
    role: hj && (hj.role === 'leader' || hj.role === 'follower') ? hj.role : null,
    httpMs: health && health.reached ? health.ms : null,
    deployedCommit,
    deployedAt,
    localCommit,
    localBranch: gitInfo.branch || null,
    unshipped: gitInfo.unshipped == null ? null : gitInfo.unshipped,
    dirty: gitInfo.dirty == null ? null : gitInfo.dirty,
    prodMatchesLocal,
    incidents: openIncidents,
    // The deployed host, so the UI never needs it hard-coded.
    host,
  };

  // -- nodes -----------------------------------------------------------------
  const ctx = { label, health, version, config, incidents, hj, reachable, now,
                host, healthUrl, urls, paths, baseUrl, stackRoot, localPort,
                timeoutMs, prodRef, git: gitInfo, files, dev, deployedCommit,
                byId: new Map() };

  const tierIds = new Set(profile.tiers.map(t => t.id));
  const nodes = [];
  const push = list => {
    for (const n of list) {
      if (!n || typeof n !== 'object' || typeof n.id !== 'string') {
        errors.push('malformed node dropped');
        continue;
      }
      if (!tierIds.has(n.tier)) {
        errors.push(`node ${n.id} dropped: tier "${n.tier}" is not in the profile's tiers`);
        continue;
      }
      if (ctx.byId.has(n.id)) { errors.push(`duplicate node id dropped: ${n.id}`); continue; }
      ctx.byId.set(n.id, n);
      nodes.push(n);
    }
  };

  // Builders run in order; a later one may read earlier states via ctx.byId.
  profile.builders.forEach((build, i) => {
    let list;
    try { list = build(ctx, helpers); }
    catch (err) { errors.push(`profile builder ${i + 1} failed: ${shortErr(err)}`); return; }
    if (Array.isArray(list)) push(list);
    else errors.push(`profile builder ${i + 1} returned no node list`);
  });

  // Incidents live in the summary rather than as a node, but a currently-open
  // one is worth an error line so the dashboard's error rail shows it.
  if (openIncidents != null && openIncidents > 0) {
    errors.push(`${label} status page reports ${openIncidents} open incident`
              + (openIncidents === 1 ? '' : 's'));
  }

  // -- edges, validated ------------------------------------------------------
  let rawEdges = [];
  if (typeof profile.edges === 'function') {
    try {
      const r = profile.edges(ctx, helpers);
      if (Array.isArray(r)) rawEdges = r;
      else errors.push('profile edges() returned no edge list');
    } catch (err) { errors.push(`profile edges() failed: ${shortErr(err)}`); }
  }
  const seen = new Set();
  const edges = [];
  for (const raw of rawEdges) {
    const e = Array.isArray(raw) ? edge(raw[0], raw[1], raw[2])
      : raw && typeof raw === 'object' ? edge(raw.from, raw.to, raw.kind) : null;
    if (!e) continue;
    const key = `${e.from}>${e.to}>${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!ctx.byId.has(e.from) || !ctx.byId.has(e.to)) {
      errors.push(`dangling edge dropped: ${e.from} -> ${e.to} (${e.kind})`);
      continue;
    }
    edges.push(e);
  }

  return {
    generatedAt: now.toISOString(),
    scanMs: Date.now() - t0,
    errors: errors.map(x => clamp(x, 200)),
    summary,
    tiers: profile.tiers.map(t => ({ id: t.id, label: t.label })),
    nodes,
    edges,
  };
}

/**
 * Everything a profile may use, passed as `h` to builders(), edges() and
 * scanFiles(). Profiles get their helpers here rather than by require(), so a
 * profile file can live anywhere on disk.
 */
const helpers = Object.freeze({
  DOT, LABEL_MAX, DETAIL_MAX, STATES, SOURCES, KINDS, DOW_NAMES, MON_NAMES,
  CRON_OK, DEFAULT_PATHS, HOME: os.homedir(),
  node, edge, scrub, clamp, scrubMeta, shortErr, isoOrNull, healthState,
  fmtUTC, spanText, relFromNow, relSince, withTimeout, nextCronFireUTC,
  getJson, cachedJson, git, statOrNull, newestIn, firstFile,
});

module.exports = { scanStack, helpers };

// Exported for this dashboard's own tests. NOT part of the contract above -
// nothing in the UI should depend on these.
module.exports._internals = {
  scrub, clamp, getJson, cachedJson, scanGit, scanDevServer, findListener,
  healthState, loadProfile, profileProblem, resolveScanOpts,
  REMOTE_TTL, DEFAULT_PATHS, DEFAULT_PROD_REF, KEEP_HEADERS,
};

// ===========================================================================
// CLI - `node lib/stack.js`
// JSON on stdout, human table on stderr. stderr stays pure ASCII because the
// dashboard server's stdout/stderr are redirected through a cp1252 console.
// ===========================================================================

if (require.main === module) {
  const GLYPH = { up: 'o', degraded: '!', down: 'x', armed: '^', idle: '.',
                  hold: 'H', disabled: '-', wired: '~', unknown: '?' };
  const name = resolveScanOpts({}).label.toLowerCase();
  scanStack().then(snap => {
    process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
    const err = s => process.stderr.write(s + '\n');
    const ascii = s => String(s).replace(/[^\x20-\x7e]/g, '-');
    const S = snap.summary;
    err('');
    err(`mission-control . ${ascii(name)} . ${snap.generatedAt} . ${snap.scanMs} ms`);
    err('');
    err(`   status ${S.status}   role ${S.role || '-'}`
      + `   http ${S.httpMs == null ? '-' : S.httpMs + ' ms'}`);
    err(`   prod ${S.deployedCommit || '-'}`
      + `   local ${S.localBranch || '-'}@${S.localCommit || '-'}`
      + `   match ${S.prodMatchesLocal === null ? '-' : S.prodMatchesLocal}`);
    err(`   unshipped ${S.unshipped == null ? '-' : S.unshipped}`
      + `   dirty ${S.dirty == null ? '-' : S.dirty}`
      + `   open incidents ${S.incidents == null ? '-' : S.incidents}`);
    for (const t of snap.tiers) {
      const rows = snap.nodes.filter(n => n.tier === t.id);
      err('');
      err(`-- ${t.label} (${t.id}) . ${rows.length} nodes`);
      for (const n of rows) {
        err(`   ${GLYPH[n.state] || '?'} ${n.state.padEnd(9)}`
          + `${ascii(n.label).padEnd(24)} ${ascii(n.detail)}`);
      }
    }
    err('');
    err(`-- ${snap.nodes.length} nodes . ${snap.edges.length} edges`);
    if (snap.errors.length) {
      err('');
      err(`-- errors (${snap.errors.length})`);
      for (const e of snap.errors) err(`   ! ${ascii(e)}`);
    }
    err('');
  }).catch(e => {
    // scanStack is designed never to reject; this exists only so a bug here
    // is loud rather than silent.
    process.stderr.write('scanStack rejected (this is a bug): '
                       + ((e && e.stack) || e) + '\n');
    process.exitCode = 1;
  });
}
