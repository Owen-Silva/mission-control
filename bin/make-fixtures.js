#!/usr/bin/env node
'use strict';
/**
 * mission-control / bin/make-fixtures.js
 * ---------------------------------------------------------------------------
 * Writes the SYNTHETIC demo fixtures the UI falls back to when there is no
 * live data:  public/fixtures/stack.json (system-map snapshot for the
 * optional project view) and public/fixtures/history.json (24 h history strip).
 *
 * Everything here is made up: a generic web app on app.example.com with
 * neutral service names. Deterministic (seeded), so re-running it produces
 * the same files. A machine's own snapshots go in the gitignored
 * public/fixtures/*.local.json files, which the UI prefers when present.
 *
 *   node bin/make-fixtures.js
 */
const fs   = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'public', 'fixtures');

/* small seeded PRNG (mulberry32) so the output is stable */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GENERATED_AT = '2026-01-15T12:00:00.000Z';
const T0 = Date.parse(GENERATED_AT);

/* ------------------------------------------------------------ system map */

function n(id, tier, label, state, detail, sub, source) {
  return { id, tier, label, state, detail, sub, source, meta: {} };
}

function systemMap() {
  const nodes = [
    n('edge-domain',    'edge',    'app.example.com',   'up',       'Apex and www behind a CDN, TLS',             'CDN -> web service',          'probe'),
    n('edge-botgate',   'edge',    'Bot check',         'wired',    'Challenge on signup and login forms',        'verified server-side',        'static'),
    n('rt-web',         'runtime', 'Web service',       'up',       'Node web service, 1 replica',                'abc1234 deployed 3h ago',     'health'),
    n('rt-version',     'runtime', 'Version endpoint',  'up',       'Reports the running commit',                 'abc1234',                     'version'),
    n('app-http',       'app',     'HTTP server',       'up',       'Routes, sessions, rate limit on /api/*',     'health ok',                   'health'),
    n('app-db',         'app',     'Database pool',     'up',       '10 connections, 2 in use',                   'migrations current',          'health'),
    n('app-scheduler',  'app',     'Scheduler',         'armed',    'Runs the jobs tier',                         'next fire in 41 min',         'cron'),
    n('app-auth',       'app',     'Auth',              'up',       'Sessions via the auth provider',             'keys loaded',                 'health'),
    n('app-billing',    'app',     'Billing webhooks',  'up',       'Signed webhook receiver',                    'last event 2h ago',           'health'),
    n('app-email',      'app',     'Email sender',      'up',       'Transactional mail',                         'queue empty',                 'health'),
    n('app-admin',      'app',     'Admin console',     'idle',     'Owner-only log view',                        'no session open',             'static'),
    n('dep-postgres',   'deps',    'Postgres',          'up',       'Managed database',                           'reachable',                   'health'),
    n('dep-auth',       'deps',    'Auth provider',     'wired',    'Third-party identity service',               'no public probe',             'static'),
    n('dep-cdn',        'deps',    'CDN / DNS',         'up',       'Fronts the domain',                          'cache HIT',                   'probe'),
    n('dep-email',      'deps',    'Email API',         'wired',    'Transactional email provider',               'no public probe',             'static'),
    n('dep-storage',    'deps',    'Object storage',    'wired',    'Nightly backup target',                      'no public probe',             'static'),
    n('dep-llm',        'deps',    'LLM API',           'wired',    'Model calls for the assistant feature',      'no public probe',             'static'),
    n('job-backup',     'jobs',    'Nightly backup',    'armed',    '0 9 * * * UTC',                              'last run 15h ago',            'cron'),
    n('job-digest',     'jobs',    'Daily digest',      'armed',    '0 15 * * * UTC',                             'next in 3h',                  'cron'),
    n('job-cleanup',    'jobs',    'History cleanup',   'armed',    'every 6 h',                                  'in-process interval',         'cron'),
    n('job-health',     'jobs',    'Health monitor',    'armed',    'every 5 min',                                'in-process interval',         'cron'),
    n('loc-checkout',   'local',   'Checkout',          'up',       '~/src/my-app on main',                       '2 unshipped, 3 dirty',        'git'),
    n('loc-devserver',  'local',   'Dev server',        'idle',     'nothing listening on :3000',                 'start it with npm run dev',   'process'),
    n('loc-changelog',  'local',   'Changelog',         'up',       'CHANGELOG.md',                               'latest entry 2 days ago',     'file'),
  ];
  const e = (from, to, kind) => ({ from, to, kind });
  const edges = [
    e('edge-domain', 'rt-web', 'serves'), e('edge-botgate', 'app-auth', 'uses'),
    e('rt-web', 'app-http', 'runs'), e('rt-web', 'rt-version', 'serves'),
    e('app-http', 'app-db', 'uses'), e('app-http', 'app-auth', 'uses'),
    e('app-http', 'app-billing', 'runs'), e('app-http', 'app-admin', 'serves'),
    e('app-scheduler', 'job-backup', 'schedules'), e('app-scheduler', 'job-digest', 'schedules'),
    e('app-scheduler', 'job-cleanup', 'schedules'), e('app-scheduler', 'job-health', 'schedules'),
    e('app-db', 'dep-postgres', 'stores'), e('app-auth', 'dep-auth', 'uses'),
    e('edge-domain', 'dep-cdn', 'uses'), e('app-email', 'dep-email', 'notifies'),
    e('job-digest', 'app-email', 'uses'), e('job-backup', 'dep-storage', 'stores'),
    e('app-http', 'dep-llm', 'uses'), e('loc-checkout', 'rt-web', 'deploys'),
    e('loc-devserver', 'loc-checkout', 'runs'), e('loc-changelog', 'loc-checkout', 'stores'),
  ];
  return {
    generatedAt: GENERATED_AT,
    scanMs: 380,
    errors: [],
    summary: {
      status: 'ok', role: 'leader', httpMs: 240,
      deployedCommit: 'abc1234', deployedAt: null,
      localCommit: 'def5678', localBranch: 'main',
      unshipped: 2, dirty: 3, prodMatchesLocal: false, incidents: 0,
    },
    tiers: [
      { id: 'edge', label: 'Edge' }, { id: 'runtime', label: 'Runtime' },
      { id: 'app', label: 'App' }, { id: 'deps', label: 'Depends on' },
      { id: 'jobs', label: 'Jobs' }, { id: 'local', label: 'This machine' },
    ],
    nodes,
    edges,
  };
}

/* --------------------------------------------------------------- history */

function history() {
  const r = rng(42);
  const HOURS = 24, STEP = 120000, N = HOURS * 3600000 / STEP;   // 720 points
  const since = T0 - HOURS * 3600000;
  const series = { stack: [], services: { 'app-web': [], 'marketing-site': [], 'status-page': [] }, agents: [] };
  const outage = { from: since + 18 * 3600000, to: since + 18 * 3600000 + 9 * 60000 };
  const ms = (base, spread) => Math.round(base + r() * spread);
  for (let i = 0; i < N; i++) {
    const t = since + i * STEP;
    const down = t >= outage.from && t < outage.to;
    series.stack.push({ t, status: down ? 'down' : 'ok', ms: down ? null : ms(200, 160),
                        role: r() < 0.9 ? 'leader' : 'follower', unshipped: i > N - 90 ? 2 : 0,
                        incidents: down ? 1 : 0 });
    series.services['app-web'].push({ t, up: down ? 0 : 1, ms: down ? null : ms(260, 160) });
    series.services['marketing-site'].push({ t, up: 1, ms: ms(150, 100) });
    series.services['status-page'].push({ t, up: 1, ms: ms(220, 150) });
    const running = Math.max(0, Math.round(3 * Math.sin(i / 60) + r() * 2));
    series.agents.push({ t, running, agents: 40 + Math.floor(i / 20), sessions: 1 + (running > 2 ? 1 : 0) });
  }
  const pct = (rows, ok) => Math.round(1000 * rows.filter(ok).length / rows.length) / 10;
  const q = (rows, p) => {
    const v = rows.map((x) => x.ms).filter(Number.isFinite).sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.floor(p * v.length))];
  };
  const svcStats = {};
  for (const k of Object.keys(series.services)) {
    const rows = series.services[k];
    svcStats[k] = { samples: rows.length, uptimePct: pct(rows, (x) => x.up === 1),
                    p50Ms: q(rows, 0.5), p95Ms: q(rows, 0.95),
                    incidents: k === 'app-web' ? [{ from: outage.from, to: outage.to }] : [] };
  }
  let peak = 0, peakAt = since;
  for (const p of series.agents) if (p.running > peak) { peak = p.running; peakAt = p.t; }
  const a = series.stack;
  return {
    generatedAt: GENERATED_AT, since, until: T0, hours: HOURS,
    series,
    stats: {
      stack: { samples: a.length, uptimePct: pct(a, (x) => x.status === 'ok'),
               p50Ms: q(a, 0.5), p95Ms: q(a, 0.95),
               worst: Math.max(...a.map((x) => x.ms).filter(Number.isFinite)),
               incidents: [{ from: outage.from, to: outage.to, status: 'down' }] },
      services: svcStats,
      agents: { samples: series.agents.length, peakRunning: peak, peakAt },
    },
  };
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'stack.json'), JSON.stringify(systemMap(), null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'history.json'), JSON.stringify(history()) + '\n');
console.log('wrote public/fixtures/stack.json and public/fixtures/history.json (synthetic)');
