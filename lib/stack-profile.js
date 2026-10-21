'use strict';
/**
 * mission-control / lib/stack-profile.js
 * ---------------------------------------------------------------------------
 * The BUILT-IN profile for lib/stack.js: a reasonable system map of any web
 * app, built from a plain config object (modules.stack.map in
 * data/config.json) with no code. For a map that needs code, write a profile
 * module instead and point modules.stack.profile at it (interface in the
 * header of lib/stack.js).
 *
 *   module.exports = { makeProfile, DEFAULT_TIERS }
 *   makeProfile(map | null) -> profile object (tiers, builders, edges, paths, prodRef)
 *
 * What it draws, tier by tier (ids are fixed, or come from the map):
 *   edge     edge-origin       TLS + HTTP GET <host><health path>
 *            <configFlags>     presence of a key in the config endpoint's JSON
 *                              (the value is never copied out)
 *   runtime  rt-version        the version endpoint: commit, version, node
 *   app      app-health        the health endpoint's overall `status`
 *            <services>        one per key of the health JSON's `services`
 *            <subsystems>      no health field of their own; inherit from one
 *   deps     <deps>            "wired" third-party services, or inferred from
 *                              a node of the map (inferFrom)
 *   jobs     <crons>           next fire time from the cron expression (UTC)
 *            <intervals>       repeating timers: how often, no fire time
 *   local    loc-checkout      git state of the checkout vs the deploy ref
 *            loc-devserver     is anything listening on localPort, does it answer
 *
 * Edges drawn automatically: edge-origin -> rt-version (serves), rt-version ->
 * app-health (runs), app-health -> each service (runs), a service -> each
 * subsystem that inherits from it (runs), inferFrom node -> dep (uses),
 * loc-checkout -> rt-version (deploys), loc-devserver -> loc-checkout (runs).
 * map.edges adds the rest; an edge naming an unknown id is dropped by the
 * engine with an error line.
 *
 * The map (every key optional; a null map gives the minimal map above):
 *
 *   "map": {
 *     "prodRef": "origin/main",           // deployed ref; default origin/HEAD
 *     "paths":   { "config": null },      // override / skip probe paths
 *     "runtime": { "label": "Web service", "sub": "container host" },
 *     "checkoutLabel": "App checkout",
 *     "services": [
 *       { "id": "app-db",    "key": "database", "label": "Database",
 *         "critical": true, "sub": "connection pool + query check" },
 *       { "id": "app-queue", "key": "queue",    "label": "Job queue" }
 *     ],
 *     "subsystems": [
 *       { "id": "app-mail", "label": "Outbound mail", "parent": "queue",
 *         "detail": "receipts and resets", "sub": "worker process" },
 *       { "id": "app-legacy", "label": "Legacy importer", "parent": "queue",
 *         "forced": "disabled", "forcedDetail": "switched off" }
 *     ],
 *     "configFlags": [
 *       { "id": "edge-captcha", "key": "captchaSiteKey", "label": "Bot check",
 *         "sub": "public site key presence" }
 *     ],
 *     "deps": [
 *       { "id": "dep-db",   "label": "Database host", "inferFrom": "app-db",
 *         "detail": "managed database" },
 *       { "id": "dep-mail", "label": "Mail provider", "detail": "transactional email",
 *         "sub": "HTTP API" }
 *     ],
 *     "crons": [
 *       { "id": "job-export", "label": "Nightly export", "expr": "30 3 * * *",
 *         "source": "jobs/export.js", "leaderElected": true }
 *     ],
 *     "intervals": [
 *       { "id": "job-sweep", "label": "Queue sweep", "everyMs": 60000,
 *         "text": "every 60 s", "source": "jobs/sweep.js" }
 *     ],
 *     "edges": [ ["app-mail", "dep-mail", "notifies"],
 *                ["app-queue", "job-sweep", "schedules"],
 *                ["job-export", "app-db", "uses"] ]
 *   }
 *
 * The map is configuration, not code: it is read, never executed. Strings
 * from it pass through the engine's node() like everything else.
 *
 * Zero npm dependencies. CommonJS. Node 20+.
 */

const fs = require('node:fs');

const DEFAULT_TIERS = [
  { id: 'edge',    label: 'Edge' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'app',     label: 'App' },
  { id: 'deps',    label: 'Depends on' },
  { id: 'jobs',    label: 'Jobs' },
  { id: 'local',   label: 'This machine' },
];

const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x, fb = '') => (typeof x === 'string' && x.trim() ? x.trim() : fb);
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const list = (x, keep) => (Array.isArray(x) ? x.filter(e => isObj(e) && keep(e)) : []);

/** Normalise the map once, so builders never meet a malformed entry. */
function normalise(map) {
  const m = isObj(map) ? map : {};
  const hasId = e => typeof e.id === 'string' && ID_RE.test(e.id);
  const paths = {};
  if (isObj(m.paths)) {
    for (const k of ['health', 'version', 'config', 'incidents']) {
      const v = m.paths[k];
      if (v === null) paths[k] = null;
      else if (typeof v === 'string' && v.startsWith('/')) paths[k] = v;
    }
  }
  return {
    prodRef: str(m.prodRef, null),
    paths,
    runtime: isObj(m.runtime) ? m.runtime : {},
    checkoutLabel: str(m.checkoutLabel, 'Checkout'),
    services: list(m.services, e => hasId(e) && typeof e.key === 'string'),
    subsystems: list(m.subsystems, e => hasId(e)),
    configFlags: list(m.configFlags, e => hasId(e) && typeof e.key === 'string'),
    deps: list(m.deps, e => hasId(e)),
    crons: list(m.crons, e => hasId(e) && typeof e.expr === 'string'),
    intervals: list(m.intervals, e => hasId(e) && Number.isFinite(e.everyMs) && e.everyMs > 0),
    edges: Array.isArray(m.edges)
      ? m.edges.filter(e => Array.isArray(e) && typeof e[0] === 'string'
                           && typeof e[1] === 'string')
      : [],
  };
}

function healthDetail(value, reachable, healthPath, h) {
  if (!reachable) return 'host unreachable';
  if (value == null) return `not reported by ${healthPath}`;
  const v = String(value).toLowerCase();
  if (v === 'ok') return 'ok';
  if (v === 'error' || v === 'down' || v === 'fail') return 'error - reported down';
  return `reported "${h.clamp(v, 24)}"`;
}

function makeProfile(rawMap) {
  const M = normalise(rawMap);

  // -- edge -----------------------------------------------------------------
  function buildEdge(ctx, h) {
    const { node, clamp, DOT, DETAIL_MAX } = h;
    const nodes = [];
    const r = ctx.health;
    const cf = !!(r && r.headers && (r.headers['cf-ray']
                  || /cloudflare/i.test(r.headers.server || '')));
    const via = cf ? DOT + 'cloudflare' : '';
    let state = 'unknown', detail;
    if (!r || !r.reached) {
      detail = `${(r && r.error) || 'unreachable'}${DOT}${ctx.host}`;
    } else if (r.status >= 500) {
      state = 'down';     detail = `HTTP ${r.status} in ${r.ms} ms${via}`;
    } else if (r.status >= 400) {
      state = 'degraded'; detail = `HTTP ${r.status} in ${r.ms} ms${via}`;
    } else {
      state = 'up';       detail = `${r.status} in ${r.ms} ms${via}`;
    }
    nodes.push(node('edge-origin', 'edge', ctx.host, state, detail,
      `TLS + HTTP GET ${ctx.host}${ctx.paths.health}`, 'probe', {
        url: ctx.healthUrl, status: r ? r.status : 0, ms: r ? r.ms : null,
        cloudflare: cf,
        server: r && r.headers ? (r.headers.server || null) : null,
      }));

    // Presence of a config key only - its value never leaves this function.
    const c = ctx.config;
    const cfg = c && isObj(c.json) ? c.json : null;
    for (const f of M.configFlags) {
      const sub = str(f.sub, 'config key presence') + DOT + 'value never read';
      if (!cfg) {
        nodes.push(node(f.id, 'edge', str(f.label, f.id), 'unknown',
          !ctx.urls.config ? 'config probe disabled'
            : c && c.reached ? clamp(c.error || `could not read ${ctx.paths.config}`, DETAIL_MAX)
            : 'host unreachable',
          sub, 'config', { key: f.key }));
        continue;
      }
      const v = cfg[f.key];
      const present = v === true || (typeof v === 'string' && v.length > 0)
                   || (typeof v === 'number' && v !== 0);
      nodes.push(node(f.id, 'edge', str(f.label, f.id), present ? 'armed' : 'disabled',
        present ? 'present' : 'absent or empty', sub, 'config',
        { key: f.key, present, cacheAgeMs: c.cached ? c.cacheAgeMs : 0 }));
    }
    return nodes;
  }

  // -- runtime --------------------------------------------------------------
  function buildRuntime(ctx, h) {
    const { node, clamp, DOT } = h;
    const v = ctx.version;
    const vj = v && isObj(v.json) ? v.json : null;
    let state, detail;
    if (!ctx.reachable) {
      state = 'unknown';
      detail = (ctx.health && ctx.health.error) || 'host unreachable';
    } else if (!ctx.urls.version) {
      state = 'idle';
      detail = 'reachable' + DOT + 'version probe disabled';
    } else if (!vj) {
      state = 'degraded';
      detail = 'reachable' + DOT + clamp((v && v.error) || `${ctx.paths.version} unreadable`, 34);
    } else {
      state = 'up';
      const bits = [];
      if (ctx.deployedCommit) bits.push(ctx.deployedCommit);
      if (vj.version && vj.version !== 'unknown') bits.push('v' + String(vj.version).replace(/^v/, ''));
      if (vj.node) bits.push(String(vj.node));
      detail = bits.join(DOT) || 'deployed';
    }
    return [node('rt-version', 'runtime', str(M.runtime.label, 'Deployed version'),
      state, detail,
      str(M.runtime.sub, 'deployed build') + DOT + 'from ' + (ctx.paths.version || 'no version probe'),
      'version', {
        commit: ctx.deployedCommit,
        appVersion: vj ? vj.version || null : null,
        node: vj ? vj.node || null : null,
        cacheAgeMs: v && v.cached ? v.cacheAgeMs : 0,
      })];
  }

  // -- app ------------------------------------------------------------------
  function buildApp(ctx, h) {
    const { node, DOT, healthState } = h;
    const nodes = [];
    const hj = ctx.hj;
    const svc = hj && isObj(hj.services) ? hj.services : null;

    const overall = hj ? String(hj.status == null ? '' : hj.status).toLowerCase() : '';
    let state = 'unknown', detail = 'host unreachable';
    if (ctx.health && ctx.health.reached && !hj) {
      state = ctx.health.status >= 500 ? 'down' : 'degraded';
      detail = `HTTP ${ctx.health.status}` + DOT + 'no readable JSON';
    } else if (ctx.reachable) {
      state = overall === 'ok' ? 'up' : overall === 'down' || overall === 'error' ? 'down'
            : 'degraded';
      detail = overall ? `status "${h.clamp(overall, 20)}"` : 'no status field';
      if (ctx.health.status >= 500 && state === 'up') state = 'degraded';
    }
    nodes.push(node('app-health', 'app', 'Health endpoint', state, detail,
      `${ctx.paths.health}` + DOT + `HTTP ${ctx.health ? ctx.health.status : 0}`, 'health',
      { reported: hj && hj.status != null ? String(hj.status) : null,
        services: svc ? Object.keys(svc).length : 0 }));

    const reachable = ctx.reachable && !!svc;
    for (const s of M.services) {
      const raw = svc ? svc[s.key] : undefined;
      nodes.push(node(s.id, 'app', str(s.label, s.key), healthState(raw, reachable),
        healthDetail(raw, reachable, ctx.paths.health, h),
        str(s.sub, 'health.services.' + s.key)
          + (s.critical ? DOT + 'critical' : ''),
        'health', { healthKey: s.key, reported: raw == null ? null : String(raw),
                    critical: !!s.critical }));
    }

    for (const s of M.subsystems) {
      const parent = str(s.parent, null);
      const parentRaw = svc && parent ? svc[parent] : undefined;
      const forced = typeof s.forced === 'string' && h.STATES.has(s.forced) ? s.forced : null;
      let st, d;
      if (forced) { st = forced; d = str(s.forcedDetail, str(s.detail, forced)); }
      else if (!reachable) { st = 'unknown'; d = 'host unreachable'; }
      else if (!parent) { st = 'wired'; d = str(s.detail, 'no health field'); }
      else {
        st = String(parentRaw).toLowerCase() === 'ok' ? 'up' : 'degraded';
        d = str(s.detail, 'inherits from health.' + parent);
      }
      nodes.push(node(s.id, 'app', str(s.label, s.id), st, d,
        str(s.sub, 'subsystem') + (forced || !parent ? '' : DOT + 'state from health.' + parent),
        'static', { inheritsFrom: forced ? null : parent,
                    parentReported: parentRaw == null ? null : String(parentRaw),
                    forced, probe: 'none - not independently observable' }));
    }
    return nodes;
  }

  // -- deps -----------------------------------------------------------------
  function buildDeps(ctx, h) {
    const { node, DOT } = h;
    return M.deps.map(d => {
      const from = str(d.inferFrom, null);
      const src = from ? ctx.byId.get(from) : null;
      if (src) {
        return node(d.id, 'deps', str(d.label, d.id), src.state,
          str(d.detail, 'inferred'), str(d.sub, 'third-party service')
            + DOT + 'state inferred from ' + from,
          'health', { inferredFrom: from });
      }
      return node(d.id, 'deps', str(d.label, d.id), 'wired', str(d.detail, 'in the code path'),
        str(d.sub, 'third-party service') + DOT + 'no public probe from here', 'repo',
        { probe: 'none' });
    });
  }

  // -- jobs -----------------------------------------------------------------
  function buildJobs(ctx, h) {
    const { node, DOT, shortErr, relFromNow, fmtUTC, nextCronFireUTC, CRON_OK } = h;
    const { now, reachable } = ctx;
    const nodes = [];
    for (const c of M.crons) {
      const label = str(c.label, c.id);
      const sub = c.expr + ' UTC' + DOT + (c.leaderElected ? 'leader-elected' : 'every replica')
                + (str(c.source) ? DOT + str(c.source) : '');
      const meta = { expr: c.expr, source: str(c.source, null),
                     leaderElected: !!c.leaderElected, note: str(c.note, null) };
      if (!reachable) { nodes.push(node(c.id, 'jobs', label, 'unknown', 'host unreachable', sub, 'cron', meta)); continue; }
      if (!CRON_OK) { nodes.push(node(c.id, 'jobs', label, 'unknown', 'cron evaluator unavailable', sub, 'cron', meta)); continue; }
      let next = null;
      try { next = nextCronFireUTC(c.expr, now); }
      catch (err) {
        nodes.push(node(c.id, 'jobs', label, 'unknown', `unparseable cron "${c.expr}"`,
                        shortErr(err), 'cron', meta));
        continue;
      }
      if (!next) { nodes.push(node(c.id, 'jobs', label, 'unknown', 'no fire time found', sub, 'cron', meta)); continue; }
      meta.nextRunUtc = next.toISOString();
      meta.inMs = next.getTime() - now.getTime();
      nodes.push(node(c.id, 'jobs', label, 'armed',
                      `${relFromNow(next, now)}${DOT}${fmtUTC(next)}`, sub, 'cron', meta));
    }
    for (const j of M.intervals) {
      const text = str(j.text, `every ${Math.round(j.everyMs / 1000)} s`);
      nodes.push(node(j.id, 'jobs', str(j.label, j.id), reachable ? 'armed' : 'unknown',
        reachable ? text : 'host unreachable',
        'interval timer' + (str(j.source) ? DOT + str(j.source) : '')
          + (j.leaderElected ? DOT + 'leader only' : ''),
        'repo', { everyMs: j.everyMs, source: str(j.source, null),
                  leaderElected: !!j.leaderElected, note: str(j.note, null) }));
    }
    return nodes;
  }

  // -- local ----------------------------------------------------------------
  function buildLocal(ctx, h) {
    const { node, clamp, DOT, DETAIL_MAX, relSince } = h;
    const { git: g, dev, now } = ctx;
    const nodes = [];

    let rootExists = false;
    try { rootExists = fs.statSync(ctx.stackRoot).isDirectory(); } catch { rootExists = false; }
    {
      let state, detail;
      if (!g.present || (!g.commit && g.unshipped == null && g.dirty == null)) {
        state = 'unknown';
        detail = rootExists ? 'git state unavailable' : 'checkout not found';
      } else {
        const up = g.unshipped, dy = g.dirty;
        if (up === 0 && dy === 0)      state = 'up';
        else if (up != null && up > 0) state = 'degraded';
        else if (dy != null && dy > 0) state = 'idle';
        else                           state = 'unknown';
        const bits = [];
        if (g.branch) bits.push(g.branch);
        if (g.commit) bits.push(g.commit);
        if (up == null) bits.push('unshipped ?');
        else if (up > 0) bits.push('+' + up + ' unshipped');
        if (dy != null && dy > 0) bits.push(dy + ' dirty');
        if (up === 0 && dy === 0) bits.push('in sync with ' + ctx.prodRef);
        detail = bits.join(DOT);
      }
      const subBits = [];
      if (g.lastCommitAt) {
        subBits.push('last commit ' + relSince(new Date(g.lastCommitAt), now) + ' ago'
                     + (g.lastCommitSubject ? ': ' + g.lastCommitSubject : ''));
      }
      subBits.push(g.lastFetchAt
        ? 'origin fetched ' + relSince(new Date(g.lastFetchAt), now) + ' ago'
        : 'origin never fetched here');
      nodes.push(node('loc-checkout', 'local', M.checkoutLabel, state, detail,
        subBits.join(DOT), 'git', {
          root: ctx.stackRoot, branch: g.branch, commit: g.commit,
          unshipped: g.unshipped, dirty: g.dirty, lastCommitAt: g.lastCommitAt,
          lastCommitSubject: g.lastCommitSubject ? clamp(g.lastCommitSubject, 120) : null,
          lastFetchAt: g.lastFetchAt, upstream: ctx.prodRef,
          prodRefCommit: g.prodRefCommit || null,
          note: 'unshipped counts commits not in ' + ctx.prodRef + '; no fetch is run',
        }));
    }

    {
      const p = dev.probe;
      let state, detail, sub;
      const meta = { port: dev.port, listening: dev.listening, pid: dev.pid,
                     netstatOk: dev.netstatOk, netstatMs: dev.netstatMs };
      if (!dev.listening && dev.netstatOk) {
        state = 'idle';
        detail = 'not running' + DOT + 'port ' + dev.port + ' free';
        sub = 'netstat: nothing bound to 127.0.0.1:' + dev.port;
      } else if (p && p.ok && p.json) {
        state = String(p.json.status || '').toLowerCase() === 'ok' ? 'up' : 'degraded';
        detail = `${p.status} in ${p.ms} ms${DOT}port ${dev.port}`;
        sub = `local ${ctx.paths.health} says "` + clamp(String(p.json.status || '?'), 20) + '"';
        meta.localStatus = p.json.status || null;
      } else if (p && p.reached) {
        state = 'degraded';
        detail = `HTTP ${p.status}${DOT}port ${dev.port}`;
        sub = p.error ? clamp(p.error, 80) : 'answered, but not with health JSON';
      } else if (dev.listening) {
        state = 'degraded';
        detail = 'port ' + dev.port + ' bound' + DOT + 'no health answer';
        sub = (p && p.error) ? clamp(p.error, 80) : 'something else owns this port';
      } else {
        state = 'unknown';
        detail = clamp(dev.error || 'could not determine port state', DETAIL_MAX);
        sub = 'netstat failed - not claiming the dev server is down';
      }
      nodes.push(node('loc-devserver', 'local', 'Local dev server', state, detail, sub,
                      'probe', meta));
    }
    return nodes;
  }

  // -- edges ----------------------------------------------------------------
  function buildEdges(ctx, h) {
    const { edge } = h;
    const e = [];
    e.push(edge('edge-origin', 'rt-version', 'serves'));
    e.push(edge('rt-version', 'app-health', 'runs'));
    const byKey = new Map();
    for (const s of M.services) { e.push(edge('app-health', s.id, 'runs')); byKey.set(s.key, s.id); }
    for (const s of M.subsystems) {
      const from = byKey.get(str(s.parent, null));
      e.push(edge(from || 'app-health', s.id, 'runs'));
    }
    for (const d of M.deps) {
      const from = str(d.inferFrom, null);
      if (from) e.push(edge(from, d.id, 'uses'));
    }
    e.push(edge('loc-checkout', 'rt-version', 'deploys'));
    e.push(edge('loc-devserver', 'loc-checkout', 'runs'));
    for (const [from, to, kind] of M.edges) e.push(edge(from, to, kind));
    return e;
  }

  const profile = {
    tiers: DEFAULT_TIERS.map(t => ({ ...t })),
    builders: [buildEdge, buildRuntime, buildApp, buildDeps, buildJobs, buildLocal],
    edges: buildEdges,
    paths: M.paths,
  };
  if (M.prodRef) profile.prodRef = M.prodRef;
  return profile;
}

module.exports = { makeProfile, DEFAULT_TIERS };
