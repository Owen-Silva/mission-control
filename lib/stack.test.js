'use strict';
/**
 * mission-control / lib/stack.test.js
 * ---------------------------------------------------------------------------
 * Self-check for lib/stack.js (the engine) and lib/stack-profile.js (the
 * built-in profile). No framework, no npm deps, no config needed, and no
 * network beyond 127.0.0.1: a tiny stub app is served on a free loopback port.
 *
 *   node lib/stack.test.js
 *
 * Verifies:
 *   - the built-in profile, from a synthetic map: six tiers in order, every
 *     map id present in its tier, states derived from the stub's answers
 *   - node shape: legal tier / state / source, no duplicate ids, label and
 *     detail length caps, ASCII + U+00B7 only, no control characters
 *   - every edge resolves; automatic + map edges present; a dangling map edge
 *     is dropped with an error line
 *   - nothing credential-shaped anywhere in the serialised snapshot, even
 *     when the app's health JSON carries one
 *   - an unreachable host degrades to summary.status === 'unreachable'
 *     inside the timeout budget, without throwing
 *   - a missing or broken profile file degrades to an error line naming it
 *   - a profile module is honoured, re-required when it changes, and a
 *     throwing builder becomes an error line
 *
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { scanStack, helpers } = require('./stack');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass++; return true; }
  failures.push(name + (extra ? ` -- ${extra}` : ''));
  return false;
}

// -- a synthetic app ---------------------------------------------------------

const PLANTED = 'hunter2hunter2';
const BODIES = {
  '/api/health': { status: 'ok', role: 'leader',
                   services: { database: 'ok', queue: 'password=' + PLANTED } },
  '/api/version': { commit: 'abc1234', version: '1.2.3', node: 'v20.11.0' },
  '/api/config': { captchaSiteKey: 'public-site-key-value', other: 1 },
  '/api/status/incidents': [{ id: 1, resolved_at: null }, { id: 2, resolved_at: '2026-01-01' }],
};

function startStub() {
  const srv = http.createServer((req, res) => {
    const body = BODIES[req.url.split('?')[0]];
    if (!body) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no'); }
    res.writeHead(200, { 'content-type': 'application/json', server: 'cloudflare',
                         'cf-ray': '0123456789abcdef-XYZ', 'x-demo-edge': 'edge-1' });
    res.end(JSON.stringify(body));
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

const MAP = {
  prodRef: 'HEAD',                       // deterministic: nothing is "unshipped"
  runtime: { label: 'Web service', sub: 'container host' },
  checkoutLabel: 'Demo checkout',
  services: [
    { id: 'app-db',    key: 'database', label: 'Database', critical: true,
      sub: 'connection pool + query check' },
    { id: 'app-queue', key: 'queue',    label: 'Job queue' },
  ],
  subsystems: [
    { id: 'app-mail',   label: 'Outbound mail', parent: 'queue',
      detail: 'receipts and resets', sub: 'worker process' },
    { id: 'app-legacy', label: 'Legacy importer', parent: 'queue',
      forced: 'disabled', forcedDetail: 'switched off' },
  ],
  configFlags: [
    { id: 'edge-captcha', key: 'captchaSiteKey', label: 'Bot check',
      sub: 'public site key presence' },
  ],
  deps: [
    { id: 'dep-db',   label: 'Database host', inferFrom: 'app-db', detail: 'managed database' },
    { id: 'dep-mail', label: 'Mail provider', detail: 'transactional email', sub: 'HTTP API' },
  ],
  crons: [
    { id: 'job-export', label: 'Nightly export', expr: '30 3 * * *',
      source: 'jobs/export.js', leaderElected: true },
  ],
  intervals: [
    { id: 'job-sweep', label: 'Queue sweep', everyMs: 60000, text: 'every 60 s',
      source: 'jobs/sweep.js' },
  ],
  edges: [
    ['app-mail', 'dep-mail', 'notifies'],
    ['app-queue', 'job-sweep', 'schedules'],
    ['job-export', 'app-db', 'uses'],
    ['app-db', 'dep-does-not-exist', 'uses'],
  ],
};

const REQUIRED_NODES = {
  edge:    ['edge-origin', 'edge-captcha'],
  runtime: ['rt-version'],
  app:     ['app-health', 'app-db', 'app-queue', 'app-mail', 'app-legacy'],
  deps:    ['dep-db', 'dep-mail'],
  jobs:    ['job-export', 'job-sweep'],
  local:   ['loc-checkout', 'loc-devserver'],
};

const REQUIRED_EDGES = [
  ['edge-origin', 'rt-version', 'serves'],
  ['rt-version', 'app-health', 'runs'],
  ['app-health', 'app-db', 'runs'],
  ['app-health', 'app-queue', 'runs'],
  ['app-queue', 'app-mail', 'runs'],
  ['app-db', 'dep-db', 'uses'],
  ['loc-checkout', 'rt-version', 'deploys'],
  ['loc-devserver', 'loc-checkout', 'runs'],
  ['app-mail', 'dep-mail', 'notifies'],
  ['app-queue', 'job-sweep', 'schedules'],
  ['job-export', 'app-db', 'uses'],
];

const TIER_ORDER = ['edge', 'runtime', 'app', 'deps', 'jobs', 'local'];

// Anything credential-shaped must never appear in the serialised snapshot.
const LEAK_PATTERNS = [
  /sk-[A-Za-z0-9]/, /\bpk_(?:live|test)_/, /key\s*=/i, /token\s*=/i,
  /password/i, /postgres(?:ql)?:\/\//i, /@[a-z0-9-]+\.[a-z]{2,}/i,
  new RegExp(PLANTED), /public-site-key-value/,
];

function auditShape(snap, tag, tierOrder = TIER_ORDER) {
  const p = s => `${tag}: ${s}`;
  check(p('resolves to an object'), snap && typeof snap === 'object');
  if (!snap) return new Set();
  check(p('generatedAt is an ISO instant'),
        typeof snap.generatedAt === 'string' && !Number.isNaN(Date.parse(snap.generatedAt)));
  check(p('scanMs is a number'), Number.isFinite(snap.scanMs));
  check(p('errors is an array of strings'),
        Array.isArray(snap.errors) && snap.errors.every(e => typeof e === 'string'));
  check(p('tiers are the expected list, in order'),
        Array.isArray(snap.tiers) && snap.tiers.length === tierOrder.length
        && snap.tiers.every((t, i) => t.id === tierOrder[i] && typeof t.label === 'string'),
        JSON.stringify((snap.tiers || []).map(t => t && t.id)));

  const ids = new Set();
  let dupes = 0;
  for (const n of snap.nodes) { if (ids.has(n.id)) dupes++; ids.add(n.id); }
  check(p('no duplicate node ids'), dupes === 0, `${dupes} duplicates`);

  const badShape = snap.nodes.filter(n =>
    typeof n.id !== 'string' || !tierOrder.includes(n.tier)
    || typeof n.label !== 'string' || !helpers.STATES.has(n.state)
    || typeof n.detail !== 'string' || typeof n.sub !== 'string'
    || !helpers.SOURCES.has(n.source) || !n.meta || typeof n.meta !== 'object');
  check(p('every node has the full 8-field shape with legal enums'),
        badShape.length === 0, badShape.map(n => n.id).join(', '));
  const longLabels = snap.nodes.filter(n => n.label.length > 26);
  check(p('labels <= 26 chars'), longLabels.length === 0, longLabels.map(n => n.id).join(', '));
  const longDetails = snap.nodes.filter(n => n.detail.length > 60);
  check(p('details <= 60 chars'), longDetails.length === 0, longDetails.map(n => n.id).join(', '));
  const longSubs = snap.nodes.filter(n => n.sub.length > 90);
  check(p('subs <= 90 chars'), longSubs.length === 0, longSubs.map(n => n.id).join(', '));
  const badChars = snap.nodes.filter(n => /[^\x20-\x7e\u00b7]/.test(n.label + n.detail + n.sub));
  check(p('strings are ASCII + U+00B7 only, no control chars'),
        badChars.length === 0, badChars.map(n => n.id).join(', '));
  check(p('errors are <= 200 chars, no control chars'),
        snap.errors.every(e => e.length <= 200 && !/[\u0000-\u001f]/.test(e)));

  const dangling = snap.edges.filter(e => !ids.has(e.from) || !ids.has(e.to));
  check(p('no dangling edges'), dangling.length === 0,
        dangling.map(e => `${e.from}->${e.to}`).join(', '));
  check(p('every edge kind is legal'), snap.edges.every(e => helpers.KINDS.has(e.kind)));

  const s = snap.summary || {};
  check(p('summary.status is a legal value'),
        ['ok', 'degraded', 'down', 'unreachable'].includes(s.status), String(s.status));
  for (const k of ['httpMs', 'unshipped', 'dirty', 'incidents']) {
    check(p(`summary.${k} is a number or null`), s[k] === null || Number.isFinite(s[k]));
  }
  for (const k of ['deployedCommit', 'deployedAt', 'localCommit', 'localBranch']) {
    check(p(`summary.${k} is a string or null`), s[k] === null || typeof s[k] === 'string');
  }

  const blob = JSON.stringify(snap);
  const leaks = LEAK_PATTERNS.filter(re => re.test(blob)).map(String);
  check(p('no credential-shaped strings in the snapshot'), leaks.length === 0, leaks.join(' '));
  return ids;
}

const byId = (snap, id) => snap.nodes.find(n => n.id === id) || {};

(async () => {
  const t0 = Date.now();
  const repoRoot = path.join(__dirname, '..');
  const srv = await startStub();
  const port = srv.address().port;
  const base = { baseUrl: `http://127.0.0.1:${port}`, stackRoot: repoRoot,
                 localPort: port, label: 'Demo', timeoutMs: 3000 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-stack-test-'));

  try {
    // -- 1. built-in profile from the synthetic map ---------------------------
    const snap = await scanStack({ ...base, map: MAP });
    const ids = auditShape(snap, 'map');
    for (const [tier, want] of Object.entries(REQUIRED_NODES)) {
      const missing = want.filter(id => !ids.has(id));
      check(`map: all ${tier} ids from the map present`, missing.length === 0, missing.join(', '));
      const wrong = want.filter(id => ids.has(id) && byId(snap, id).tier !== tier);
      check(`map: ${tier} ids sit in tier "${tier}"`, wrong.length === 0, wrong.join(', '));
    }
    const keys = new Set(snap.edges.map(e => `${e.from}>${e.to}>${e.kind}`));
    const missingEdges = REQUIRED_EDGES.filter(([f, t, k]) => !keys.has(`${f}>${t}>${k}`));
    check('map: automatic + map edges present', missingEdges.length === 0,
          missingEdges.map(e => e.join('->')).join(', '));
    check('map: a dangling map edge is dropped with an error line',
          !keys.has('app-db>dep-does-not-exist>uses')
          && snap.errors.some(e => /dangling edge dropped: app-db -> dep-does-not-exist/.test(e)));

    const st = id => byId(snap, id).state;
    check('map: summary reads the stub (ok, leader, commit, 1 open incident)',
          snap.summary.status === 'ok' && snap.summary.role === 'leader'
          && snap.summary.deployedCommit === 'abc1234' && snap.summary.incidents === 1,
          JSON.stringify(snap.summary));
    check('map: open incident becomes a labelled error line',
          snap.errors.includes('Demo status page reports 1 open incident'), snap.errors.join(' | '));
    check('map: edge-origin up, cloudflare seen',
          st('edge-origin') === 'up' && byId(snap, 'edge-origin').meta.cloudflare === true);
    check('map: config flag armed, value never emitted', st('edge-captcha') === 'armed'
          && !JSON.stringify(byId(snap, 'edge-captcha')).includes('public-site-key'));
    check('map: rt-version up with the deployed commit',
          st('rt-version') === 'up' && byId(snap, 'rt-version').detail.includes('abc1234'));
    check('map: health services map to states (ok -> up, other -> degraded)',
          st('app-health') === 'up' && st('app-db') === 'up' && st('app-queue') === 'degraded',
          `${st('app-health')} ${st('app-db')} ${st('app-queue')}`);
    check('map: subsystem inherits, forced subsystem is pinned',
          st('app-mail') === 'degraded' && st('app-legacy') === 'disabled');
    check('map: inferred dep follows its node, plain dep is "wired"',
          st('dep-db') === 'up' && st('dep-mail') === 'wired');
    const cron = byId(snap, 'job-export');
    check('map: cron armed with nextRunUtc + inMs',
          (cron.state === 'armed' && typeof cron.meta.nextRunUtc === 'string'
           && Number.isFinite(cron.meta.inMs)) || cron.detail === 'cron evaluator unavailable',
          `${cron.state} ${cron.detail}`);
    check('map: interval armed with everyMs', st('job-sweep') === 'armed'
          && byId(snap, 'job-sweep').meta.everyMs === 60000);
    check('map: checkout read from git', byId(snap, 'loc-checkout').meta.commit != null
          || snap.errors.some(e => /^Demo checkout: /.test(e)));
    check('map: dev server probe found the stub listening', st('loc-devserver') === 'up'
          || st('loc-devserver') === 'unknown', st('loc-devserver'));

    const again = await scanStack({ ...base, map: MAP });
    check('map: node ids are stable across scans',
          snap.nodes.map(n => n.id).join('|') === again.nodes.map(n => n.id).join('|'));

    // -- 2. a null map gives the minimal map ---------------------------------
    const bare = await scanStack({ ...base, map: null });
    const bareIds = auditShape(bare, 'bare');
    check('bare: minimal ids present',
          ['edge-origin', 'rt-version', 'app-health', 'loc-checkout', 'loc-devserver']
            .every(id => bareIds.has(id)), [...bareIds].join(', '));

    // -- 3. unreachable host -------------------------------------------------
    const budget = 2500;
    const t1 = Date.now();
    const dead = await scanStack({ ...base, baseUrl: 'https://127.0.0.1:9', timeoutMs: budget,
                                   map: MAP });
    const deadMs = Date.now() - t1;
    auditShape(dead, 'unreachable');
    check('unreachable: summary.status === "unreachable"', dead.summary.status === 'unreachable');
    check(`unreachable: finished inside timeoutMs + 500 (${deadMs} ms)`, deadMs <= budget + 500);
    check('unreachable: no remote node claims "up"',
          !dead.nodes.some(n => ['edge', 'runtime', 'app'].includes(n.tier) && n.state === 'up'));
    check('unreachable: a labelled health error line',
          dead.errors.some(e => e.startsWith('Demo health probe failed: ')), dead.errors[0]);

    // -- 4. broken profile paths ---------------------------------------------
    const missingFile = path.join(tmp, 'no-such-profile.js');
    const m1 = await scanStack({ ...base, profile: missingFile, map: MAP });
    auditShape(m1, 'missing-profile');
    check('missing profile: error line names the file, built-in map still drawn',
          m1.errors.some(e => e.includes('no-such-profile.js')) && m1.nodes.some(n => n.id === 'app-db'));

    const brokenFile = path.join(tmp, 'broken-profile.js');
    fs.writeFileSync(brokenFile, 'module.exports = { tiers: [ ;\n');
    const m2 = await scanStack({ ...base, profile: brokenFile, map: null });
    auditShape(m2, 'broken-profile');
    check('broken profile: "failed to load" error line names the file',
          m2.errors.some(e => e.includes('broken-profile.js') && /failed to load/.test(e)),
          m2.errors.join(' | '));

    const badShapeFile = path.join(tmp, 'shapeless-profile.js');
    fs.writeFileSync(badShapeFile, 'module.exports = { tiers: [] };\n');
    const m3 = await scanStack({ ...base, profile: badShapeFile });
    check('shapeless profile: "unusable" error line, scan still resolves',
          m3.errors.some(e => e.includes('shapeless-profile.js') && /unusable/.test(e))
          && m3.nodes.length > 0);

    // -- 5. a profile module is honoured -------------------------------------
    const profFile = path.join(tmp, 'custom-profile.js');
    const writeProfile = (nodeId, mtime) => {
      fs.writeFileSync(profFile, `'use strict';
module.exports = {
  tiers: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }],
  paths: { version: null, config: null, incidents: null },
  headers: ['x-demo-edge'],
  async scanFiles(root, h) { return { seen: !!(await h.statOrNull(root)), errors: ['demo note'] }; },
  builders: [
    (ctx, h) => [h.node('${nodeId}', 'one', 'Custom', ctx.reachable ? 'up' : 'unknown',
                        ctx.files && ctx.files.seen ? 'root seen' : 'root missing',
                        'x-demo-edge ' + ((ctx.health.headers || {})['x-demo-edge'] || 'absent'),
                        'static', { label: ctx.label })],
    (ctx, h) => [h.node('custom-two', 'two', 'Second', ctx.byId.has('${nodeId}') ? 'up' : 'down',
                        'sees earlier nodes', '', 'static'),
                 h.node('custom-stray', 'nowhere', 'Stray', 'up', '', '', 'static')],
    () => { throw new Error('demo builder failure'); },
  ],
  edges: (ctx, h) => [h.edge('custom-two', '${nodeId}', 'uses'), ['${nodeId}', 'custom-two', 'runs']],
};
`);
      fs.utimesSync(profFile, mtime, mtime);
    };
    writeProfile('custom-a', new Date('2026-01-01T00:00:00Z'));
    const c1 = await scanStack({ ...base, profile: profFile });
    auditShape(c1, 'custom-profile', ['one', 'two']);
    check('custom profile: its tiers and nodes replace the built-in map',
          c1.nodes.map(n => n.id).join(',') === 'custom-a,custom-two', c1.nodes.map(n => n.id).join(','));
    check('custom profile: builders see ctx (reachable, files, label, earlier nodes)',
          byId(c1, 'custom-a').state === 'up' && byId(c1, 'custom-a').detail === 'root seen'
          && byId(c1, 'custom-a').meta.label === 'Demo' && byId(c1, 'custom-two').state === 'up');
    check('custom profile: edges() honoured (objects and tuples)', c1.edges.length === 2);
    check('custom profile: extra response headers it names are kept',
          byId(c1, 'custom-a').sub === 'x-demo-edge edge-1', byId(c1, 'custom-a').sub);
    check('custom profile: skipped probes raise no error lines',
          !c1.errors.some(e => /\/api\/(version|config|status)/.test(e)), c1.errors.join(' | '));
    check('custom profile: scanFiles errors are surfaced with the label',
          c1.errors.includes('Demo files: demo note'));
    check('custom profile: a throwing builder becomes an error line',
          c1.errors.some(e => /profile builder 3 failed: demo builder failure/.test(e)));
    check('custom profile: a node in an unknown tier is dropped with an error line',
          !c1.nodes.some(n => n.id === 'custom-stray')
          && c1.errors.some(e => /custom-stray dropped/.test(e)));

    writeProfile('custom-b', new Date('2026-01-02T00:00:00Z'));
    const c2 = await scanStack({ ...base, profile: profFile });
    check('custom profile: re-required when its mtime changes',
          c2.nodes.some(n => n.id === 'custom-b') && !c2.nodes.some(n => n.id === 'custom-a'),
          c2.nodes.map(n => n.id).join(','));

    const out = s => process.stdout.write(s + '\n');
    out('');
    out(`map scan       : ${snap.scanMs} ms, ${snap.nodes.length} nodes, `
      + `${snap.edges.length} edges, ${snap.errors.length} errors`);
    out(`unreachable    : ${dead.scanMs} ms, status=${dead.summary.status}`);
    out(`total elapsed  : ${Date.now() - t0} ms`);
    out('');
    if (failures.length) {
      out(`FAIL - ${pass} passed, ${failures.length} failed`);
      for (const f of failures) out(`  x ${f}`);
      process.exitCode = 1;
    } else {
      out(`PASS - ${pass} checks passed`);
    }
  } finally {
    srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
})().catch(err => {
  process.stdout.write('test harness threw (this is a bug): '
                     + ((err && err.stack) || err) + '\n');
  process.exitCode = 1;
});
