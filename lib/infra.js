'use strict';
/**
 * mission-control / lib/infra.js
 * ---------------------------------------------------------------------------
 * READ-ONLY observability probe. Returns a snapshot of what is running on this
 * machine (plus the optional stack module's projects), for the dashboard's
 * right-hand rail.
 *
 * Hard rules baked into this file:
 *   - Nothing outside this mission-control checkout is ever written.
 *   - No service, scheduled task or process is ever started/stopped.
 *   - No secret leaves this module. We never read .env files, never read
 *     ~/.claude/settings.local.json, and never emit a process command line
 *     verbatim (only a matched script basename). See redact().
 *   - Every probe is independently timeout-guarded and NEVER rejects.
 *     scanInfra() always resolves.
 *
 * Zero npm dependencies. CommonJS. Node 20+.
 */

const https        = require('node:https');
const http         = require('node:http');
const fs           = require('node:fs');
const fsp          = require('node:fs/promises');
const os           = require('node:os');
const path         = require('node:path');
const { execFile } = require('node:child_process');

const USER_AGENT    = 'mission-control/1.0 (+local dashboard probe)';
const MAX_REDIRECTS = 2;

// ── Paths we read (read-only) ───────────────────────────────────────────────
// Everything project-specific belongs to the OPTIONAL project module and comes
// from data/config.json via lib/modules.js: the main app's origin and
// checkout, plus an optional `modules.stack.infra` profile that names extra
// HTTP services, in-process schedules, a HOLD file and resident processes to
// watch (see data/config.example.json). Nothing private is hard-coded. With
// the module off - the default - P is null and only the generic rows are
// built: node/python/Claude processes, listening ports, and whatever
// `watchedTasks` the config lists.
//
// The values are applied per scan by applyProjects(). Module-level on purpose:
// server.js single-flights scanInfra(), and every builder below reads them.
const HOME = os.homedir();
const STACK_HEALTH_PATH       = '/api/health'; // 503 = a genuine "down"
let P                  = null; // resolved modules.stack infra settings, or null
let PROFILE            = {};   // modules.stack.infra (names, rows), {} if none
let WATCHED_TASKS      = [];   // [{ id, taskName, label }] from watchedTasks
let STACK_DIR          = null;
let STACK_SCHEDULER    = null;
let STACK_ORIGIN       = null;

/* ~ and ~/ in profile paths expand to the scan's home directory. */
function profilePath(p, home) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const s = p.trim();
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2));
  return s;
}
const list = (v) => (Array.isArray(v) ? v : []);
const text = (v, dflt) => (typeof v === 'string' && v ? v : dflt);

/**
 * Point the module at one scan's settings.
 * @param {object|null} projects     modules.stack infra settings, null = off
 * @param {Array}       watchedTasks [{ id, taskName, label }]
 */
function applyProjects(projects, watchedTasks) {
  P = projects && typeof projects === 'object' ? projects : null;
  WATCHED_TASKS = Array.isArray(watchedTasks) ? watchedTasks : [];
  const home = (P && P.home) || HOME;
  PROFILE            = P && P.profile && typeof P.profile === 'object' ? P.profile : {};
  STACK_DIR          = P && P.stackRoot ? P.stackRoot : null;
  STACK_SCHEDULER    = STACK_DIR && PROFILE.schedulerFile
    ? path.join(STACK_DIR, PROFILE.schedulerFile) : null;
  STACK_ORIGIN       = P ? P.stackOrigin || null : null;
  PROFILE_HOME       = home;
}
let PROFILE_HOME = HOME;

/* Profile rows, normalised. Each service: { id, label, origin, healthPath,
   fallback }. Each process: { id, label, dirNeedle, scripts, dir, modeFile }. */
function profileServices() {
  return list(PROFILE.services).filter(s => s && s.id).map(s => ({
    id: s.id, label: text(s.label, s.id), origin: s.origin || null,
    healthPath: typeof s.healthPath === 'string' ? s.healthPath : '',
    fallback: text(s.fallback, s.label || s.id),
  }));
}
function profileProcesses() {
  return list(PROFILE.processes).filter(p => p && p.id);
}

/**
 * Settings for one scan. A caller that passes `projects` / `watchedTasks`
 * (server.js does, from lib/modules.js) is taken at its word. A caller that
 * passes neither - the CLI below, or an older server.js hot-reloading this
 * file - gets the same data/config.json resolution server.js would do.
 */
function resolveScanSettings(opts) {
  if (opts && ('projects' in opts || 'watchedTasks' in opts)) {
    return { projects: opts.projects || null, watchedTasks: opts.watchedTasks || [] };
  }
  try {
    const file = process.env.MC_CONFIG_FILE || path.join(__dirname, '..', 'data', 'config.json');
    const m = require('./modules').loadModules(file).modules;
    return { projects: m.stack.enabled ? m.stack.infra : null, watchedTasks: m.watchedTasks };
  } catch (_) {
    return { projects: null, watchedTasks: [] };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Small utilities
// ═══════════════════════════════════════════════════════════════════════════

/** Resolve `p`, or `fallback` after `ms`. Never rejects. */
function withTimeout(p, ms, fallback) {
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    if (t.unref) t.unref();
    Promise.resolve(p).then(
      v => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(t); resolve(fallback); } }
    );
  });
}

/**
 * Belt-and-braces scrubber for any string that came off disk or out of another
 * process. Strips things that look like credentials before they can reach the
 * dashboard. We already avoid reading secret-bearing files at all; this is the
 * second line of defence, not the first.
 */
function redact(s) {
  if (typeof s !== 'string') return s;
  return s
    // connection strings: postgres://user:pass@host/db -> postgres://<redacted>@
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s/@]*:[^\s/@]*@/gi, '$1://<redacted>@')
    // key=value / key: value where the key smells like a secret
    .replace(/\b(pass(?:word)?|secret|token|api[_-]?key|apikey|auth|bearer|credential|private[_-]?key|conn(?:ection)?[_-]?string)\b\s*[:=]\s*\S+/gi,
             '$1=<redacted>')
    // bare email addresses
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<redacted>')
    // things shaped like API keys
    .replace(/\b(?:sk|pk|rk|xox[abps])[-_][A-Za-z0-9_-]{12,}/g, '<redacted>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted>');
}

function shortErr(err) {
  if (!err) return 'unknown error';
  const code = err.code || '';
  const map = {
    ENOTFOUND: 'DNS lookup failed', ECONNREFUSED: 'connection refused',
    ECONNRESET: 'connection reset', ETIMEDOUT: 'timed out',
    EHOSTUNREACH: 'host unreachable', ENETUNREACH: 'network unreachable',
    EAI_AGAIN: 'DNS temporarily unavailable', CERT_HAS_EXPIRED: 'TLS cert expired',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS hostname mismatch',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS verify failed',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed TLS cert',
    ENOENT: 'not found', EACCES: 'permission denied',
  };
  if (map[code]) return map[code];
  const m = redact(String(err.message || code || err)).slice(0, 90);
  return m || 'request failed';
}

const item = (id, label, state, detail, sub, meta) => {
  const o = { id, label, state, detail: detail == null ? '' : redact(String(detail)) };
  if (sub != null)  o.sub  = redact(String(sub));
  if (meta != null) o.meta = meta;
  return o;
};

// ═══════════════════════════════════════════════════════════════════════════
// 5-field cron expression evaluator (self-contained, no dependencies)
// Supports: *  n  a,b  a-b  */n  a-b/n  n/step   — plus 7 == Sunday for DOW.
// Evaluated in UTC: every schedule in a project profile is read as a UTC
// expression (the usual node-cron { timezone: 'UTC' } registration).
// ═══════════════════════════════════════════════════════════════════════════

function parseField(spec, min, max) {
  const set = new Set();
  const star = String(spec).trim() === '*';
  for (const raw of String(spec).split(',')) {
    const part = raw.trim();
    if (!part) throw new Error(`empty cron field part in "${spec}"`);
    let step = 1;
    let range = part;
    const slash = part.indexOf('/');
    if (slash !== -1) {
      range = part.slice(0, slash);
      step = Number.parseInt(part.slice(slash + 1), 10);
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    }
    let lo, hi;
    if (range === '*') {
      lo = min; hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = Number.parseInt(a, 10); hi = Number.parseInt(b, 10);
    } else {
      lo = Number.parseInt(range, 10);
      hi = slash === -1 ? lo : max;      // "n/step" == n, n+step, ... up to max
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`bad range "${part}"`);
    if (lo > hi) throw new Error(`inverted range "${part}"`);
    const ceiling = max === 7 ? 6 : max;
    for (let v = lo; v <= hi; v += step) {
      const n = (max === 7 && v === 7) ? 0 : v;   // DOW: 7 == Sunday
      if (n < min || n > ceiling) throw new Error(`out of range "${part}"`);
      set.add(n);
    }
  }
  if (!set.size) throw new Error(`cron field "${spec}" matches nothing`);
  return { set, star };
}

function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`expected 5 cron fields, got ${f.length}`);
  return {
    minute: parseField(f[0], 0, 59),
    hour:   parseField(f[1], 0, 23),
    dom:    parseField(f[2], 1, 31),
    month:  parseField(f[3], 1, 12),
    dow:    parseField(f[4], 0, 7),
  };
}

/** Standard cron DOM/DOW semantics: OR when both are restricted, else AND. */
function dateMatches(c, y, mo0, d) {
  const dt = new Date(Date.UTC(y, mo0, d));
  if (dt.getUTCMonth() !== mo0) return false;          // rolled past month end
  if (!c.month.set.has(mo0 + 1)) return false;
  const domOk = c.dom.set.has(d);
  const dowOk = c.dow.set.has(dt.getUTCDay());
  if (c.dom.star && c.dow.star) return true;
  if (c.dom.star) return dowOk;
  if (c.dow.star) return domOk;
  return domOk || dowOk;
}

// How far ahead to search for a match. Must comfortably exceed the longest gap
// between two valid dates: "0 0 29 2 *" (Feb 29) can be ~1461 days out, and
// ~2922 across a skipped century leap year like 2100. 4000 days covers both.
// The scan is day-at-a-time and only runs to exhaustion when nothing matches,
// so the worst case is a few thousand cheap comparisons.
const CRON_SEARCH_DAYS = 4000;

/** Next fire strictly after `from`, in UTC. Returns a Date, or null. */
function nextCronFireUTC(expr, from = new Date()) {
  const c = parseCron(expr);
  // Start at the top of the next whole minute (cron has 1-minute resolution).
  const start = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
  let y = start.getUTCFullYear(), mo0 = start.getUTCMonth(), d = start.getUTCDate();
  const h0 = start.getUTCHours(), m0 = start.getUTCMinutes();

  for (let day = 0; day < CRON_SEARCH_DAYS; day++) {
    if (dateMatches(c, y, mo0, d)) {
      const hStart = day === 0 ? h0 : 0;
      for (let h = hStart; h < 24; h++) {
        if (!c.hour.set.has(h)) continue;
        const mStart = (day === 0 && h === h0) ? m0 : 0;
        for (let mi = mStart; mi < 60; mi++) {
          if (c.minute.set.has(mi)) return new Date(Date.UTC(y, mo0, d, h, mi));
        }
      }
    }
    const nxt = new Date(Date.UTC(y, mo0, d + 1));     // advance one UTC day
    y = nxt.getUTCFullYear(); mo0 = nxt.getUTCMonth(); d = nxt.getUTCDate();
  }
  return null;
}

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtUTC(d) {
  const p = n => String(n).padStart(2, '0');
  return `${DOW_NAMES[d.getUTCDay()]} ${p(d.getUTCDate())} ${MON_NAMES[d.getUTCMonth()]}`
       + ` ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** "in 4h 12m" / "in 2d 3h" / "in 46m" */
function relFromNow(future, now = new Date()) {
  let ms = future.getTime() - now.getTime();
  if (ms < 0) ms = 0;
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

function relSince(past, now = new Date()) {
  let ms = now.getTime() - past.getTime();
  if (ms < 0) ms = 0;
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTPS probe
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET `url` with a hard timeout, following at most `redirectsLeft` redirects.
 * Never rejects — always resolves to a result object.
 */
function httpProbe(url, { timeoutMs = 4000, redirectsLeft = MAX_REDIRECTS,
                          collectBody = 0, _started } = {}) {
  const started = _started == null ? Date.now() : _started;
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };

    let u;
    try { u = new URL(url); }
    catch { return done({ ok: false, error: 'malformed URL', ms: 0, url }); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return done({ ok: false, error: `unsupported protocol ${u.protocol}`, ms: 0, url });
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
        headers: { 'user-agent': USER_AGENT, accept: '*/*', connection: 'close' },
        timeout: Math.max(200, timeoutMs),
      }, res => {
        const status = res.statusCode || 0;
        const loc = res.headers && res.headers.location;
        res.on('error', () => {});

        if (status >= 300 && status < 400 && loc && redirectsLeft > 0) {
          let next;
          try { next = new URL(loc, url).toString(); }
          catch {
            return done({ ok: false, status, error: 'bad redirect target',
                          ms: Date.now() - started, url });
          }
          const remaining = Math.max(250, timeoutMs - (Date.now() - started));
          res.resume();
          return httpProbe(next, { timeoutMs: remaining,
                                   redirectsLeft: redirectsLeft - 1,
                                   collectBody, _started: started })
            .then(r => done({ ...r, redirects: (r.redirects || 0) + 1, url }));
        }
        const base = {
          ok: status >= 200 && status < 400,
          status, url, finalUrl: url, redirects: 0,
        };
        // Body collection is opt-in and hard-bounded. Only JSON is read, and
        // only up to collectBody bytes — past that we drop what we have and
        // hang up rather than buffering an unbounded response into the rail.
        const ctype = String((res.headers && res.headers['content-type']) || '');
        if (collectBody > 0 && ctype.toLowerCase().includes('json')) {
          let buf = '', bytes = 0, over = false;
          res.setEncoding('utf8');
          res.on('data', chunk => {
            if (over) return;
            bytes += Buffer.byteLength(chunk, 'utf8');
            if (bytes > collectBody) {
              over = true; buf = '';
              try { res.destroy(); } catch { /* already gone */ }
              return;
            }
            buf += chunk;
          });
          const finish = () => done({ ...base, ms: Date.now() - started,
                                      body: over ? null : buf, bodyTooLarge: over });
          res.on('end', finish);
          res.on('close', finish);          // done() is idempotent
          return;
        }
        res.resume();                                   // drain, never buffer
        done({ ...base, ms: Date.now() - started });
      });
    } catch (err) {
      return done({ ok: false, error: shortErr(err), ms: Date.now() - started, url });
    }

    req.on('timeout', () => {
      const e = new Error('timed out'); e.code = 'ETIMEDOUT';
      req.destroy(e);
    });
    req.on('error', err => done({ ok: false, error: shortErr(err),
                                  ms: Date.now() - started, url }));
    try { req.end(); }
    catch (err) { done({ ok: false, error: shortErr(err), ms: Date.now() - started, url }); }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PowerShell probe — ONE process for scheduled tasks + processes + ports.
//
// Two deliberate choices here, both measured on this machine:
//
//  1. Tasks come from the Schedule.Service COM API, not Get-ScheduledTask |
//     Get-ScheduledTaskInfo. The cmdlets cost ~4.1 s cold (PowerShell module
//     autoload + enumerating all 205 tasks); the COM API fetches exactly the
//     six we care about in ~110 ms. Same fields, 35x faster, and it is what
//     lets the whole probe fit inside the default 4000 ms budget.
//  2. Processes come from one Win32_Process CIM query (~190 ms) rather than
//     Get-Process plus a per-PID CIM call, and the port query is skipped
//     entirely when no node/python process exists — nothing could match.
//
// The script contains NO double-quote characters, so it survives being handed
// to -Command as a single execFile argument with no Windows quoting ambiguity.
// It is strictly read-only: it starts, stops and modifies nothing.
// ═══════════════════════════════════════════════════════════════════════════

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$out = [ordered]@{ tasksOk = $false; tasks = @(); procs = @(); claude = @(); ports = @(); errors = @() }

function ConvertTo-Iso($d) {
  if ($null -eq $d) { return $null }
  try {
    if ($d.Year -lt 1900) { return $null }   # COM sentinel for "no next run"
    return $d.ToUniversalTime().ToString('o')
  } catch { return $null }
}

try {
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  $root = $svc.GetFolder('\\')
  $want = @(__WANT__)
  foreach ($n in $want) {
    $t = $null
    try { $t = $root.GetTask($n) } catch { }
    if ($null -eq $t) { continue }
    $out.tasks += [ordered]@{
      name       = [string]$t.Name
      state      = [int]$t.State
      enabled    = [bool]$t.Enabled
      lastRun    = ConvertTo-Iso $t.LastRunTime
      nextRun    = ConvertTo-Iso $t.NextRunTime
      lastResult = [int]$t.LastTaskResult
      missed     = [int]$t.NumberOfMissedRuns
    }
  }
  $out.tasksOk = $true
} catch { $out.errors += ('tasks: ' + $_.Exception.Message) }

try {
  $Q  = [char]39   # single quote
  $BS = [char]92   # backslash - kept out of regex/string literals entirely
  $names = @('node.exe','python.exe','py.exe','pythonw.exe','claude.exe')
  $filter = ($names | ForEach-Object { 'Name=' + $Q + $_ + $Q }) -join ' OR '
  $q = Get-CimInstance Win32_Process -Filter $filter
  foreach ($p in $q) {
    $cl  = [string]$p.CommandLine
    $low = $(if ($cl) { $cl.ToLower() } else { '' })

    # Claude Code CLI. On this machine it runs as claude.exe, but match a
    # node-hosted install too. The dashboard's own server.js is excluded.
    $isClaude = $false
    if ($p.Name -eq 'claude.exe') {
      $isClaude = $true
    } elseif ($low -and -not $low.Contains('mission-control')) {
      if ($low.Contains($BS + 'claude' + $BS) -or
          $low.Contains('/claude/') -or
          $low.Contains('claude.js') -or
          $low.Contains('claude-code')) { $isClaude = $true }
    }

    if ($isClaude) {
      # Counted only. The command line NEVER leaves PowerShell for these -
      # a CLI invocation can carry flags and prompt text we have no business
      # surfacing, so the match decision is made here and only pid/start ship.
      $out.claude += [ordered]@{
        pid   = [int]$p.ProcessId
        name  = [string]$p.Name
        start = ConvertTo-Iso $p.CreationDate
      }
      continue
    }
    # claude.exe is never counted as a node/python process.
    if ($p.Name -eq 'claude.exe') { continue }

    $out.procs += [ordered]@{
      pid   = [int]$p.ProcessId
      name  = [string]$p.Name
      start = ConvertTo-Iso $p.CreationDate
      cmd   = $(if ($cl) { $cl.Substring(0, [Math]::Min(500, $cl.Length)) } else { $null })
    }
  }
} catch { $out.errors += ('procs: ' + $_.Exception.Message) }

try {
  if ($out.procs.Count -gt 0) {
    $byPid = @{}
    foreach ($p in $out.procs) { $byPid[[int]$p.pid] = [string]$p.name }
    $conns = Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'State=2'
    foreach ($c in $conns) {
      if ([int]$c.LocalPort -ge 10000) { continue }
      if (-not $byPid.ContainsKey([int]$c.OwningProcess)) { continue }
      $out.ports += [ordered]@{
        port = [int]$c.LocalPort
        pid  = [int]$c.OwningProcess
        proc = $byPid[[int]$c.OwningProcess]
        addr = [string]$c.LocalAddress
      }
    }
  }
} catch { $out.errors += ('ports: ' + $_.Exception.Message) }

$out | ConvertTo-Json -Depth 5 -Compress
`;

/**
 * PS_SCRIPT with the watched task names spliced in as single-quoted
 * PowerShell literals ('' escapes a quote). Names carrying a double quote or a
 * line break are refused outright, which keeps the script free of
 * double-quote characters as the note above requires.
 */
function psScript() {
  const lits = WATCHED_TASKS
    .map(w => w.taskName)
    .filter(n => typeof n === 'string' && n && !/["\r\n`]/.test(n))
    .map(n => "'" + n.replace(/'/g, "''") + "'");
  return PS_SCRIPT.replace('__WANT__', lits.join(', '));
}

/** Runs the single PowerShell probe. Never rejects, never throws. */
function probeWindows(timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now();
    let settled = false;
    const fail = reason => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: reason, ms: Date.now() - started,
                tasks: [], procs: [], claude: [], ports: [], errors: [] });
    };
    const ok = payload => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    let child;
    try {
      child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript()],
        { timeout: Math.max(500, timeoutMs), maxBuffer: 8 * 1024 * 1024,
          windowsHide: true, killSignal: 'SIGKILL', encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err && !stdout) {
            return fail(err.killed ? `PowerShell timed out after ${timeoutMs} ms`
                                   : shortErr(err));
          }
          let parsed;
          try { parsed = JSON.parse(String(stdout).trim()); }
          catch {
            const tail = redact(String(stderr || stdout || '').trim().split(/\r?\n/)[0] || '');
            return fail('PowerShell returned unparseable output'
                        + (tail ? `: ${tail.slice(0, 120)}` : ''));
          }
          // ConvertTo-Json unwraps single-element arrays into bare objects.
          const arr = v => (Array.isArray(v) ? v : (v ? [v] : []));
          ok({
            ok: true, ms: Date.now() - started,
            tasksOk: parsed.tasksOk === true,
            tasks: arr(parsed.tasks), procs: arr(parsed.procs),
            claude: arr(parsed.claude), ports: arr(parsed.ports),
            errors: arr(parsed.errors).map(e => redact(String(e))),
          });
        }
      );
    } catch (err) {
      return fail(shortErr(err));
    }
    if (child) child.on('error', err => fail(shortErr(err)));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Filesystem probe — the profile's HOLD file, each process's mode literal and
// directory, the scheduler source. Read-only, no .env.
// ═══════════════════════════════════════════════════════════════════════════

function emptyFiles(holdErr, modeErr, schedulerPresent) {
  return { hold: null, holdErr, modes: {}, modeErrs: modeErr ? Object.fromEntries(
             profileProcesses().filter(p => p.modeFile).map(p => [p.id, modeErr])) : {},
           dirs: {}, schedulerPresent };
}

async function probeFiles() {
  const out = emptyFiles(null, null, false);
  const home = PROFILE_HOME;

  const holdPath = PROFILE.hold ? profilePath(PROFILE.hold.path, home) : null;
  if (holdPath) {
    try {
      const raw = await fsp.readFile(holdPath, 'utf8');
      const first = raw.split(/\r?\n/).find(l => l.trim()) || '(empty HOLD file)';
      out.hold = redact(first.trim());
    } catch (err) {
      out.holdErr = err && err.code === 'ENOENT' ? 'absent' : shortErr(err);
    }
  }

  for (const p of profileProcesses()) {
    const mf = p.modeFile;
    if (mf && mf.path && mf.name) {
      try {
        const raw = await fsp.readFile(profilePath(mf.path, home), 'utf8');
        // Only the literal on the NAME = '...' line is ever pulled out. Nothing
        // else from the file is read into the snapshot (it may also hold
        // env-var NAMES for credentials, which stay put).
        const name = String(mf.name).replace(/[^A-Za-z0-9_]/g, '');
        const m = raw.match(new RegExp('^\\s*' + name + '\\s*=\\s*[\'"]([A-Za-z_-]+)[\'"]', 'm'));
        out.modes[p.id] = m ? m[1] : null;
        if (!m) out.modeErrs[p.id] = `${name} literal not found in ${path.basename(mf.path)}`;
      } catch (err) {
        out.modeErrs[p.id] = err && err.code === 'ENOENT'
          ? `${path.basename(mf.path)} absent` : shortErr(err);
      }
    }
    if (p.dir) {
      try { out.dirs[p.id] = fs.statSync(profilePath(p.dir, home)).isDirectory(); }
      catch { out.dirs[p.id] = false; }
    }
  }

  if (STACK_SCHEDULER) {
    try { out.schedulerPresent = fs.statSync(STACK_SCHEDULER).isFile(); } catch { /* absent */ }
  } else {
    out.schedulerPresent = true;   // nothing to check
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 1 — railway
// ═══════════════════════════════════════════════════════════════════════════

function hostOf(origin) {
  try { return new URL(origin).host; } catch { return String(origin || ''); }
}

function httpItem(id, label, origin, res, sub) {
  if (!origin) return item(id, label, 'unknown', 'no public URL found on disk', sub);
  if (!res)    return item(id, label, 'unknown', 'probe did not run', sub);
  const meta = { url: res.url, ms: res.ms, redirects: res.redirects || 0 };
  if (res.status) meta.status = res.status;
  if (res.ok) return item(id, label, 'up', `${res.status} · ${res.ms} ms`, sub, meta);
  if (res.status) return item(id, label, 'down', `HTTP ${res.status} · ${res.ms} ms`, sub, meta);
  return item(id, label, 'down', `${res.error || 'unreachable'} · ${res.ms} ms`, sub, meta);
}

const HEALTH_BODY_LIMIT = 64 * 1024;

/** Recursively scrub a parsed remote payload before it can reach the rail. */
function redactDeep(v, depth = 0) {
  if (depth > 6) return null;
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.slice(0, 50).map(x => redactDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v).slice(0, 50)) o[k] = redactDeep(val, depth + 1);
    return o;
  }
  return v;
}

/**
 * The app's /api/health is read in this shape (anything else is ignored):
 *   { status: 'ok'|'degraded'|'down', role?: 'leader'|'follower',
 *     services?: { <component>: 'ok' | <anything else> } }
 * An app may answer 200 while degraded and 503 only when a critical part is
 * down, so a 200 does NOT by itself mean every component is healthy.
 */
function parseHealthBody(res) {
  if (!res || typeof res.body !== 'string' || !res.body) return null;
  if (res.body.length > HEALTH_BODY_LIMIT) return null;
  try {
    const h = JSON.parse(res.body);
    if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
    return redactDeep(h);
  } catch { return null; }
}

/** [name, reportedValue] for every component not reporting 'ok'. */
function unhealthyComponents(health) {
  const out = [];
  const svc = health && health.services;
  if (svc && typeof svc === 'object' && !Array.isArray(svc)) {
    for (const [k, v] of Object.entries(svc)) {
      if (typeof v === 'string' && v.toLowerCase() !== 'ok') out.push([k, v.toLowerCase()]);
    }
  }
  return out;
}

function buildRailwayGroup(stack, services) {
  const name = text(PROFILE.appLabel, 'App');
  const stackItem = httpItem('stack-web', name, STACK_ORIGIN, stack,
    STACK_ORIGIN ? hostOf(STACK_ORIGIN) + STACK_HEALTH_PATH : `${name} production`);
  const health = parseHealthBody(stack);
  if (health) {
    stackItem.meta = Object.assign({}, stackItem.meta, { health });
    // Round-trip stays first; component failures append after it.
    const bad = unhealthyComponents(health);
    if (bad.length) {
      stackItem.detail = redact(stackItem.detail + bad
        .map(([k, v]) => ` · ${k} ${v === 'error' ? 'down' : v}`).join(''));
    }
  }

  return {
    id: 'railway',
    label: 'Deployed services',
    items: [
      stackItem,
      ...profileServices().map((s, i) => httpItem(s.id, s.label, s.origin, services[i],
        s.origin ? hostOf(s.origin) + s.healthPath : s.fallback)),
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 2 — crons
// ═══════════════════════════════════════════════════════════════════════════

// The schedule rows come from the profile: `crons` (UTC cron expressions;
// `gate: "services"` ties a row to the extra services instead of the main
// app), `intervals` (fixed timers with no wall-clock fire time) and
// `dynamic` (schedules only the app itself can enumerate). A row is "armed"
// only while the process that runs it answers.

function cronItem(id, label, expr, alive, now, extraMeta) {
  const meta = Object.assign({ expr }, extraMeta);
  // A cron inside a dead process is not armed — say so rather than lying.
  if (!alive) return item(id, label, 'unknown', 'host unreachable', `${expr} UTC`, meta);

  let next;
  try { next = nextCronFireUTC(expr, now); }
  catch (err) {
    return item(id, label, 'unknown', `unparseable cron "${expr}"`, shortErr(err), meta);
  }
  if (!next) {
    return item(id, label, 'unknown',
                `no fire time within ${CRON_SEARCH_DAYS} days`, `${expr} UTC`, meta);
  }
  meta.nextRunUtc = next.toISOString();
  // Relative first: the rail truncates detail at ~150px, and "in 1d 11h" is
  // the half that drives a decision. The absolute instant is the detail you
  // go looking for second.
  return item(id, label, 'armed', `${relFromNow(next, now)} · ${fmtUTC(next)}`,
              `${expr} UTC`, meta);
}

function buildCronsGroup(stackUp, servicesUp, servicesKnown, now) {
  const items = list(PROFILE.crons).filter(c => c && c.id && c.expr).map((c) => {
    const svc = c.gate === 'services';
    const meta = { source: c.source };
    if (c.sourceLine != null) meta.sourceLine = c.sourceLine;
    if (!svc) meta.note = c.note;
    meta.leaderElected = !!c.leaderElected;
    return cronItem(c.id, text(c.label, c.id), c.expr,
                    svc ? servicesKnown && servicesUp : stackUp, now, meta);
  });

  const intervalState = stackUp ? 'armed' : 'unknown';
  for (const t of list(PROFILE.intervals).filter(x => x && x.id)) {
    items.push(item(t.id, text(t.label, t.id), intervalState,
                    stackUp ? text(t.every, '') : 'host unreachable',
                    text(t.sub, 'timer, not cron'),
                    { everyMs: t.everyMs, source: t.source, sourceLine: t.sourceLine }));
  }

  // Schedules registered at runtime (e.g. per user): enumerating them needs
  // access we deliberately do not have here, so say that, not a count.
  for (const d of list(PROFILE.dynamic).filter(x => x && x.id)) {
    items.push(item(d.id, text(d.label, d.id),
                    stackUp ? 'armed' : 'unknown',
                    stackUp ? text(d.detail, 'dynamic') : 'host unreachable',
                    text(d.sub, ''),
                    { source: d.source, sourceLine: d.sourceLine }));
  }

  return { id: 'crons', label: text(PROFILE.cronsLabel, 'In-process schedules'), items };
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 3 — windows
// ═══════════════════════════════════════════════════════════════════════════

// WATCHED_TASKS (above) comes from data/config.json `watchedTasks`, in the
// order given. Keep each `id` stable so the rail does not reshuffle.

// Schedule.Service COM TASK_STATE enum -> our vocabulary.
// 0 Unknown · 1 Disabled · 2 Queued · 3 Ready · 4 Running
const TASK_STATE_NAME = { 0: 'Unknown', 1: 'Disabled', 2: 'Queued', 3: 'Ready', 4: 'Running' };
const TASK_STATE_MAP  = { Ready: 'armed', Queued: 'armed', Running: 'up',
                          Disabled: 'disabled', Unknown: 'unknown' };

/**
 * Names the Windows LastTaskResult codes we recognise. The COM API hands these
 * back as SIGNED int32, so 0xC000013A arrives as -1073741510 — normalise to
 * unsigned before comparing or the well-known codes never match.
 */
function describeResult(code) {
  if (code == null) return 'never run';
  let n = Number(code);
  if (!Number.isFinite(n)) return String(code);
  if (n < 0) n = n >>> 0;
  if (n === 0) return 'ok';
  if (n === 267011) return 'not yet run';
  if (n === 267009) return 'currently running';
  if (n === 267014) return 'terminated by user';
  if (n === 2147942401) return 'exit 1';
  if (n === 2147942402) return 'file not found';
  if (n === 3221225786) return 'ctrl-c (0xC000013A)';
  return `exit 0x${n.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Local-time rendering — Task Scheduler reports in local time, not UTC. */
function fmtLocal(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = n => String(n).padStart(2, '0');
  return `${DOW_NAMES[d.getDay()]} ${p(d.getDate())} ${MON_NAMES[d.getMonth()]}`
       + ` ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Date only, no clock time — used for the last-run half of a task detail,
 *  which sits past the rail's ellipsis boundary and only needs to say
 *  roughly when, not to the minute. */
function fmtLocalDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = n => String(n).padStart(2, '0');
  return `${DOW_NAMES[d.getDay()]} ${p(d.getDate())} ${MON_NAMES[d.getMonth()]}`;
}

function buildWindowsGroup(win) {
  // A failed probe degrades to ONE unknown item — never to a wall of six
  // fabricated "not found" rows, which would read as "the tasks were deleted".
  if (!win || !win.ok || win.tasksOk === false) {
    return {
      id: 'windows', label: 'Scheduled tasks',
      items: [item('task-probe', 'Task Scheduler', 'unknown',
                   (win && win.error) || 'could not enumerate scheduled tasks',
                   'PowerShell / Schedule.Service probe failed')],
    };
  }

  const byName = new Map();
  for (const t of win.tasks) if (t && t.name) byName.set(t.name, t);

  const items = WATCHED_TASKS.map(w => {
    const t = byName.get(w.taskName);
    if (!t) {
      return item(w.id, w.label, 'unknown', 'task not found on this machine',
                  w.taskName, { taskName: w.taskName });
    }
    const stateName = TASK_STATE_NAME[t.state] || 'Unknown';
    const state     = TASK_STATE_MAP[stateName] || 'unknown';
    const lastWhen  = fmtLocalDate(t.lastRun);
    const nextWhen  = fmtLocal(t.nextRun);
    // Next-run leads: it is the half that answers 'is this going to happen?'.
    // A disabled task keeps reporting a NextRunTime it will never honour, so
    // do not dress that up as a schedule.
    const nextTxt = state === 'disabled'
      ? 'disabled'
      : (nextWhen ? `next ${nextWhen}` : 'no next run');
    const lastTxt = (t.lastRun == null && t.lastResult == null)
      ? 'never run'
      : `last ${describeResult(t.lastResult)}${lastWhen ? ` ${lastWhen}` : ''}`;
    const detail = `${nextTxt} · ${lastTxt}`;
    // State and missed-run count live in meta now; sub stays short so the
    // rail carries one unambiguous identifier under the label.
    return item(w.id, w.label, state, detail, w.taskName, {
      taskName: t.name,
      taskState: stateName,
      LastRunTime: t.lastRun || null,
      NextRunTime: t.nextRun || null,
      LastTaskResult: t.lastResult == null ? null : (t.lastResult >>> 0),
      NumberOfMissedRuns: t.missed == null ? null : t.missed,
    });
  });

  return { id: 'windows', label: 'Scheduled tasks', items };
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 4 — local
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Matches a process command line against a project WITHOUT emitting it — a
 * command line can carry flags and paths we have no business surfacing, so
 * only the matched script basename ever escapes this function.
 */
function matchProc(procs, { dirNeedle, scripts }) {
  for (const p of procs) {
    const cmd = String(p && p.cmd ? p.cmd : '').toLowerCase();
    if (!cmd) continue;
    if (dirNeedle && !cmd.includes(dirNeedle.toLowerCase())) continue;
    if (scripts && scripts.length) {
      const hit = scripts.find(s => cmd.includes(s.toLowerCase()));
      if (!hit) continue;
      return { proc: p, script: hit };
    }
    return { proc: p, script: null };
  }
  return null;
}

function buildLocalGroup(win, files, now) {
  const items = [];
  const psOk  = !!(win && win.ok);
  const procs = psOk ? win.procs : [];
  const ports = psOk ? win.ports : [];
  const psErr = (win && win.error) || 'PowerShell probe failed';

  // ── node / python processes ──────────────────────────────────────────────
  if (!psOk) {
    items.push(item('local-processes', 'Node / Python', 'unknown', psErr));
  } else if (!procs.length) {
    items.push(item('local-processes', 'Node / Python', 'idle',
                    'none running', 'node · python · py · pythonw',
                    { count: 0, byName: {}, oldestStart: null, pids: [] }));
  } else {
    const byName = {};
    let oldest = null;
    for (const p of procs) {
      const nm = String(p.name || 'unknown').replace(/\.exe$/i, '');
      byName[nm] = (byName[nm] || 0) + 1;
      if (p.start) {
        const t = new Date(p.start);
        if (!Number.isNaN(t.getTime()) && (!oldest || t < oldest)) oldest = t;
      }
    }
    const names = Object.entries(byName).map(([n, c]) => `${c}x ${n}`).join(' · ');
    items.push(item('local-processes', 'Node / Python', 'up',
                    `${procs.length} running`
                    + (oldest ? ` · oldest up ${relSince(oldest, now)}` : ''),
                    names, {
      count: procs.length, byName,
      oldestStart: oldest ? oldest.toISOString() : null,
      pids: procs.map(p => p.pid),
    }));
  }

  // ── Claude Code sessions ─────────────────────────────────────────────────
  // Matched and counted inside PowerShell so no CLI command line ever crosses
  // into this process. Only pids and start times come back.
  const claudes = psOk ? (win.claude || []) : [];
  if (!psOk) {
    items.push(item('claude-sessions', 'Claude Code sessions', 'unknown', psErr));
  } else if (!claudes.length) {
    items.push(item('claude-sessions', 'Claude Code sessions', 'idle', 'none running',
                    'claude.exe · cwd not exposed',
                    { count: 0, pids: [], oldestStart: null }));
  } else {
    let oldestC = null;
    for (const c of claudes) {
      if (!c.start) continue;
      const t = new Date(c.start);
      if (!Number.isNaN(t.getTime()) && (!oldestC || t < oldestC)) oldestC = t;
    }
    items.push(item('claude-sessions', 'Claude Code sessions', 'up',
                    `${claudes.length} running`
                    + (oldestC ? ` · oldest up ${relSince(oldestC, now)}` : ''),
                    'claude.exe · cwd not exposed', {
      count: claudes.length,
      pids: claudes.map(c => c.pid),
      oldestStart: oldestC ? oldestC.toISOString() : null,
    }));
  }

  // ── listening ports (< 10000, owned by node/python) ──────────────────────
  if (!psOk) {
    items.push(item('local-ports', 'Listening ports', 'unknown', psErr));
  } else {
    const uniq = new Map();
    for (const p of ports) if (!uniq.has(p.port)) uniq.set(p.port, p);
    const list = [...uniq.values()].sort((a, b) => a.port - b.port);
    if (!list.length) {
      items.push(item('local-ports', 'Listening ports', 'idle', 'none',
                      'node/python only, ports < 10000', { ports: [] }));
    } else {
      items.push(item('local-ports', 'Listening ports', 'up',
                      list.map(p => `${p.port} (${String(p.proc).replace(/\.exe$/i, '')})`).join(' · '),
                      `${list.length} listening · node/python, ports < 10000`,
                      { ports: list.map(p => ({ port: p.port, proc: p.proc, pid: p.pid })) }));
    }
  }

  // Everything below is the optional stack module's project rows.
  if (!P) return { id: 'local', label: 'This machine', items };

  // ── HOLD file (profile.hold) ─────────────────────────────────────────────
  const H = PROFILE.hold;
  if (H && H.path) {
    const holdFile = profilePath(H.path, PROFILE_HOME);
    const hid = text(H.id, 'hold'), hlabel = text(H.label, 'HOLD file'), holdSub = text(H.sub, '');
    if (files.hold) {
      items.push(item(hid, hlabel, 'hold', files.hold, holdSub, { holdFile }));
    } else if (files.holdErr === 'absent') {
      items.push(item(hid, hlabel, 'idle', 'no HOLD file', holdSub, { holdFile }));
    } else {
      items.push(item(hid, hlabel, 'unknown',
                      `HOLD unreadable: ${files.holdErr}`, holdSub, { holdFile }));
    }
  }

  // ── resident processes (profile.processes) ───────────────────────────────
  for (const p of profileProcesses()) items.push(processItem(p, files, procs, psOk, psErr, now));

  return { id: 'local', label: 'This machine', items };
}

/* One profile process row. With a modeFile, the literal it reads becomes the
   row's sub-line (and meta[modeFile.metaKey]); with a dir, the sub-line says
   whether that directory exists. */
function processItem(p, files, procs, psOk, psErr, now) {
  const label = text(p.label, p.id);
  const mf = p.modeFile;
  let sub = '';
  let modeMeta = null;
  if (mf) {
    const mode = files.modes[p.id];
    const key = text(mf.metaKey, 'mode');
    modeMeta = { [key]: mode == null ? null : mode };
    sub = mode
      ? (mf.liveValue && mode.toLowerCase() === String(mf.liveValue).toLowerCase() && mf.liveSub
          ? mf.liveSub
          : `${mf.name} = ${mode}`)
      : `${mf.name} unknown (${files.modeErrs[p.id] || 'not read'})`;
  } else if (p.dir) {
    sub = files.dirs[p.id] ? text(p.dirSub, '') : text(p.noDirSub, `${p.dir} not found on disk`);
  }
  const scripts = Array.isArray(p.scripts) && p.scripts.length ? p.scripts : null;
  const hit = psOk ? matchProc(procs, { dirNeedle: p.dirNeedle || p.id, scripts }) : null;
  if (!psOk) {
    return item(p.id, label, 'unknown', 'process state unknown — ' + psErr, sub,
                modeMeta || undefined);
  }
  if (hit) {
    const up = hit.proc.start ? ` · up ${relSince(new Date(hit.proc.start), now)}` : '';
    return item(p.id, label, 'up',
                (scripts ? `running ${hit.script} · pid ${hit.proc.pid}` : `running · pid ${hit.proc.pid}`) + up,
                sub,
                Object.assign({}, modeMeta, { pid: hit.proc.pid },
                              scripts ? { script: hit.script } : {},
                              { start: hit.proc.start || null }));
  }
  return item(p.id, label, 'idle', text(p.idleDetail, 'no process'), sub,
              Object.assign({}, modeMeta, { pid: null }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  default 4000 — per-probe hard timeout
 * @returns {Promise<InfraSnapshot>}
 */
async function scanInfra(opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.floor(opts.timeoutMs) : 4000;
  const t0  = Date.now();
  const now = new Date();
  const errors = [];

  const cfg = resolveScanSettings(opts);
  applyProjects(cfg.projects, cfg.watchedTasks);

  const join = (origin, p) => origin ? origin.replace(/\/+$/, '') + (p || '/') : null;
  const stackUrl      = join(STACK_ORIGIN, STACK_HEALTH_PATH);
  const services      = P ? profileServices() : [];
  const serviceUrls   = services.map(sv => join(sv.origin, sv.healthPath || '/'));
  const appName       = text(PROFILE.appLabel, 'App');

  // Every probe is individually guarded. withTimeout() is a hard backstop in
  // case a probe's own timeout is somehow bypassed (a wedged DNS resolver, a
  // PowerShell process that outlives SIGKILL, ...). Nothing here can reject,
  // so scanInfra always resolves inside roughly timeoutMs + a small margin.
  const guard = (p, fallback) => withTimeout(p, timeoutMs + 250, fallback);
  const httpJob = (url, collectBody = 0) => url
    ? guard(httpProbe(url, { timeoutMs, collectBody }),
            { ok: false, error: 'probe exceeded hard timeout', ms: timeoutMs, url })
    : Promise.resolve(null);

  const settled = await Promise.allSettled([
    // Only the main app's health body is read; extra services stay drain-only.
    httpJob(stackUrl, HEALTH_BODY_LIMIT),
    guard(probeWindows(timeoutMs),
          { ok: false, tasksOk: false, error: 'PowerShell exceeded hard timeout',
            tasks: [], procs: [], claude: [], ports: [], errors: [] }),
    !P ? Promise.resolve(emptyFiles('absent', null, true))
       : guard(probeFiles(), emptyFiles('timed out', 'timed out', false)),
    ...serviceUrls.map(u => httpJob(u)),
  ]);

  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'rejected') {
      errors.push(`probe ${i} rejected unexpectedly: ${shortErr(settled[i].reason)}`);
    }
  }
  const val = (i, dflt) => settled[i].status === 'fulfilled' ? settled[i].value : dflt;

  const stack      = val(0, null);
  const win        = val(1, { ok: false, tasksOk: false, error: 'probe unavailable',
                              tasks: [], procs: [], claude: [], ports: [], errors: [] });
  const files      = val(2, emptyFiles('probe unavailable', 'probe unavailable', false));
  const svcResults = services.map((_, i) => val(3 + i, null));

  // ── surface probe failures as human-readable errors ──────────────────────
  if (stack && !stack.ok) {
    errors.push(`${appName} probe failed: ${stack.error || `HTTP ${stack.status}`} (${stackUrl})`);
  }
  if (services.length && !services.some(sv => sv.origin)) {
    errors.push(text(PROFILE.servicesMissing, 'extra services: no public URL configured'));
  }
  services.forEach((sv, i) => {
    const r = svcResults[i];
    if (r && !r.ok) errors.push(`${sv.label} probe failed: ${r.error || `HTTP ${r.status}`}`);
  });
  if (!win.ok) errors.push(`Windows probe failed: ${win.error || 'unknown reason'}`);
  for (const e of (win.errors || [])) errors.push(`Windows probe: ${e}`);
  if (P && PROFILE.hold && files.holdErr && files.holdErr !== 'absent') {
    errors.push(`${text(PROFILE.hold.errorPrefix, 'HOLD')}: ${files.holdErr}`);
  }
  if (P) {
    for (const pr of profileProcesses()) {
      const e = files.modeErrs[pr.id];
      if (e) errors.push(`${text(pr.modeFile && pr.modeFile.errorPrefix, pr.id + ' mode file')}: ${e}`);
    }
  }
  if (P && !files.schedulerPresent) {
    errors.push(`${appName} scheduler source not found at ${STACK_SCHEDULER} — cron `
              + 'expressions below are from the last verified read and may be stale');
  }

  const stackUp       = !!(stack && stack.ok);
  // Rows gated on the extra services: any one of them answering is enough
  // to call the platform that runs them alive.
  const servicesKnown = services.some(sv => sv.origin);
  const servicesUp    = svcResults.some(r => r && r.ok);

  return {
    generatedAt: now.toISOString(),
    scanMs: Date.now() - t0,
    errors: errors.map(e => redact(String(e))),
    // Order is presentation, not dependency — every group is built from data
    // already resolved above. "This machine" sits second because it is the
    // live stuff; the 14 schedule rows below it are reference, not news.
    // With the stack module off only the generic groups remain, and the
    // task group only when data/config.json lists watchedTasks.
    groups: (P
      ? [
          buildRailwayGroup(stack, svcResults),
          buildLocalGroup(win, files, now),
          buildCronsGroup(stackUp, servicesUp, servicesKnown, now),
          buildWindowsGroup(win),
        ]
      : [
          buildLocalGroup(win, files, now),
          WATCHED_TASKS.length ? buildWindowsGroup(win) : null,
        ]).filter(Boolean),
  };
}

module.exports = { scanInfra };

// Exported for the dashboard's own tests / reuse. NOT part of the fixed
// contract above — nothing in the UI should depend on these.
module.exports._internals = {
  nextCronFireUTC, parseCron, relFromNow, relSince, fmtUTC, redact, httpProbe,
  withTimeout, describeResult,
};

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

if (require.main === module) {
  const GLYPH = { up: '\u25cf', down: '\u2717', armed: '\u25c6', idle: '\u25cb',
                  disabled: '\u2013', hold: '\u2016', unknown: '?' };
  scanInfra().then(snap => {
    process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
    const err = s => process.stderr.write(s + '\n');
    err('');
    err(`mission-control · infra · ${snap.generatedAt} · ${snap.scanMs} ms`);
    for (const g of snap.groups) {
      err('');
      err(`-- ${g.label} (${g.id})`);
      for (const it of g.items) {
        err(`   ${GLYPH[it.state] || '?'} ${it.state.padEnd(8)} `
          + `${it.label.padEnd(28)} ${it.detail}`);
      }
    }
    if (snap.errors.length) {
      err('');
      err(`-- errors (${snap.errors.length})`);
      for (const e of snap.errors) err(`   ! ${e}`);
    }
    err('');
  }).catch(e => {
    // scanInfra is designed never to reject; this exists only so that a bug
    // here is loud rather than silent.
    process.stderr.write('scanInfra rejected (this is a bug): '
                       + ((e && e.stack) || e) + '\n');
    process.exitCode = 1;
  });
}
