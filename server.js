'use strict';
/**
 * mission-control - local dashboard server.
 *
 * Zero npm dependencies. CommonJS. Node 20+.
 * Binds 127.0.0.1 ONLY: this surfaces local filesystem metadata and must never
 * be reachable from the network.
 *
 * Routes
 *   GET /              -> public/index.html (placeholder if not written yet)
 *   GET /<file>        -> static file inside public/ (traversal-safe, no-store)
 *   GET /api/agents    -> JSON  scanAgents(); ?session=<id> deep-scans one
 *                              session, ?session=all deep-scans everything,
 *                              ?older=1 includes sessions predating
 *                              data/config.json's `since`
 *   GET /api/infra     -> JSON  require('./lib/infra').scanInfra()   (25s cache)
 *   GET /api/stack     -> JSON  require('./lib/stack').scanStack()   (30s cache)
 *                              503 while lib/stack.js is not loaded
 *   GET /api/history   -> JSON  rolling time series from lib/history.js;
 *                              ?hours=1..168 (24) &maxPoints=50..2000 (720),
 *                              out of range is a 400
 *   GET /api/stream    -> SSE   agents @2s, infra + stack @30s, ping @15s;
 *                              ?session=<id> adds that session to the shared
 *                              deep-scan union
 *   GET /api/health    -> { ok, uptimeMs, port, agentsLib, infraLib, stackLib,
 *                           reloads, libs, history }
 *
 * Every scanner in LIBS below hot-reloads on save; a broken save keeps the
 * previously loaded module in service.
 *   *                  -> 404 JSON
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1';
const DEFAULT_PORT = 7373;
const HOST_RETRY_MS = 30000; // re-try a non-loopback bind this often

const AGENTS_INTERVAL_MS = 2000;   // SSE agents cadence
const INFRA_INTERVAL_MS = 30000;   // SSE infra + stack cadence
const PING_INTERVAL_MS = 15000;    // SSE keepalive
const AGENTS_MAX_QUIET_MS = 20000; // force an agents frame at least this often
const INFRA_CACHE_MS = 25000;      // /api/infra cache window
const STACK_CACHE_MS = 30000;      // /api/stack cache window

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// Same as num(), but 0 is a legal value rather than "unset". MC_MONITOR_MS=0
// has to mean "turn the idle monitor off", which num() would silently turn
// back into the default.
function numOrZero(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

const ACTIVE_WINDOW_MS = num(process.env.MC_ACTIVE_WINDOW_MS, 120000);
const INFRA_TIMEOUT_MS = num(process.env.MC_INFRA_TIMEOUT_MS, 8000);
const STACK_TIMEOUT_MS = num(process.env.MC_STACK_TIMEOUT_MS, 8000);
const SCAN_HARD_TIMEOUT_MS = num(process.env.MC_SCAN_TIMEOUT_MS, 20000);

const ROOT = __dirname;
const PUBLIC_DIR = path.resolve(ROOT, 'public');
const STARTED_AT = Date.now();

// history + the idle monitor that feeds it when no browser is attached
const HISTORY_FILE = process.env.MC_HISTORY_FILE || path.join(ROOT, 'data', 'history.json');
const HISTORY_OFF = process.env.MC_HISTORY_OFF === '1';
const MONITOR_MS = numOrZero(process.env.MC_MONITOR_MS, 60000);

const HISTORY_DEFAULT_HOURS = 24;
const HISTORY_MIN_HOURS = 1;
const HISTORY_MAX_HOURS = 168;      // 7 days, which is also the retention
const HISTORY_DEFAULT_POINTS = 720;
const HISTORY_MIN_POINTS = 50;
const HISTORY_MAX_POINTS = 2000;

function validPort(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error('[mission-control] invalid port "' + raw + '" - falling back to ' + DEFAULT_PORT);
    return DEFAULT_PORT;
  }
  return n;
}

function parsePort(argv, env) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1] != null) return validPort(argv[i + 1]);
    if (a.indexOf('--port=') === 0) return validPort(a.slice('--port='.length));
  }
  if (env.PORT) return validPort(env.PORT);
  return DEFAULT_PORT;
}

const PORT = parsePort(process.argv.slice(2), process.env);

/**
 * Which addresses to listen on: --host a,b / MC_HOST, comma separated.
 *
 * 127.0.0.1 is ALWAYS in the list, first, whether or not it was asked for.
 * Everything local depends on it - `dash`, the browser tab, start.ps1's
 * readiness probe, every curl in the README - and it is the only address the
 * token gate exempts. Dropping it because someone typed --host <tailscale-ip>
 * would silently lock the machine out of its own dashboard.
 */
function parseHosts(argv, env) {
  let raw = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host' && argv[i + 1] != null) { raw = argv[i + 1]; break; }
    if (a.indexOf('--host=') === 0) { raw = a.slice('--host='.length); break; }
  }
  if (raw === null && env.MC_HOST) raw = env.MC_HOST;

  const out = [];
  const seen = new Set();
  function add(h) {
    const v = String(h == null ? '' : h).trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  }
  add(HOST);
  if (raw) String(raw).split(',').forEach(add);
  return out;
}

const HOSTS = parseHosts(process.argv.slice(2), process.env);

// IPv6-mapped IPv4 included, and the whole 127.0.0.0/8 block rather than just
// 127.0.0.1: every one of those addresses is loopback by definition and can
// only be reached by something already on this machine.
const LOOPBACK_RE = /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLoopback(addr) {
  if (!addr) return false;
  const a = String(addr);
  return a === '::1' || LOOPBACK_RE.test(a);
}

// Used for the boot banner and the phone URL; IPv6 literals need brackets.
function urlHost(addr) {
  const a = String(addr);
  return a.indexOf(':') !== -1 && a.indexOf('[') !== 0 ? '[' + a + ']' : a;
}

const REMOTE_HOSTS = HOSTS.filter((h) => !isLoopback(h));

function ts() {
  return new Date().toTimeString().slice(0, 8);
}
function log() {
  const args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ['[' + ts() + ']'].concat(args));
}
function errmsg(err) {
  if (!err) return 'unknown error';
  return String((err && err.message) || err);
}

// ---------------------------------------------------------------------------
// lazy, defensive lib loading
//
// The scanners are written by other authors and may not exist yet. Never throw,
// never 500. Re-attempt the require on every use so the server picks a lib
// up the moment it lands on disk - no restart needed.
//
// THE SCANNER REGISTRY. Adding a scanner is one line here: it gets lazy
// loading, hot reload, an /api/health entry and a reload counter for free.
//   file     - basename inside lib/
//   export   - the function the module must export
//   onReload - optional; runs after a successful hot reload, for cache busting
//              (hoisted function declarations, defined with their scan section)
// ---------------------------------------------------------------------------

const LIBS = {
  agents: { file: 'agents.js', export: 'scanAgents' },
  infra: { file: 'infra.js', export: 'scanInfra', onReload: onInfraReloaded },
  stack: { file: 'stack.js', export: 'scanStack', onReload: onStackReloaded },
};

const LIB_NAMES = Object.keys(LIBS);

const libState = {};
for (const name of LIB_NAMES) {
  libState[name] = { fn: null, error: 'not loaded yet', announced: false, reloads: 0 };
}

function libFile(name) {
  return path.join(ROOT, 'lib', LIBS[name].file);
}

function loadLib(name) {
  const st = libState[name];
  if (st.fn) return st;

  const spec = LIBS[name];
  const exportName = spec.export;
  const file = libFile(name);
  const off = moduleOff(name);
  if (off) {
    // An optional module that data/config.json does not enable is never
    // required at all, so its probes cannot run by accident.
    st.fn = null;
    st.error = off;
    return st;
  }
  if (!fs.existsSync(file)) {
    st.fn = null;
    st.error = 'lib/' + spec.file + ' does not exist yet (waiting for it to be written)';
    return st;
  }
  try {
    // Node does not cache a module whose load threw, and never caches a
    // MODULE_NOT_FOUND, so a plain require() already acts as a retry.
    const mod = require(file);
    const fn = mod && mod[exportName];
    if (typeof fn !== 'function') {
      st.fn = null;
      st.error = 'lib/' + spec.file + ' loaded but does not export ' + exportName + '()';
      // A half-written file may now be cached with the wrong shape; drop it so
      // the next attempt re-reads from disk.
      try { delete require.cache[require.resolve(file)]; } catch (e) { /* noop */ }
      return st;
    }
    st.fn = fn;
    st.error = null;
    if (!st.announced) {
      st.announced = true;
      log('lib/' + spec.file + ' loaded (' + exportName + ')');
    }
    return st;
  } catch (err) {
    st.fn = null;
    st.error = 'lib/' + spec.file + ' failed to load: ' + errmsg(err);
    return st;
  }
}

// ---------------------------------------------------------------------------
// hot reload
//
// The scanner authors iterate on these files constantly, so a save should take
// effect without a restart. One fs.watch on lib/, debounced per file. A broken
// save must never take the dashboard down: if the new version throws on load,
// the previously loaded module stays in service.
// ---------------------------------------------------------------------------

// basename on disk -> registry name, e.g. 'agents.js' -> 'agents'.
const WATCHED_LIBS = {};
for (const name of LIB_NAMES) WATCHED_LIBS[LIBS[name].file] = name;

const RELOAD_DEBOUNCE_MS = 300;
const reloadTimers = new Map();
let libWatcher = null;
let watcherRetry = null;
let watcherRetryAnnounced = false;
let watcherWatchdog = null;

function reloadLib(name) {
  const st = libState[name];
  const spec = LIBS[name];
  const exportName = spec.export;
  const file = libFile(name);
  if (moduleOff(name)) return false; // disabled optional module: never load

  if (!fs.existsSync(file)) {
    // Deleted or mid-rename. Keep whatever is already in service. The
    // directory may have gone too, which kills the watcher silently on
    // Windows, so rebuild it rather than trusting it survived.
    log('lib/' + spec.file + ' is gone - keeping the loaded copy in service');
    rearmLibWatcher();
    return false;
  }

  let resolved = null;
  try {
    resolved = require.resolve(file);
  } catch (err) {
    resolved = null;
  }

  const previousFn = st.fn;
  const previousEntry = resolved ? require.cache[resolved] : undefined;
  if (resolved) delete require.cache[resolved];

  try {
    const mod = require(file);
    const fn = mod && mod[exportName];
    if (typeof fn !== 'function') {
      throw new Error('does not export ' + exportName + '()');
    }
    st.fn = fn;
    st.error = null;
    st.announced = true;
    st.reloads += 1;
    log('lib/' + spec.file + ' reloaded (v' + st.reloads + ')');
    return true;
  } catch (err) {
    // Put the working module back exactly as it was.
    if (resolved) {
      if (previousEntry) require.cache[resolved] = previousEntry;
      else delete require.cache[resolved];
    }
    st.fn = previousFn;
    if (previousFn) {
      log('lib/' + spec.file + ' reload FAILED: ' + errmsg(err) +
          ' - keeping v' + st.reloads + ' in service');
    } else {
      st.error = 'lib/' + spec.file + ' failed to load: ' + errmsg(err);
      log('lib/' + spec.file + ' reload FAILED: ' + errmsg(err) +
          ' - no working copy loaded');
    }
    return false;
  }
}

function applyReload(base) {
  const name = WATCHED_LIBS[base]; // 'agents.js' -> 'agents'
  if (!name || !reloadLib(name)) return;

  // New code is in service: let the next agents frame through even if the
  // payload is unchanged, so the authors can see their edit land. With no
  // clients attached there is nothing to force - the next one to connect
  // gets fresh data in its initial burst anyway.
  if (clients.size > 0) forceNextAgentsFrame = true;

  // Per-scanner cache busting, so the next read runs the new code rather than
  // replaying a snapshot the old version produced.
  const after = LIBS[name].onReload;
  if (typeof after === 'function') {
    try {
      after();
    } catch (err) {
      log('post-reload hook for ' + base + ' threw:', errmsg(err));
    }
  }
}

function scheduleReload(base) {
  // fs.watch fires twice per save on Windows; the debounce collapses that.
  const pending = reloadTimers.get(base);
  if (pending) clearTimeout(pending);
  const t = setTimeout(() => {
    reloadTimers.delete(base);
    try {
      applyReload(base);
    } catch (err) {
      log('reload of ' + base + ' threw:', errmsg(err));
    }
  }, RELOAD_DEBOUNCE_MS);
  if (t.unref) t.unref();
  reloadTimers.set(base, t);
}

function startLibWatcher() {
  if (watcherRetry) {
    clearTimeout(watcherRetry);
    watcherRetry = null;
  }
  const dir = path.join(ROOT, 'lib');

  const retry = (why, ms) => {
    if (!watcherRetryAnnounced) {
      watcherRetryAnnounced = true;
      log('hot reload: ' + why + ' - will keep retrying every ' + ms + 'ms');
    }
    watcherRetry = setTimeout(startLibWatcher, ms);
    if (watcherRetry.unref) watcherRetry.unref();
  };

  if (!fs.existsSync(dir)) return retry('lib/ does not exist yet', 2000);

  try {
    libWatcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
      try {
        if (!filename) return;
        const base = path.basename(String(filename));
        if (!Object.prototype.hasOwnProperty.call(WATCHED_LIBS, base)) return;
        scheduleReload(base);
      } catch (err) {
        log('lib/ watch callback threw:', errmsg(err));
      }
    });
  } catch (err) {
    return retry('could not watch lib/ (' + errmsg(err) + ')', 2000);
  }

  // A directory rename/delete surfaces here on Windows; rebuild the watcher.
  libWatcher.on('error', (err) => {
    log('lib/ watcher error: ' + errmsg(err));
    try { libWatcher.close(); } catch (e) { /* already dead */ }
    libWatcher = null;
    retry('watcher died', 1000);
  });

  watcherRetryAnnounced = false;
  log('hot reload armed: watching lib/ for changes');
  startWatcherWatchdog();
}

// Close the current watcher and build a fresh one. fs.watch keeps a handle
// on the directory inode, so once lib/ is deleted the old watcher goes quiet
// forever without ever emitting an error - only a rebuild recovers.
function rearmLibWatcher() {
  if (libWatcher) {
    try { libWatcher.close(); } catch (err) { /* already dead */ }
    libWatcher = null;
  }
  startLibWatcher();
}

// Backstop: catches a watcher that died without saying so.
function startWatcherWatchdog() {
  if (watcherWatchdog) return;
  watcherWatchdog = setInterval(() => {
    try {
      const dir = path.join(ROOT, 'lib');
      if (!fs.existsSync(dir)) {
        if (libWatcher) {
          try { libWatcher.close(); } catch (err) { /* already dead */ }
          libWatcher = null;
        }
        return; // wait for it to come back
      }
      if (!libWatcher && !watcherRetry) startLibWatcher();
    } catch (err) {
      // a watchdog that throws is worse than no watchdog
    }
  }, 5000);
  if (watcherWatchdog.unref) watcherWatchdog.unref();
}

function stopLibWatcher() {
  if (watcherWatchdog) { clearInterval(watcherWatchdog); watcherWatchdog = null; }
  if (watcherRetry) { clearTimeout(watcherRetry); watcherRetry = null; }
  for (const t of reloadTimers.values()) clearTimeout(t);
  reloadTimers.clear();
  if (libWatcher) {
    try { libWatcher.close(); } catch (err) { /* already closed */ }
    libWatcher = null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function emptyAgents(errors, scanMs) {
  return { generatedAt: nowIso(), scanMs: scanMs || 0, errors: errors || [], sessions: [] };
}
function emptyInfra(errors, scanMs) {
  return { generatedAt: nowIso(), scanMs: scanMs || 0, errors: errors || [], groups: [] };
}
function emptyStack(errors, scanMs) {
  return {
    generatedAt: nowIso(),
    scanMs: scanMs || 0,
    errors: errors || [],
    summary: null,
    tiers: [],
    nodes: [],
    edges: [],
  };
}

// Guarantee the UI always receives a correctly shaped snapshot, even if a lib
// returns something odd.
function normalize(snap, key, scanMs, empty) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
    return empty(['scan returned ' + (Array.isArray(snap) ? 'an array' : typeof snap) + ', expected an object'], scanMs);
  }
  const errors = Array.isArray(snap.errors) ? snap.errors.map(String) : [];
  let list = snap[key];
  if (!Array.isArray(list)) {
    errors.push('scan returned no "' + key + '" array');
    list = [];
  }
  // Unknown top-level keys pass through rather than being dropped, exactly as
  // normalizeStack() does. These contracts are still moving - lib/agents.js
  // grew its `filter` block this way - and a rebuilt-from-scratch object
  // silently swallows any field the scanner has just started emitting, which
  // is a miserable bug to chase. Only the contract fields are validated.
  const out = Object.assign({}, snap);
  out.generatedAt = typeof snap.generatedAt === 'string' ? snap.generatedAt : nowIso();
  out.scanMs = Number.isFinite(snap.scanMs) ? snap.scanMs : scanMs;
  out.errors = errors;
  out[key] = list;
  return out;
}

/**
 * Stack carries three parallel arrays plus a summary object, so the generic
 * single-list normalize() above does not fit.
 *
 * Unknown top-level keys are passed through rather than dropped: this contract
 * is new and still moving, and the UI is being written against it in parallel.
 * Silently swallowing a field the scanner just started emitting would be a
 * miserable bug to chase. Only the seven contract fields are validated.
 */
const STACK_LISTS = ['tiers', 'nodes', 'edges'];

function normalizeStack(snap, scanMs) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
    return emptyStack(['scan returned ' + (Array.isArray(snap) ? 'an array' : typeof snap) + ', expected an object'], scanMs);
  }
  const errors = Array.isArray(snap.errors) ? snap.errors.map(String) : [];
  const out = Object.assign({}, snap);
  out.generatedAt = typeof snap.generatedAt === 'string' ? snap.generatedAt : nowIso();
  out.scanMs = Number.isFinite(snap.scanMs) ? snap.scanMs : scanMs;
  out.summary = (snap.summary && typeof snap.summary === 'object' && !Array.isArray(snap.summary))
    ? snap.summary
    : null;
  for (let i = 0; i < STACK_LISTS.length; i++) {
    const key = STACK_LISTS[i];
    if (Array.isArray(snap[key])) {
      out[key] = snap[key];
    } else {
      errors.push('scan returned no "' + key + '" array');
      out[key] = [];
    }
  }
  out.errors = errors; // assigned last: the list checks above append to it
  return out;
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, guard]).then(
    (v) => { clearTimeout(timer); return v; },
    (e) => { clearTimeout(timer); throw e; }
  );
}

// ---------------------------------------------------------------------------
// deep-scan selection
//
// scanAgents({ activeWindowMs, deep }) with deep: 'all' | 'active' | string[].
// Sessions that are not deep-scanned come back with agents: [] and
// shallow: true; that is what keeps an SSE agents frame small. Default is
// 'active', so only sessions with recent activity carry their agent list.
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[0-9a-f-]{8,64}$/;

const BAD_SESSION = {
  error: 'bad_request',
  detail: 'invalid session parameter',
  expected: "a session id matching [0-9a-f-]{8,64}, or the literal 'all'",
};

// Returns { ok, value } where value is null (absent), 'all', or a session id.
function validSessionParam(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  if (raw === 'all') return { ok: true, value: 'all' };
  if (SESSION_ID_RE.test(raw)) return { ok: true, value: raw };
  return { ok: false, value: null };
}

// A session param as it arrives on a request -> a deep selector.
function paramToSelector(value) {
  if (value === null) return 'active';
  if (value === 'all') return 'all';
  return [value];
}

// Stable identity for a selector, used to key the single-flight map and to
// force a fresh frame when the deep set changes.
function selectorKey(sel) {
  if (sel === 'all' || sel === 'active') return sel;
  return 'deep:' + sel.join(',');
}

// Compact human form for the frame log line.
function selectorLabel(sel) {
  if (sel === 'all' || sel === 'active') return sel;
  if (sel.length === 0) return '[]';
  // ASCII "..." on purpose: the hidden-window stdout redirect writes cp1252,
  // which turns a Unicode ellipsis into mojibake in server.log.
  const shown = sel.slice(0, 3).map((id) => id.slice(0, 8) + '...');
  const extra = sel.length > 3 ? ',+' + (sel.length - 3) + ' more' : '';
  return '[' + shown.join(',') + extra + ']';
}

// ---------------------------------------------------------------------------
// session history window
//
// data/config.json pins the dashboard to the session that built it:
//   { "since": "<ISO timestamp>", "sinceSession": "<session id>" }
// A session that started before `since` is hidden unless the caller asks for
// it with ?older=1, so the left panel opens on today's work instead of on a
// year of history. `sinceSession` is never hidden whatever its start time - it
// is the session that owns this dashboard.
//
// A missing, unreadable or malformed file means NO filter: every session is
// shown, and the reason is said once. This is a display preference, not a
// security control, so getting it wrong must cost tidiness and never data.
//
// Polled, not watched. It changes about once a year; data/ is rewritten every
// 60s by the history flush, so a watch there would fire constantly for the
// wrong file; and a poll has no watcher lifecycle to get wrong on Windows.
// An unchanged mtime/size skips the parse entirely.
// ---------------------------------------------------------------------------

const CONFIG_FILE = process.env.MC_CONFIG_FILE || path.join(ROOT, 'data', 'config.json');
const CONFIG_POLL_MS = 60000;

// Optional modules + per-machine settings (lib/modules.js), read ONCE at boot
// from the same file: they wire up routes and timers, so a change needs a
// restart. Everything optional is off unless data/config.json turns it on.
const MODULES = (function readModules() {
  try {
    return require(path.join(ROOT, 'lib', 'modules.js')).loadModules(CONFIG_FILE).modules;
  } catch (err) {
    return {
      stack: { enabled: false, reason: 'lib/modules.js failed: ' + errmsg(err), scan: null, infra: null },
      watchedTasks: [],
    };
  }
})();

/** Non-null reason string when `name` is an optional module that is off. */
function moduleOff(name) {
  if (name !== 'stack') return null;
  return MODULES.stack.enabled ? null : 'stack module disabled: ' + MODULES.stack.reason;
}

const NO_FILTER = { since: null, sinceSession: null, sinceMs: null };

let sessionFilter = NO_FILTER;
let configError = null;
let configStamp = '';     // mtime:size - an unchanged file is never re-parsed
let configAnnounced = ''; // last line logged, so a steady state logs once

function announceConfig(msg) {
  if (msg === configAnnounced) return;
  configAnnounced = msg;
  log(msg);
}

/**
 * Printable ASCII only, for log lines built out of file content.
 *
 * A JSON parse error quotes the offending text straight back at you, so a
 * config file saved with a UTF-8 BOM puts those three bytes into the message.
 * server.log is written through a cp1252 pipe and would show them as mojibake,
 * so they are flattened here. The untouched message still goes to /api/health,
 * which is UTF-8 and can carry it.
 */
function asciiOnly(s) {
  return String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, '?');
}

function loadConfig() {
  try {
    let st = null;
    try { st = fs.statSync(CONFIG_FILE); } catch (err) { st = null; }

    if (!st || !st.isFile()) {
      configStamp = '';
      configError = null;
      sessionFilter = NO_FILTER;
      announceConfig('config: no data/config.json - every session is shown');
      return;
    }

    const stamp = String(st.mtimeMs) + ':' + String(st.size);
    if (stamp === configStamp) return; // untouched since the last read
    configStamp = stamp;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      configError = errmsg(err);
      sessionFilter = NO_FILTER;
      announceConfig('config: data/config.json unreadable (' + asciiOnly(configError) + ') - every session is shown');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      configError = 'not a JSON object';
      sessionFilter = NO_FILTER;
      announceConfig('config: data/config.json is ' + configError + ' - every session is shown');
      return;
    }

    const since = typeof parsed.since === 'string' ? parsed.since : null;
    const sinceMs = since === null ? NaN : Date.parse(since);
    const sinceSession =
      typeof parsed.sinceSession === 'string' && SESSION_ID_RE.test(parsed.sinceSession)
        ? parsed.sinceSession
        : null;

    if (!Number.isFinite(sinceMs)) {
      configError = since === null ? 'no "since" field' : 'unparseable "since"';
      // Keep sinceSession even so: it is still the session that owns this
      // dashboard, and the UI may want to mark it.
      sessionFilter = { since: null, sinceSession: sinceSession, sinceMs: null };
      announceConfig('config: ' + configError + ' in data/config.json - every session is shown');
      return;
    }

    configError = null;
    sessionFilter = { since: since, sinceSession: sinceSession, sinceMs: sinceMs };
    announceConfig('config: hiding sessions started before ' + since +
                   (sinceSession ? ' (always keeping ' + sinceSession.slice(0, 8) + ')' : ''));
  } catch (err) {
    // A config poll that throws must never take the dashboard with it.
    log('config: reload failed:', asciiOnly(errmsg(err)));
  }
}

function startConfigPoll() {
  loadConfig();
  const t = setInterval(loadConfig, CONFIG_POLL_MS);
  if (t.unref) t.unref();
}

function filterActive() {
  return sessionFilter.sinceMs !== null;
}

// ?older=1, and nothing else. An unrecognised value is ignored rather than
// rejected: this is a view preference, and 400ing a dashboard URL over it
// would be obnoxious.
function wantsOlderParam(raw) {
  return raw === '1';
}

/**
 * Keep this session in the trimmed view?
 *
 * Anything at or after the cutoff, plus the pinned session, plus anything a
 * caller explicitly asked for by id. A session whose startedAt is missing or
 * unparseable is KEPT: hiding a session because its timestamp could not be
 * read would be silent data loss dressed up as tidiness.
 */
function keepSession(s, keepIds) {
  if (!s) return false;
  const id = s.sessionId;
  if (id && id === sessionFilter.sinceSession) return true;
  if (id && keepIds && keepIds.has(id)) return true;
  const started = Date.parse(s.startedAt);
  if (!Number.isFinite(started)) return true;
  return started >= sessionFilter.sinceMs;
}

/**
 * A trimmed COPY of a snapshot, for callers that did not ask for older
 * sessions.
 *
 * Applied unconditionally on the non-older path, which makes the result
 * correct whether lib/agents.js did the filtering itself, did none of it, or
 * was handed includeOlder:true because some OTHER client needed the full set.
 * Its own hidden count is added to rather than overwritten, so the total is
 * right in all three of those worlds.
 */
function applySessionFilter(snap, keepIds) {
  if (!filterActive()) return snap;
  const all = snap.sessions || [];
  const kept = [];
  for (let i = 0; i < all.length; i++) {
    if (keepSession(all[i], keepIds)) kept.push(all[i]);
  }
  const prior = snap.filter && Number.isFinite(snap.filter.hidden) ? snap.filter.hidden : 0;
  const out = Object.assign({}, snap);
  out.sessions = kept;
  out.filter = {
    since: sessionFilter.since,
    sinceSession: sessionFilter.sinceSession,
    includeOlder: false,
    hidden: prior + (all.length - kept.length),
  };
  return out;
}

// The older=1 view. Stamped rather than passed through so the client always
// gets a filter block, and so hidden is 0 by construction - which is the
// truth, because nothing was hidden.
function markIncludeOlder(snap) {
  if (!filterActive()) return snap;
  const out = Object.assign({}, snap);
  out.filter = {
    since: sessionFilter.since,
    sinceSession: sessionFilter.sinceSession,
    includeOlder: true,
    hidden: 0,
  };
  return out;
}

// ---------------------------------------------------------------------------
// scans (single-flight per selector, so N browser tabs cost one scan)
// ---------------------------------------------------------------------------

const agentsInFlight = new Map(); // selectorKey -> Promise<snapshot>
let lastAgentsSnapshot = null;
let deepSupportLogged = false;
let infraInFlight = null;
let infraCache = { at: 0, snap: null };
let stackInFlight = null;
let stackCache = { at: 0, snap: null };
let stackMissingLogged = false;

// The lib may not have shipped the `deep` option yet. If it ignores it, no
// session carries a `shallow` flag - say so once instead of quietly serving
// full-size payloads and calling it a win.
function noteDeepSupport(snap) {
  if (deepSupportLogged) return;
  const sessions = snap.sessions || [];
  if (sessions.length === 0) return;
  deepSupportLogged = true;
  const supported = sessions.some((s) => s && typeof s.shallow === 'boolean');
  if (supported) {
    log('lib/agents.js honours the deep option (shallow flags present)');
  } else {
    log('NOTE: lib/agents.js ignored the deep option - no shallow flag on any ' +
        'session, so agents payloads stay full size');
  }
}

async function runAgentsScan(sel, includeOlder) {
  const t0 = Date.now();
  const st = loadLib('agents');
  if (!st.fn) return emptyAgents([st.error], Date.now() - t0);
  try {
    const snap = await withTimeout(
      Promise.resolve(st.fn({
        activeWindowMs: ACTIVE_WINDOW_MS,
        deep: sel,
        // A lib that has not shipped the window yet ignores these three and
        // returns everything; applySessionFilter() then does the trimming
        // server-side, so the behaviour is identical either way.
        since: sessionFilter.since,
        sinceSession: sessionFilter.sinceSession,
        includeOlder: Boolean(includeOlder),
      })),
      SCAN_HARD_TIMEOUT_MS,
      'scanAgents()'
    );
    const out = normalize(snap, 'sessions', Date.now() - t0, emptyAgents);
    noteDeepSupport(out);
    lastAgentsSnapshot = out;
    // Only the real thing gets recorded - the empty snapshot returned when the
    // lib is missing would write a run of honest-looking zeroes. The 10s
    // sampling that keeps 2s frames out of the file lives in the lib.
    recordHistory('agents', out);
    return out;
  } catch (err) {
    log('scanAgents() failed:', errmsg(err));
    return emptyAgents(['scanAgents() failed: ' + errmsg(err)], Date.now() - t0);
  }
}

// includeOlder is part of the single-flight identity: the two scans return
// different session sets, so a caller that needs the full one must never be
// handed a trimmed scan that happened to already be running.
function agentsKey(sel, includeOlder) {
  return selectorKey(sel) + (includeOlder ? '|older' : '');
}

function scanAgents(sel, includeOlder) {
  const selector = sel || 'active';
  const older = Boolean(includeOlder);
  const key = agentsKey(selector, older);
  const existing = agentsInFlight.get(key);
  if (existing) return existing; // identical request already running - join it

  const p = runAgentsScan(selector, older).then(
    (v) => { agentsInFlight.delete(key); return v; },
    (e) => { agentsInFlight.delete(key); return emptyAgents(['agents scan crashed: ' + errmsg(e)], 0); }
  );
  agentsInFlight.set(key, p);
  return p;
}

/**
 * One scan serves every connected SSE client: the union of what they asked for.
 *
 * The contract cannot express "active plus these ids", so when specific ids are
 * requested the active set is resolved from the previous snapshot - shallow
 * sessions still carry isActive - and merged in. With no snapshot to work from
 * yet, fall back to 'all' for that single scan rather than starving a client
 * of the running work it expects to see.
 */
function unionDeepSelector() {
  let wantsAll = false;
  const ids = new Set();
  for (const c of clients) {
    if (c.deepId === 'all') wantsAll = true;
    else if (c.deepId) ids.add(c.deepId);
  }
  if (wantsAll) return 'all';
  if (ids.size === 0) return 'active';
  // The requested ids go straight through: the lib already unions them with
  // every active session and the newest-by-transcript one, so there is no
  // cold-start gap to paper over. Widening to 'all' here cost a 642 KB
  // opening frame. Merging the previous snapshot active ids is harmless
  // belt-and-braces when we happen to have a snapshot.
  if (lastAgentsSnapshot) {
    for (const s of lastAgentsSnapshot.sessions) {
      if (s && s.isActive && s.sessionId) ids.add(s.sessionId);
    }
  }
  return Array.from(ids).sort();
}

async function runInfraScan() {
  const t0 = Date.now();
  const st = loadLib('infra');
  if (!st.fn) return emptyInfra([st.error], Date.now() - t0);
  try {
    const snap = await withTimeout(
      Promise.resolve(st.fn({
        timeoutMs: INFRA_TIMEOUT_MS,
        // null = the stack module is off: lib/infra.js builds generic rows only
        projects: MODULES.stack.enabled ? MODULES.stack.infra : null,
        watchedTasks: MODULES.watchedTasks,
      })),
      Math.max(SCAN_HARD_TIMEOUT_MS, INFRA_TIMEOUT_MS + 5000),
      'scanInfra()'
    );
    return normalize(snap, 'groups', Date.now() - t0, emptyInfra);
  } catch (err) {
    log('scanInfra() failed:', errmsg(err));
    return emptyInfra(['scanInfra() failed: ' + errmsg(err)], Date.now() - t0);
  }
}

// Cached for INFRA_CACHE_MS so a manual refresh does not re-shell PowerShell.
function scanInfra(opts) {
  const force = Boolean(opts && opts.force);
  const fresh = infraCache.snap && Date.now() - infraCache.at < INFRA_CACHE_MS;
  if (!force && fresh) return Promise.resolve(infraCache.snap);
  if (infraInFlight) return infraInFlight;

  const p = runInfraScan();
  infraInFlight = p.then(
    (v) => {
      infraInFlight = null;
      infraCache = { at: Date.now(), snap: v };
      // Fresh scan only. Every cache hit returns above without reaching here,
      // so N callers sharing one snapshot record exactly one point.
      recordHistory('infra', v);
      return v;
    },
    (e) => {
      infraInFlight = null;
      return emptyInfra(['infra scan crashed: ' + errmsg(e)], 0);
    }
  );
  return infraInFlight;
}

// Reload hook for lib/infra.js (referenced by LIBS; hoisted on purpose).
function onInfraReloaded() {
  infraCache = { at: 0, snap: null }; // next read re-runs the new probes
  if (clients.size > 0) {
    tickInfra().catch((err) => log('post-reload infra tick failed:', errmsg(err)));
  }
}

// ---------------------------------------------------------------------------
// stack
//
// Network-bound: every call reaches out to the deployed origin, so it is cached for
// STACK_CACHE_MS and single-flighted. scanStack() is documented never to
// reject, but this code does not take that on trust.
// ---------------------------------------------------------------------------

async function runStackScan() {
  const t0 = Date.now();
  const st = loadLib('stack');
  if (!st.fn) return emptyStack([st.error], Date.now() - t0);
  try {
    const snap = await withTimeout(
      Promise.resolve(st.fn(Object.assign({ timeoutMs: STACK_TIMEOUT_MS }, MODULES.stack.scan))),
      Math.max(SCAN_HARD_TIMEOUT_MS, STACK_TIMEOUT_MS + 5000),
      'scanStack()'
    );
    return normalizeStack(snap, Date.now() - t0);
  } catch (err) {
    log('scanStack() failed:', errmsg(err));
    return emptyStack(['scanStack() failed: ' + errmsg(err)], Date.now() - t0);
  }
}

function scanStack(opts) {
  const force = Boolean(opts && opts.force);
  const fresh = stackCache.snap && Date.now() - stackCache.at < STACK_CACHE_MS;
  if (!force && fresh) return Promise.resolve(stackCache.snap);
  if (stackInFlight) return stackInFlight; // force still joins a running scan

  const p = runStackScan();
  stackInFlight = p.then(
    (v) => {
      stackInFlight = null;
      stackCache = { at: Date.now(), snap: v };
      // Fresh scan only, same as infra: the cache hit and the single-flight
      // join both return above without recording.
      recordHistory('stack', v);
      return v;
    },
    (e) => {
      stackInFlight = null;
      return emptyStack(['stack scan crashed: ' + errmsg(e)], 0);
    }
  );
  return stackInFlight;
}

// Reload hook for lib/stack.js (referenced by LIBS; hoisted on purpose).
function onStackReloaded() {
  stackCache = { at: 0, snap: null }; // next read re-runs the new probes
  stackMissingLogged = false;
  if (clients.size > 0) {
    tickStack().catch((err) => log('post-reload stack tick failed:', errmsg(err)));
  }
}

/**
 * True once lib/stack.js is loadable.
 *
 * While it is missing there is nothing useful to send - the UI falls back to
 * its own fixture - so the stream simply says nothing about stack. Say why
 * once, not once every 30 seconds; re-arm on success so a lib that later
 * disappears is reported again.
 */
function stackLibReady() {
  const st = loadLib('stack');
  if (st.fn) {
    stackMissingLogged = false;
    return true;
  }
  if (!stackMissingLogged) {
    stackMissingLogged = true;
    log('stack frames disabled: ' + st.error);
  }
  return false;
}

// ---------------------------------------------------------------------------
// history
//
// lib/history.js keeps a rolling time series of what the scanners saw, so the
// UI can draw the last day instead of only the last instant.
//
// It is deliberately NOT in the LIBS registry. The scanners there are pure
// functions and can be swapped under the server for free; this one owns state
// - an in-memory ring plus a file on disk - and a hot reload would throw away
// every point that has not been flushed yet. Editing it needs a restart.
//
// Recording happens inside the *fresh-scan* continuations of scanInfra(),
// scanStack() and runAgentsScan(), never in a route handler or a tick. That is
// what stops a snapshot handed out of the 25s/30s cache to a second caller
// from being recorded twice. (lib/history.js drops any point whose t is not
// newer than the series' last t as well, so the guarantee holds from both
// ends, but not calling record() for a cache hit is the honest fix.)
// ---------------------------------------------------------------------------

let history = null;
let historyError = null;

function initHistory() {
  if (HISTORY_OFF) {
    historyError = 'recording disabled by MC_HISTORY_OFF=1';
    log('history: ' + historyError + ' (/api/history still answers, empty)');
    return;
  }
  try {
    const mod = require(path.join(ROOT, 'lib', 'history.js'));
    if (!mod || typeof mod.createHistory !== 'function') {
      throw new Error('lib/history.js does not export createHistory()');
    }
    history = mod.createHistory({ file: HISTORY_FILE, log: log });
    historyError = null;
    const st = history.stats();
    log('history: ' + HISTORY_FILE + ' (' + st.points + ' points loaded)');
  } catch (err) {
    history = null;
    historyError = errmsg(err);
    log('history disabled: ' + historyError);
  }
}

// A recorder bug must never take a scan down with it: the snapshot the UI is
// waiting for matters more than the point.
function recordHistory(kind, snap) {
  if (!history) return;
  try {
    history.record(kind, snap);
  } catch (err) {
    log('history record(' + kind + ') failed:', errmsg(err));
  }
}

// Cheap enough to call on every /api/health.
function historySummary() {
  const out = { points: 0, file: HISTORY_FILE, lastFlushAt: null, bytes: null, error: historyError };
  if (history) {
    try {
      const st = history.stats();
      out.points = st.points;
      out.file = st.file;
      out.lastFlushAt = st.lastFlushAt;
      out.bytes = st.bytes;
    } catch (err) {
      out.error = errmsg(err);
    }
  }
  out.monitor = { everyMs: MONITOR_MS, active: Boolean(monitorTimer) };
  return out;
}

// What /api/history answers with when nothing is recording. The UI gets a
// correctly shaped, empty snapshot rather than an error case to special-case.
function emptyHistoryResult(hours, now) {
  const until = Number.isFinite(now) ? now : Date.now();
  return {
    generatedAt: new Date(until).toISOString(),
    since: until - hours * 3600000,
    until: until,
    hours: hours,
    series: { stack: [], services: {}, agents: [] },
    stats: {
      stack: { samples: 0, uptimePct: null, p50Ms: null, p95Ms: null, worst: null, incidents: [] },
      services: {},
      agents: { samples: 0, peakRunning: 0, peakAt: null },
    },
    disabled: true,
    error: historyError,
  };
}

/**
 * A numeric query parameter with an inclusive range.
 *
 * Absent or empty -> the default. Anything non-numeric, or outside the range,
 * is { ok: false } so the route can 400: silently clamping ?hours=999 down to
 * 168 would hand back a window nobody asked for and look like a data bug at
 * the other end.
 */
function validRange(raw, dflt, min, max) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: dflt };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return { ok: false, value: dflt };
  return { ok: true, value: n };
}

function flushHistory(why) {
  if (!history) return;
  try {
    if (history.flush(true)) log('history flushed (' + why + ')');
  } catch (err) {
    log('history flush failed (' + why + '):', errmsg(err));
  }
}

// Shutdown path: flush, stop the timer, and stop accepting points so a scan
// still in flight cannot dirty the store again after the final write.
function closeHistory(why) {
  if (!history) return;
  const h = history;
  history = null;
  try {
    h.close();
    log('history flushed and closed (' + why + ')');
  } catch (err) {
    log('history close failed (' + why + '):', errmsg(err));
  }
}

// ---------------------------------------------------------------------------
// SSE - ONE scan loop for the whole process, refcounted by connected clients
// ---------------------------------------------------------------------------

const clients = new Set();
let timers = null;
let lastAgentsSig = null;
let lastAgentsSentAt = 0;
let clientSeq = 0;
let forceNextAgentsFrame = false; // set by a hot reload, cleared on the next send

/**
 * Dedupe key for agents frames.
 *
 * generatedAt/scanMs and the per-agent ageMs/idleMs counters change on every
 * single scan, so a literal byte compare of the payload would never match and
 * the "quiet" optimisation would never fire. Compare everything that carries
 * meaning instead; the client re-derives age from spawnedAt/lastActivityAt,
 * and the 20s floor still proves the stream is alive.
 *
 * The deep-selector key is part of the signature: when a client connects
 * asking for a session nobody had requested, the union changes and the next
 * tick must broadcast immediately rather than sit in the quiet window for up
 * to 20s while that client waits for its data.
 */
function agentsSignature(snap, selKey) {
  try {
    const sessions = (snap.sessions || []).map((s) => [
      s.sessionId, s.projectSlug, s.cwd, s.startedAt, s.lastActivityAt,
      s.isActive, s.agentCount, s.runningCount, s.maxDepth, s.shallow,
      (s.agents || []).map((a) => [
        a.id, a.agentType, a.description, a.model, a.spawnDepth, a.parentId,
        a.toolUseId, a.spawnedAt, a.lastActivityAt, a.status, a.lines, a.bytes,
        a.lastTool, a.lastText,
      ]),
    ]);
    return JSON.stringify([selKey || '', sessions, snap.errors || []]);
  } catch (err) {
    return null; // unserialisable -> always send
  }
}

function logAgentsFrame(data, sel, scanMs, suffix) {
  const kb = (Buffer.byteLength(data) / 1024).toFixed(1);
  log('agents frame ' + kb + ' KB  deep=' + selectorLabel(sel) +
      '  scan ' + (Number.isFinite(scanMs) ? scanMs : '?') + 'ms' +
      '  clients=' + clients.size + (suffix || ''));
}

function logStackFrame(data, scanMs, suffix) {
  const kb = (Buffer.byteLength(data) / 1024).toFixed(1);
  log('stack frame ' + kb + ' KB' +
      '  scan ' + (Number.isFinite(scanMs) ? scanMs : '?') + 'ms' +
      '  clients=' + clients.size + (suffix || ''));
}

function frame(event, data) {
  return 'event: ' + event + '\ndata: ' + data + '\n\n';
}

function sseWrite(client, event, data) {
  if (client.closed) return false;
  const res = client.res;
  if (!res || res.writableEnded || res.destroyed || (res.socket && res.socket.destroyed)) {
    dropClient(client);
    return false;
  }
  try {
    res.write(frame(event, data));
    return true;
  } catch (err) {
    log('sse write failed for client #' + client.id + ':', errmsg(err));
    dropClient(client);
    return false;
  }
}

function broadcast(event, data) {
  const list = Array.from(clients);
  for (let i = 0; i < list.length; i++) sseWrite(list[i], event, data);
}

function dropClient(client) {
  if (client.closed) return;
  client.closed = true;
  clients.delete(client);
  try { client.res.end(); } catch (err) { /* already gone */ }
  log('sse client #' + client.id + ' disconnected (' + clients.size + ' left)');
  if (clients.size === 0) stopLoop();
}

// Every session id a connected client named explicitly. They are pinned into
// the trimmed variant too, so browsing back to an old session by id keeps
// working without also having to pass older=1.
function unionKeepIds() {
  const ids = new Set();
  for (const c of clients) {
    if (c.deepId && c.deepId !== 'all') ids.add(c.deepId);
  }
  return ids;
}

function anyClientWantsOlder() {
  for (const c of clients) if (c.older) return true;
  return false;
}

/**
 * Does the scan have to fetch every session?
 *
 * Yes when somebody asked for older, and yes when somebody named a session id
 * that may itself predate the cutoff - otherwise the lib would filter that
 * session out from under the client that asked for it by name.
 */
function needFullScan(wantsOlder, keepIds) {
  return wantsOlder || (filterActive() && keepIds.size > 0);
}

// The scan identity a frame was built from. A client connecting with older=1
// changes it, which forces the next frame out rather than letting it sit in
// the 20s quiet window while that client waits.
function agentsVariantKey(sel, wantsOlder, keepIds) {
  return selectorKey(sel) + '|older:' + (wantsOlder ? 1 : 0) +
         '|keep:' + Array.from(keepIds).sort().join(',');
}

function agentsJson(snap) {
  try {
    return JSON.stringify(snap);
  } catch (err) {
    return JSON.stringify(emptyAgents(['snapshot not serialisable: ' + errmsg(err)], 0));
  }
}

function hiddenOf(snap) {
  const f = snap && snap.filter;
  return f && Number.isFinite(f.hidden) ? f.hidden : 0;
}

async function tickAgents() {
  if (clients.size === 0) return;
  // ONE scan for everybody: the union of every connected client's request.
  const sel = unionDeepSelector();
  const keepIds = unionKeepIds();
  const wantsOlder = anyClientWantsOlder();
  const needFull = needFullScan(wantsOlder, keepIds);

  let snap;
  try {
    snap = await scanAgents(sel, needFull);
  } catch (err) {
    log('agents tick error:', errmsg(err)); // the loop must survive a bad scan
    return;
  }
  if (clients.size === 0) return;

  const sig = agentsSignature(snap, agentsVariantKey(sel, wantsOlder, keepIds));
  const quietFor = Date.now() - lastAgentsSentAt;
  const changed = sig === null || sig !== lastAgentsSig;
  const forced = forceNextAgentsFrame; // a lib reload always gets one frame out
  if (!changed && !forced && quietFor < AGENTS_MAX_QUIET_MS) return;
  forceNextAgentsFrame = false;

  // AT MOST TWO serialisations per frame, both derived from that one scan:
  // the full snapshot for clients that asked for older sessions, and a single
  // trimmed copy shared by everyone else.
  const trimmed = applySessionFilter(snap, keepIds);
  const trimmedData = agentsJson(trimmed);
  const fullData = wantsOlder ? agentsJson(markIncludeOlder(snap)) : null;

  lastAgentsSig = sig;
  lastAgentsSentAt = Date.now();

  if (!wantsOlder) {
    broadcast('agents', trimmedData);
    logAgentsFrame(trimmedData, sel, snap.scanMs, '  hidden=' + hiddenOf(trimmed) + '  variants=1');
    return;
  }
  const list = Array.from(clients);
  for (let i = 0; i < list.length; i++) {
    sseWrite(list[i], 'agents', list[i].older ? fullData : trimmedData);
  }
  logAgentsFrame(fullData, sel, snap.scanMs,
                 '  hidden=' + hiddenOf(trimmed) + '  variants=2 (older + trimmed)');
}

async function tickInfra() {
  if (clients.size === 0) return;
  let snap;
  try {
    snap = await scanInfra();
  } catch (err) {
    log('infra tick error:', errmsg(err));
    return;
  }
  if (clients.size === 0) return;
  // Sent unconditionally: `detail` carries countdowns that change every tick.
  let data;
  try {
    data = JSON.stringify(snap);
  } catch (err) {
    data = JSON.stringify(emptyInfra(['snapshot not serialisable: ' + errmsg(err)], 0));
  }
  broadcast('infra', data);
}

async function tickStack() {
  if (clients.size === 0) return;
  if (!stackLibReady()) return; // nothing to say yet; the UI uses its fixture
  let snap;
  try {
    // force: STACK_CACHE_MS and this tick are both 30s, so a cached snapshot
    // is always a hair short of stale here and the cache would otherwise halve
    // the refresh rate to once a minute. Single-flight still applies, so a
    // concurrent /api/stack joins this scan rather than starting a second one.
    snap = await scanStack({ force: true });
  } catch (err) {
    log('stack tick error:', errmsg(err));
    return;
  }
  if (clients.size === 0) return;
  let data;
  try {
    data = JSON.stringify(snap);
  } catch (err) {
    data = JSON.stringify(emptyStack(['snapshot not serialisable: ' + errmsg(err)], 0));
  }
  broadcast('stack', data);
  logStackFrame(data, snap && snap.scanMs);
}

function tickPing() {
  if (clients.size === 0) return;
  broadcast('ping', String(Date.now()));
}

function startLoop() {
  if (timers) return;
  log('sse scan loop started');
  // Strict handover, not a second sampler: from here until the last client
  // leaves, this loop is the only thing scanning - and therefore the only
  // thing feeding history.
  stopMonitor();
  timers = {
    agents: setInterval(() => { tickAgents().catch((e) => log('agents tick rejected:', errmsg(e))); }, AGENTS_INTERVAL_MS),
    // One 30s timer drives infra and stack so the two panels stay in phase.
    // They are started side by side, not awaited in sequence: a slow stack
    // probe must never hold up the infra frame.
    infra: setInterval(() => {
      tickInfra().catch((e) => log('infra tick rejected:', errmsg(e)));
      tickStack().catch((e) => log('stack tick rejected:', errmsg(e)));
    }, INFRA_INTERVAL_MS),
    ping: setInterval(tickPing, PING_INTERVAL_MS),
  };
}

function stopLoop() {
  if (!timers) return;
  clearInterval(timers.agents);
  clearInterval(timers.infra);
  clearInterval(timers.ping);
  timers = null;
  lastAgentsSig = null;
  lastAgentsSentAt = 0;
  log('sse scan loop stopped (no clients)');
  // Nobody is watching, so nothing would be sampled. Hand back to the monitor.
  startMonitor(false);
}

// ---------------------------------------------------------------------------
// background monitor
//
// A history that only accumulates while a browser tab happens to be open is
// not a history. The scan loop above is refcounted by SSE clients and stops
// dead when the last one leaves, so this timer takes over and keeps sampling
// infra + stack + agents into the ring.
//
// The two never run together. startLoop() stops the monitor and stopLoop()
// starts it again, so exactly one of them is scanning at any moment and a
// period never gets scanned twice - which is the whole point, since a double
// scan would double the network cost and put two points where one belongs.
// The handover is logged once per transition (never per tick), so server.log
// is the proof.
//
// Cadence is MC_MONITOR_MS (default 60s, 0 disables). It sits deliberately
// above the 25s/30s scan caches: a scheduled tick therefore always misses the
// cache and produces a real sample, and the scans are left unforced so that a
// cache somehow still warm is reused rather than re-probed.
// ---------------------------------------------------------------------------

let monitorTimer = null;

function monitorTick() {
  // Belt and braces. stopMonitor() should already have fired, but a timer that
  // was mid-flight when a client connected must not scan on top of the loop.
  if (clients.size > 0) return;

  // Three independent chains, like the SSE initial burst: a slow stack probe
  // must not delay the infra sample. Each scan records itself on the way
  // through its own single-flight continuation.
  scanInfra().catch((err) => log('monitor infra scan failed:', errmsg(err)));
  if (stackLibReady()) {
    scanStack().catch((err) => log('monitor stack scan failed:', errmsg(err)));
  }
  // Trimmed: nobody is watching, so nothing needs the older sessions, and the
  // history point it feeds counts only deep/active sessions anyway.
  scanAgents('active', false).catch((err) => log('monitor agents scan failed:', errmsg(err)));
}

// immediate: sample straight away as well as on the interval. True at boot, so
// there is a point in the file within a second of starting; false on handover
// from the loop, which has just sampled and would only produce a duplicate.
function startMonitor(immediate) {
  if (MONITOR_MS <= 0 || monitorTimer || shuttingDown) return;
  log('monitor: idle sampling every ' + Math.round(MONITOR_MS / 1000) + 's (no clients)');
  monitorTimer = setInterval(monitorTick, MONITOR_MS);
  if (monitorTimer.unref) monitorTimer.unref();
  if (immediate) monitorTick();
}

function stopMonitor() {
  if (!monitorTimer) return;
  clearInterval(monitorTimer);
  monitorTimer = null;
  log('monitor: paused (sse clients connected)');
}

function handleStream(req, res, sessionValue, older) {
  // sessionValue: null (default 'active'), 'all', or a validated session id.
  const client = {
    id: ++clientSeq,
    res: res,
    closed: false,
    deepId: sessionValue,
    older: Boolean(older),
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setKeepAlive(true);
    res.socket.setTimeout(0);
  }
  try {
    res.write(': mission-control stream open\nretry: 3000\n\n');
  } catch (err) {
    return;
  }

  const unionBefore = selectorKey(unionDeepSelector());
  clients.add(client);
  const unionAfter = unionDeepSelector();
  log('sse client #' + client.id + ' connected (' + clients.size + ' total)' +
      (client.deepId ? ' deep=' + client.deepId : '') +
      (client.older ? ' older=1' : ''));
  if (selectorKey(unionAfter) !== unionBefore) {
    log('  deep union widened -> ' + selectorLabel(unionAfter));
  }

  const onClose = () => dropClient(client);
  req.on('close', onClose);
  req.on('aborted', onClose);
  res.on('close', onClose);
  res.on('error', (err) => { log('sse response error #' + client.id + ':', errmsg(err)); dropClient(client); });

  startLoop();

  // Initial burst: one infra, one stack and one agents frame straight away.
  // All three reuse the shared single-flight scans and caches, so opening a
  // second tab does not double the disk, network or PowerShell work.
  //
  // These are three independent chains on purpose - whichever resolves first
  // goes out first. The small cached payloads must not queue behind an agents
  // snapshot that can run to hundreds of KB, and the network-bound stack scan
  // must not hold up either of the others.
  scanInfra().then((snap) => {
    if (client.closed) return;
    sseWrite(client, 'infra', JSON.stringify(snap));
  }).catch((err) => log('initial infra frame failed:', errmsg(err)));

  // Cached snapshot if it is fresh, otherwise this kicks off a scan. Silent
  // while lib/stack.js is missing: the UI falls back to its own fixture.
  if (stackLibReady()) {
    scanStack().then((snap) => {
      if (client.closed) return;
      const data = JSON.stringify(snap);
      if (sseWrite(client, 'stack', data)) {
        logStackFrame(data, snap && snap.scanMs, '  (initial -> #' + client.id + ')');
      }
    }).catch((err) => log('initial stack frame failed:', errmsg(err)));
  }

  // If this client widened the deep union, that is a selector nobody has
  // scanned yet, so this kicks off an extra scan and the result goes to this
  // client alone - nobody waits for the next tick. If the union was unchanged
  // and a scan is already running, the single-flight map joins it for free.
  const keepIds = unionKeepIds();
  const wantsOlder = anyClientWantsOlder();
  const needFull = needFullScan(wantsOlder, keepIds);
  scanAgents(unionAfter, needFull).then((snap) => {
    if (client.closed) return;
    // Only this client is being served here, so only its variant is built.
    const view = client.older ? markIncludeOlder(snap) : applySessionFilter(snap, keepIds);
    const data = agentsJson(view);
    if (sseWrite(client, 'agents', data)) {
      logAgentsFrame(data, unionAfter, snap.scanMs,
                     '  hidden=' + hiddenOf(view) + '  (initial -> #' + client.id + ')');
      if (lastAgentsSentAt === 0) {
        lastAgentsSig = agentsSignature(snap, agentsVariantKey(unionAfter, wantsOlder, keepIds));
        lastAgentsSentAt = Date.now();
      }
    }
  }).catch((err) => log('initial agents frame failed:', errmsg(err)));
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

/**
 * Map a URL pathname onto a real file inside public/, or null if it escapes.
 * Rejects encoded traversal (/..%2fserver.js), absolute paths, drive letters,
 * backslashes and NUL bytes, then verifies containment on the resolved path.
 */
function resolvePublicPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (err) {
    return null; // malformed percent-encoding
  }
  if (decoded.indexOf('\u0000') !== -1) return null;
  if (decoded.indexOf('\\') !== -1) return null; // Windows separator smuggling
  if (/^[a-zA-Z]:/.test(decoded.replace(/^\/+/, ''))) return null; // C:\...

  const rel = decoded.replace(/^\/+/, '');
  if (rel === '') return null;
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === '..') return null;
  }

  const full = path.resolve(PUBLIC_DIR, rel);
  const relToPublic = path.relative(PUBLIC_DIR, full);
  if (relToPublic === '' || relToPublic.indexOf('..') === 0 || path.isAbsolute(relToPublic)) return null;
  return full;
}

// Final containment check, after symlink resolution.
function realPathInsidePublic(file) {
  try {
    const rp = fs.realpathSync.native || fs.realpathSync;
    const real = rp(file);
    const realPublic = rp(PUBLIC_DIR);
    const rel = path.relative(realPublic, real);
    return rel !== '' && rel.indexOf('..') !== 0 && !path.isAbsolute(rel);
  } catch (err) {
    return false;
  }
}

function sendStatic(req, res, file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return sendJson(res, 404, { error: 'not_found', path: req.mcPathname });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'not_found', path: req.mcPathname });
  if (!realPathInsidePublic(file)) return sendJson(res, 403, { error: 'forbidden', path: req.mcPathname });

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(file);
  stream.on('error', (err) => {
    log('static read error:', file, errmsg(err));
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// index.html carries {{STACK_*}} tokens for the stack module's display name
// (modules.stack.label, default "Stack") and one meta tag the UI reads before
// its first paint (label + formerIds), so a configured name never flashes the
// default first. Everything else about it is sendStatic's.
const htmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sendIndex(req, res, file) {
  let html;
  try {
    if (!realPathInsidePublic(file)) return sendJson(res, 403, { error: 'forbidden', path: req.mcPathname });
    html = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return sendJson(res, 404, { error: 'not_found', path: req.mcPathname });
  }
  const label = MODULES.stack.label;
  const meta = JSON.stringify({ label, formerIds: MODULES.stack.formerIds, enabled: MODULES.stack.enabled });
  html = html
    .replace(/\{\{STACK_META\}\}/g, htmlEsc(meta))
    .replace(/\{\{STACK_LABEL\}\}/g, htmlEsc(label))
    .replace(/\{\{STACK_UPPER\}\}/g, htmlEsc(label.toUpperCase()))
    .replace(/\{\{STACK_LOWER\}\}/g, htmlEsc(label.toLowerCase()));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  });
  return res.end(req.method === 'HEAD' ? undefined : html);
}

// Shown only until public/index.html exists; its author may still be writing
// it. Self-reloads so the real UI appears without a manual refresh.
function placeholderIndex() {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>mission-control</title>',
    '<style>',
    ' :root{color-scheme:dark}',
    ' body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#c8d0d8;',
    '      font:14px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}',
    ' .card{max-width:44rem;padding:2rem;border:1px solid #1e2630;border-radius:10px;background:#0f1318}',
    ' h1{margin:0 0 .5rem;font-size:1.1rem;color:#e7edf3;letter-spacing:.02em}',
    ' p{margin:.4rem 0;color:#8b98a6}',
    ' code{color:#7fd1b9} a{color:#7fb5ff}',
    '</style></head><body>',
    '<div class="card">',
    '  <h1>mission-control server is up</h1>',
    '  <p><code>public/index.html</code> has not been written yet, so there is no UI to serve.</p>',
    '  <p>The API is already live: <a href="/api/health">/api/health</a> &middot;',
    '     <a href="/api/agents">/api/agents</a> &middot;',
    '     <a href="/api/infra">/api/infra</a> &middot;',
    '     <a href="/api/stack">/api/stack</a> &middot;',
    '     <a href="/api/history">/api/history</a> &middot;',
    '     <a href="/api/stream">/api/stream</a></p>',
    '  <p>This page reloads every 3s and will disappear on its own.</p>',
    '</div>',
    '<script>setTimeout(function(){location.reload();},3000);</script>',
    '</body></html>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  let data;
  try {
    data = JSON.stringify(body);
  } catch (err) {
    status = 500;
    data = JSON.stringify({ error: 'serialization_failed', detail: errmsg(err) });
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

// ---------------------------------------------------------------------------
// access gate
//
// The moment this server listens on anything but loopback, everything it
// surfaces - local paths, project names, prompts, the Stack deploy state - is
// reachable by whatever else is on that network. So a non-loopback request has
// to carry a token.
//
// Loopback is never gated. That is deliberate and load bearing: `dash`, the
// browser tab, start.ps1's readiness probe and every local curl keep working
// exactly as before with no token anywhere, so turning phone access on cannot
// break the local workflow.
//
// The token itself is MC_TOKEN, or 32 random bytes generated on first need and
// kept in data/token.txt. The boot banner logs it MASKED (first 4 chars), and
// only when a non-loopback host is actually configured; read the full key from
// data/token.txt. A presented value is NEVER logged, right or wrong.
// ---------------------------------------------------------------------------

const TOKEN_FILE = path.join(ROOT, 'data', 'token.txt');
const TOKEN_OFF = process.env.MC_TOKEN_OFF === '1';
const COOKIE_NAME = 'mc_key';
const COOKIE_MAX_AGE = 2592000;   // 30 days, in seconds
const GATE_WINDOW_MS = 60000;
const GATE_MAX_FAILS = 10;        // per remote address per window

let tokenValue = null;
let tokenError = null;

function ensureToken() {
  if (tokenValue) return tokenValue;

  const fromEnv = process.env.MC_TOKEN;
  if (fromEnv && String(fromEnv).trim()) {
    tokenValue = String(fromEnv).trim();
    return tokenValue;
  }
  try {
    const onDisk = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (onDisk) {
      tokenValue = onDisk;
      return tokenValue;
    }
  } catch (err) { /* not written yet - fall through and make one */ }

  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    // mode 0600 is a no-op on Windows, but costs nothing and is right if this
    // ever runs anywhere else.
    fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    tokenValue = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    tokenError = null;
    log('gate: generated a new access token in data/token.txt');
    return tokenValue;
  } catch (err) {
    tokenError = errmsg(err);
    log('gate: could not create an access token: ' + tokenError);
    return null;
  }
}

/**
 * Constant-time compare.
 *
 * The length check in front is not a leak: the token is a fixed 64 hex chars
 * (or whatever MC_TOKEN was set to, which the attacker cannot influence), and
 * timingSafeEqual throws outright on a length mismatch.
 */
function tokenMatches(presented) {
  if (typeof presented !== 'string' || presented === '') return false;
  const want = ensureToken();
  if (!want) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (err) {
    return false;
  }
}

function cookieToken(req) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  const parts = String(raw).split(';');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.indexOf(COOKIE_NAME + '=') === 0) {
      const v = p.slice(COOKIE_NAME.length + 1);
      try {
        return decodeURIComponent(v);
      } catch (err) {
        return v;
      }
    }
  }
  return null;
}

// remote address -> { count, since }. Bounded below so a scan cannot grow it.
const gateFails = new Map();

function noteGateFailure(addr) {
  const now = Date.now();
  let e = gateFails.get(addr);
  if (!e || now - e.since >= GATE_WINDOW_MS) {
    e = { count: 0, since: now };
    gateFails.set(addr, e);
  }
  e.count += 1;
  if (gateFails.size > 512) {
    for (const [k, v] of gateFails) {
      if (now - v.since >= GATE_WINDOW_MS) gateFails.delete(k);
    }
  }
  // The address and the count, never the value that was presented.
  log('gate: denied ' + addr + ' (' + e.count + ')');
  return e.count;
}

// A correct key clears the counter, so a fat-fingered key on a phone cannot
// lock somebody out of their own dashboard for a minute.
function clearGateFailures(addr) {
  if (gateFails.has(addr)) gateFails.delete(addr);
}

// The unlock page. Inline, ASCII, and with no external references at all - a
// gated client cannot fetch style.css or app.js to render it.
function keyFormHtml() {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>mission-control</title>',
    '<style>',
    ' :root{color-scheme:dark}',
    ' body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#c8d0d8;',
    '      font:15px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}',
    ' form{display:grid;gap:.8rem;width:min(22rem,86vw);padding:1.5rem;',
    '      border:1px solid #1e2630;border-radius:10px;background:#0f1318}',
    ' h1{margin:0;font-size:1rem;color:#e7edf3;letter-spacing:.02em}',
    ' p{margin:0;color:#8b98a6;font-size:.85rem}',
    ' input,button{font:inherit;padding:.6rem;border-radius:6px}',
    ' input{border:1px solid #26303c;background:#0b0d10;color:#e7edf3}',
    ' button{border:0;background:#2b6cb0;color:#fff}',
    '</style></head><body>',
    '<form method="GET">',
    '  <h1>mission-control</h1>',
    '  <p>This machine is not on your loopback. Enter the access key.</p>',
    '  <input name="key" type="password" autofocus autocomplete="current-password" placeholder="access key">',
    '  <button type="submit">unlock</button>',
    '</form>',
    '</body></html>',
  ].join('\n');
}

function sendKeyForm(res) {
  const html = keyFormHtml();
  res.writeHead(401, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

// Rebuild the query string with `key` removed, so the redirect target is the
// URL the user actually wanted.
function withoutKey(query) {
  const q = new URLSearchParams(query);
  q.delete('key');
  const s = q.toString();
  return s ? '?' + s : '';
}

// A Location header with a stray control character makes writeHead throw and
// the socket hang. pathname arrives percent-encoded from the URL parser, so
// this should never trip - it is here so that "should never" is enforced.
const SAFE_PATH_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

/**
 * Returns true when the request may proceed. When it returns false it has
 * already answered.
 */
function gateRequest(req, res, pathname, query) {
  if (TOKEN_OFF) return true;

  const addr = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (isLoopback(addr)) return true;

  // ?key=<token> on ANY path: swap it for a cookie and bounce to the clean
  // URL, so the token stops appearing in the address bar, in browser history
  // and in this server's own request log.
  const presented = query.get('key');
  if (presented !== null && tokenMatches(presented)) {
    clearGateFailures(addr);
    const target = (SAFE_PATH_RE.test(pathname) ? pathname : '/') + withoutKey(query);
    res.writeHead(302, {
      'Location': target,
      'Set-Cookie': COOKIE_NAME + '=' + encodeURIComponent(tokenValue) +
                    '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + COOKIE_MAX_AGE,
      'Cache-Control': 'no-store, max-age=0',
    });
    res.end();
    return false;
  }

  if (tokenMatches(cookieToken(req))) {
    clearGateFailures(addr);
    return true;
  }

  const fails = noteGateFailure(addr);
  if (fails > GATE_MAX_FAILS) {
    const body = JSON.stringify({ error: 'too_many_requests', detail: 'too many failed key attempts' });
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store, max-age=0',
      'Retry-After': '60',
    });
    res.end(body);
    return false;
  }

  // A page gets something a phone can type into; everything else gets JSON.
  if (pathname === '/' || pathname === '/index.html') sendKeyForm(res);
  else sendJson(res, 401, { error: 'unauthorized' });
  return false;
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

// ONE handler shared by every bound address. There is no per-address state
// anywhere: the same client set, the same scan loops, the same history.
function requestHandler(req, res) {
  const t0 = Date.now();
  let pathname;
  let query;
  try {
    const u = new URL(req.url, 'http://' + HOST + ':' + PORT);
    pathname = u.pathname;
    query = u.searchParams;
  } catch (err) {
    return sendJson(res, 400, { error: 'bad_request', detail: 'unparseable url' });
  }
  req.mcPathname = pathname;

  res.on('finish', () => {
    if (pathname !== '/api/stream') {
      // pathname only - the query can carry ?key=, which must never be logged.
      log(req.method + ' ' + pathname + ' ' + res.statusCode + ' ' + (Date.now() - t0) + 'ms');
    }
  });

  // Before anything else, including the method check: a non-loopback client
  // gets nothing at all until it proves it has the token.
  if (!gateRequest(req, res, pathname, query)) return;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 404, { error: 'not_found', path: pathname, method: req.method });
  }

  // --- api ---------------------------------------------------------------
  if (pathname === '/api/health') {
    // <name>Lib stays a plain boolean for every registry entry - the UI reads
    // agentsLib/infraLib and must keep working byte-for-byte. The loader error
    // for a lib that is not up goes in `libs`, which is additive.
    const body = {
      ok: true,
      uptimeMs: Date.now() - STARTED_AT,
      port: PORT,
    };
    const reloads = {};
    const libs = {};
    for (let n = 0; n < LIB_NAMES.length; n++) {
      const name = LIB_NAMES[n];
      const st = loadLib(name);
      body[name + 'Lib'] = Boolean(st.fn);
      reloads[name] = libState[name].reloads;
      libs[name] = {
        file: 'lib/' + LIBS[name].file,
        export: LIBS[name].export,
        ok: Boolean(st.fn),
        error: st.fn ? null : st.error,
        reloads: libState[name].reloads,
      };
    }
    body.reloads = reloads;
    body.libs = libs;
    body.history = historySummary();
    // Which addresses actually took. A non-loopback one can sit at
    // listening:false for a while after boot while Tailscale comes up.
    body.hosts = hostStates.map((h) => ({ addr: h.addr, listening: h.listening }));
    body.gate = { enabled: !TOKEN_OFF, loopbackExempt: true };
    body.modules = {
      stack: { enabled: MODULES.stack.enabled, reason: MODULES.stack.reason,
               label: MODULES.stack.label, formerIds: MODULES.stack.formerIds },
    };
    body.config = {
      since: sessionFilter.since,
      sinceSession: sessionFilter.sinceSession,
      file: CONFIG_FILE,
      error: configError,
    };
    return sendJson(res, 200, body);
  }

  if (pathname === '/api/agents') {
    const v = validSessionParam(query.get('session'));
    if (!v.ok) return sendJson(res, 400, BAD_SESSION);
    const older = wantsOlderParam(query.get('older'));
    // An explicit ?session=<id> may name a session older than the cutoff, so
    // the scan has to fetch everything and that id is pinned back in below.
    const explicit = v.value && v.value !== 'all' ? v.value : null;
    const keepIds = new Set(explicit ? [explicit] : []);
    return scanAgents(paramToSelector(v.value), needFullScan(older, keepIds))
      .then((snap) => sendJson(res, 200, older
        ? markIncludeOlder(snap)
        : applySessionFilter(snap, keepIds)))
      .catch((err) => sendJson(res, 200, emptyAgents(['agents route failed: ' + errmsg(err)], 0)));
  }

  if (pathname === '/api/infra') {
    return scanInfra()
      .then((snap) => sendJson(res, 200, snap))
      .catch((err) => sendJson(res, 200, emptyInfra(['infra route failed: ' + errmsg(err)], 0)));
  }

  if (pathname === '/api/stack') {
    // Unlike agents/infra, a missing lib is a 503 rather than an empty
    // snapshot: the UI has a fixture to fall back on and needs to be able to
    // tell "not wired up yet" from "scanned, found nothing".
    if (moduleOff('stack')) {
      return sendJson(res, 404, { error: 'module_disabled', module: 'stack', detail: MODULES.stack.reason });
    }
    const at = loadLib('stack');
    if (!at.fn) {
      return sendJson(res, 503, { error: 'stack lib not loaded', detail: at.error });
    }
    return scanStack()
      .then((snap) => sendJson(res, 200, snap))
      .catch((err) => sendJson(res, 200, emptyStack(['stack route failed: ' + errmsg(err)], 0)));
  }

  if (pathname === '/api/history') {
    const hours = validRange(query.get('hours'), HISTORY_DEFAULT_HOURS, HISTORY_MIN_HOURS, HISTORY_MAX_HOURS);
    if (!hours.ok) {
      return sendJson(res, 400, {
        error: 'bad_request',
        detail: 'hours must be a number from ' + HISTORY_MIN_HOURS + ' to ' + HISTORY_MAX_HOURS,
        got: query.get('hours'),
      });
    }
    const maxPoints = validRange(query.get('maxPoints'), HISTORY_DEFAULT_POINTS, HISTORY_MIN_POINTS, HISTORY_MAX_POINTS);
    if (!maxPoints.ok) {
      return sendJson(res, 400, {
        error: 'bad_request',
        detail: 'maxPoints must be a number from ' + HISTORY_MIN_POINTS + ' to ' + HISTORY_MAX_POINTS,
        got: query.get('maxPoints'),
      });
    }
    // Recording off, or the lib failed to load: answer with the empty shape
    // rather than a 503. There is nothing broken to report - there is just no
    // history - and the UI should render an empty chart, not an error state.
    if (!history) return sendJson(res, 200, emptyHistoryResult(hours.value));
    try {
      return sendJson(res, 200, history.query({ hours: hours.value, maxPoints: maxPoints.value }));
    } catch (err) {
      log('history query failed:', errmsg(err));
      const out = emptyHistoryResult(hours.value);
      out.error = 'history query failed: ' + errmsg(err);
      return sendJson(res, 200, out);
    }
  }

  if (pathname === '/api/stream') {
    if (req.method === 'HEAD') return sendJson(res, 404, { error: 'not_found', path: pathname });
    const v = validSessionParam(query.get('session'));
    if (!v.ok) return sendJson(res, 400, BAD_SESSION);
    return handleStream(req, res, v.value, wantsOlderParam(query.get('older')));
  }

  if (pathname.indexOf('/api/') === 0) {
    return sendJson(res, 404, { error: 'not_found', path: pathname });
  }

  // --- static ------------------------------------------------------------
  if (pathname === '/' || pathname === '/index.html') {
    const index = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(index)) return sendIndex(req, res, index);
    const html = placeholderIndex();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store, max-age=0',
    });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }

  const file = resolvePublicPath(pathname);
  if (!file) {
    log('rejected path traversal attempt: ' + req.method + ' ' + req.url);
    return sendJson(res, 403, { error: 'forbidden', detail: 'path escapes public/', path: pathname });
  }
  return sendStatic(req, res, file);
}

// ---------------------------------------------------------------------------
// binding
//
// One http.Server per address, all running requestHandler. Loopback is
// mandatory and a failure there is fatal - without it nothing local works and
// a half-started server would be worse than none. Every other address is best
// effort: EADDRNOTAVAIL is the normal case at boot, because Tailscale brings
// its interface up well after this process starts, so a failure there logs
// once and retries quietly every 30s until the address exists.
// ---------------------------------------------------------------------------

const hostStates = HOSTS.map((addr) => ({
  addr: addr,
  server: null,
  listening: false,
  error: null,
  retry: null,
  announcedFail: false,
}));

function fatalBind(state, err) {
  const code = err && err.code;
  if (code === 'EADDRINUSE') {
    console.error('\n[mission-control] port ' + PORT + ' is already in use on ' + state.addr + '.');
    console.error('[mission-control] stop whatever is listening, or start with --port <other>.\n');
  } else if (code === 'EACCES') {
    console.error('\n[mission-control] not allowed to bind ' + state.addr + ':' + PORT + '.\n');
  } else {
    console.error('[mission-control] server error on ' + state.addr + ':', errmsg(err));
  }
  process.exit(1);
}

function scheduleRebind(state) {
  if (state.retry || shuttingDown) return;
  state.retry = setTimeout(() => {
    state.retry = null;
    bindHost(state);
  }, HOST_RETRY_MS);
  if (state.retry.unref) state.retry.unref();
}

function bindHost(state) {
  if (shuttingDown) return;
  if (!state.server) {
    state.server = http.createServer(requestHandler);
    state.server.on('clientError', (err, socket) => {
      if (socket && !socket.destroyed) socket.destroy();
    });
    state.server.on('error', (err) => {
      state.listening = false;
      state.error = errmsg(err);
      if (isLoopback(state.addr)) return fatalBind(state, err);
      if (!state.announcedFail) {
        state.announcedFail = true;
        log('bind ' + urlHost(state.addr) + ':' + PORT + ' failed (' + ((err && err.code) || errmsg(err)) +
            ') - serving loopback only, retrying every ' + Math.round(HOST_RETRY_MS / 1000) + 's');
      }
      scheduleRebind(state);
    });
  }
  try {
    state.server.listen(PORT, state.addr, () => {
      state.listening = true;
      state.error = null;
      const retried = state.announcedFail;
      state.announcedFail = false;
      log('listening on http://' + urlHost(state.addr) + ':' + PORT +
          (retried ? '  (retry succeeded)' : ''));
    });
  } catch (err) {
    // listen() throws synchronously on a malformed address rather than
    // emitting 'error'.
    state.listening = false;
    state.error = errmsg(err);
    if (isLoopback(state.addr)) return fatalBind(state, err);
    if (!state.announcedFail) {
      state.announcedFail = true;
      log('bind ' + urlHost(state.addr) + ':' + PORT + ' failed (' + errmsg(err) +
          ') - serving loopback only, retrying every ' + Math.round(HOST_RETRY_MS / 1000) + 's');
    }
    scheduleRebind(state);
  }
}

// A local dashboard should not die because a scanner misbehaved.
process.on('unhandledRejection', (err) => log('unhandled rejection:', errmsg(err)));
process.on('uncaughtException', (err) => log('uncaught exception (staying up):', (err && err.stack) || errmsg(err)));

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(signal + ' - shutting down');
  stopLibWatcher();
  stopLoop();          // this would normally hand back to the monitor...
  stopMonitor();       // ...so stop that too, before the final flush
  const list = Array.from(clients);
  for (let i = 0; i < list.length; i++) dropClient(list[i]);
  closeHistory(signal);

  let open = 0;
  for (let i = 0; i < hostStates.length; i++) {
    const st = hostStates[i];
    if (st.retry) { clearTimeout(st.retry); st.retry = null; }
    if (!st.server) continue;
    open += 1;
    try {
      st.server.close(() => { if (--open === 0) process.exit(0); });
    } catch (err) {
      open -= 1;
    }
  }
  if (open === 0) process.exit(0);
  const t = setTimeout(() => process.exit(0), 1500);
  if (t.unref) t.unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Best effort only. Ctrl+C under start.ps1 lands on SIGINT and flushes cleanly,
// but `dash` runs the server hidden and it is normally killed with
// Stop-Process, which is uncatchable on Windows - no handler of any kind gets
// to run. That is why the flush interval is 60s: at worst a minute of samples
// is lost, which does not matter. Do not try to be cleverer about it.
process.on('beforeExit', () => flushHistory('beforeExit'));

function boot() {
  log('mission-control starting on port ' + PORT + '  (pid ' + process.pid + ')');
  for (let i = 0; i < hostStates.length; i++) bindHost(hostStates[i]);

  // Pad the names so the status column lines up however many scanners exist.
  let width = 0;
  for (let n = 0; n < LIB_NAMES.length; n++) {
    width = Math.max(width, LIBS[LIB_NAMES[n]].file.length);
  }
  let missing = false;
  for (let n = 0; n < LIB_NAMES.length; n++) {
    const name = LIB_NAMES[n];
    const st = loadLib(name);
    let label = 'lib/' + LIBS[name].file;
    while (label.length < width + 4) label += ' ';
    log('  ' + label + ': ' + (st.fn ? 'ok' : st.error));
    if (!st.fn && !moduleOff(name)) missing = true;
  }
  if (missing) log('  (missing libs are retried on every request - no restart needed)');
  startLibWatcher();

  startConfigPoll();
  initHistory();
  if (MONITOR_MS > 0) {
    // Immediate first sample so there is a point on disk within a second of
    // boot, rather than a MONITOR_MS-long hole at the start of every session.
    startMonitor(true);
  } else {
    log('monitor: idle sampling disabled (MC_MONITOR_MS=0)');
  }

  announceGate();
}

/**
 * The one and only place the token is ever mentioned in the log, and even
 * here it is masked to its first 4 chars.
 *
 * Only when a non-loopback address is actually configured - a loopback-only
 * server has no gate to unlock. The masked prefix lets you check which key is
 * live; the full value is read from data/token.txt (or MC_TOKEN), never from
 * server.log, so a log pasted into an issue cannot unlock anything.
 */
function announceGate() {
  if (REMOTE_HOSTS.length === 0) {
    if (TOKEN_OFF) log('gate: MC_TOKEN_OFF=1, but no non-loopback host is configured - nothing is exposed');
    return;
  }
  if (TOKEN_OFF) {
    log('*** WARNING: MC_TOKEN_OFF=1 - the access gate is DISABLED and anyone who');
    log('*** can reach ' + urlHost(REMOTE_HOSTS[0]) + ':' + PORT + ' can read this dashboard, which');
    log('*** surfaces local paths, project names and prompts. Unset it.');
    return;
  }
  const token = ensureToken();
  if (!token) {
    log('gate: NO TOKEN AVAILABLE (' + tokenError + ') - non-loopback requests will all be refused');
    return;
  }
  // Masked: only the first 4 chars reach server.log, so a shared or committed
  // log never carries a working key. The full key lives in data/token.txt (or
  // MC_TOKEN); a helper that builds the phone URL should read it from there.
  log('phone url: http://' + urlHost(REMOTE_HOSTS[0]) + ':' + PORT + '/?key=' + maskToken(token) +
      '  (full key: ' + (process.env.MC_TOKEN ? 'MC_TOKEN' : 'data/token.txt') + ')');
}

/** First 4 chars plus an ellipsis - never the whole key. */
function maskToken(t) {
  const s = String(t || '');
  return s.length <= 8 ? '****' : s.slice(0, 4) + '...';
}

boot();
