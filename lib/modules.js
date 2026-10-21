'use strict';
/**
 * mission-control / lib/modules.js
 * ---------------------------------------------------------------------------
 * Optional modules and per-machine settings, read from data/config.json.
 *
 * The repo ships with every project-specific probe OFF. The author's own
 * dashboard turns them on from his untracked data/config.json, so one
 * codebase serves both: a stranger gets the generic agents + machine view, and
 * nothing in the tracked code names a private host or path.
 *
 *   {
 *     "watchedTasks": [ { "id": "task-backup", "taskName": "Nightly Backup",
 *                         "label": "Nightly backup" } ],
 *     "modules": {
 *       "stack": {
 *         "enabled": true,
 *         "baseUrl": "https://app.example.com",   // deployed origin (required)
 *         "root": "~/src/my-app",                  // local checkout
 *         "localPort": 3000,                       // local dev server
 *         "label": "My app",                       // display name (default "Stack")
 *         "profile": "data/my-app.profile.local.js", // optional map profile
 *                            // module (~ and repo-relative paths allowed);
 *                            // without one the built-in profile draws the
 *                            // map from "map" below
 *         "map": { ... },    // built-in profile input (see lib/stack.js)
 *         "formerIds": [],   // ids this module had before a rename; the
 *                            // UI carries saved view/feed state over from them
 *         "infra": { ... }   // optional rail profile: extra services,
 *                            // schedules, HOLD file, processes (see
 *                            // data/config.example.json)
 *       }
 *     }
 *   }
 *
 * Read once at boot (modules are wired into timers and routes, so a change
 * needs a restart). Pure: no side effects beyond reading the one file, and it
 * never throws - a broken config means "everything optional is off" plus a
 * reason, never a dead dashboard.
 *
 * Zero npm dependencies. CommonJS. Node 20+.
 */

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const DISABLED_DEFAULT = 'not enabled in data/config.json (modules.stack.enabled)';
const DEFAULT_LABEL = 'Stack';
const LABEL_MAX = 24;

/** Display name for the module: printable ASCII, trimmed, capped. */
function resolveLabel(x) {
  if (typeof x !== 'string') return DEFAULT_LABEL;
  const s = x.replace(/[^\x20-\x7e]/g, '').trim().slice(0, LABEL_MAX).trim();
  return s || DEFAULT_LABEL;
}

/** Earlier module ids (lowercase a-z, 0-9, dash), for UI state migration. */
function resolveFormerIds(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    if (typeof x !== 'string') continue;
    const id = x.trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) && id !== 'stack' && !out.includes(id)) out.push(id);
  }
  return out;
}

/** A profile module path: "~" expands to home, a relative path is relative
    to the repo root (the folder above lib/). Anything else is null. */
function resolveProfilePath(p, home) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const s = expandHome(p.trim(), home);
  return path.isAbsolute(s) ? path.normalize(s) : path.join(__dirname, '..', s);
}

/** "~" or "~/x" -> the home directory; anything else is returned as-is. */
function expandHome(p, home) {
  const h = home || os.homedir();
  const s = String(p);
  if (s === '~') return h;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(h, s.slice(2));
  return s;
}

function isObj(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function httpOrigin(x) {
  if (typeof x !== 'string' || !x.trim()) return null;
  try {
    const u = new URL(x.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return x.trim().replace(/\/+$/, '');
  } catch (_) {
    return null;
  }
}

/** The optional infra rail profile (modules.stack.infra). Service origins
    that are not http(s) URLs become null; the rest is passed through. */
function resolveInfraProfile(p) {
  if (!isObj(p)) return null;
  const out = Object.assign({}, p);
  if (Array.isArray(p.services)) {
    out.services = p.services.filter(isObj).map(s => Object.assign({}, s, { origin: httpOrigin(s.origin) }));
  }
  return out;
}

/** Task Scheduler entries for the infra rail. Invalid rows are dropped. */
function resolveWatchedTasks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const t of list) {
    if (!isObj(t) || typeof t.taskName !== 'string' || !t.taskName.trim()) continue;
    const taskName = t.taskName.trim();
    const id = typeof t.id === 'string' && t.id.trim()
      ? t.id.trim()
      : 'task-' + taskName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, taskName, label: typeof t.label === 'string' && t.label.trim() ? t.label.trim() : taskName });
  }
  return out;
}

/**
 * Turn a parsed config object (or null) into the resolved module set.
 * @param {object|null} cfg
 * @param {object} [opts]  { home } - override os.homedir() (tests)
 */
function resolveModules(cfg, opts = {}) {
  const home = opts.home || os.homedir();
  const out = {
    stack: { enabled: false, reason: DISABLED_DEFAULT, label: DEFAULT_LABEL, formerIds: [],
             scan: null, infra: null },
    watchedTasks: [],
  };
  if (!isObj(cfg)) return out;

  out.watchedTasks = resolveWatchedTasks(cfg.watchedTasks);

  const a = isObj(cfg.modules) ? cfg.modules.stack : null;
  if (isObj(a)) {
    out.stack.label = resolveLabel(a.label);
    out.stack.formerIds = resolveFormerIds(a.formerIds);
  }
  if (!isObj(a) || a.enabled !== true) return out;

  const baseUrl = httpOrigin(a.baseUrl);
  if (!baseUrl) {
    out.stack.reason = 'modules.stack.enabled is true but modules.stack.baseUrl is not an http(s) URL';
    return out;
  }
  const root = typeof a.root === 'string' && a.root.trim()
    ? expandHome(a.root.trim(), home)
    : null;
  const localPort = Number.isInteger(a.localPort) && a.localPort > 0 && a.localPort < 65536
    ? a.localPort : 3000;

  const label = out.stack.label;
  out.stack = {
    enabled: true,
    reason: null,
    label,
    formerIds: out.stack.formerIds,
    // Passed straight to lib/stack.js scanStack().
    scan: {
      baseUrl, stackRoot: root, localPort, label,
      profile: resolveProfilePath(a.profile, home),
      map: isObj(a.map) ? a.map : null,
    },
    // Passed to lib/infra.js scanInfra() as opts.projects.
    infra: {
      stackOrigin: baseUrl,
      stackRoot: root,
      profile: resolveInfraProfile(a.infra),
      home,
    },
  };
  return out;
}

/**
 * Read and resolve a config file. Never throws.
 * @returns {{ modules: object, error: string|null, file: string }}
 */
function loadModules(file, opts = {}) {
  let cfg = null;
  let error = null;
  try {
    if (fs.existsSync(file)) {
      let raw = fs.readFileSync(file, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // BOM from Notepad
      cfg = JSON.parse(raw);
    }
  } catch (err) {
    error = (err && err.message) || String(err);
    cfg = null;
  }
  const modules = resolveModules(cfg, opts);
  if (error && !modules.stack.enabled) {
    modules.stack.reason = 'data/config.json unreadable: ' + error;
  }
  return { modules, error, file };
}

module.exports = { loadModules, resolveModules, resolveWatchedTasks, expandHome,
                   resolveLabel, resolveFormerIds, resolveProfilePath, DEFAULT_LABEL };
