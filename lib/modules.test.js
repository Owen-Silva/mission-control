'use strict';
/**
 * Pure-node checks for lib/modules.js (no network, no PowerShell).
 *
 *   node lib/modules.test.js [path/to/config.json ...]
 *
 * Extra arguments are real config files to resolve and print; with
 * MC_EXPECT_STACK=on|off the run also asserts the module state for each.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModules, resolveModules, expandHome } = require('./modules');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++;
  console.log('FAIL ' + name + (detail ? ' - ' + detail : ''));
}

const HOME = path.join(os.tmpdir(), 'mc-home');

// defaults: everything optional is off
{
  const m = resolveModules(null, { home: HOME });
  check('null config -> stack off', m.stack.enabled === false);
  check('null config -> reason given', typeof m.stack.reason === 'string' && m.stack.reason.length > 0);
  check('null config -> no tasks', Array.isArray(m.watchedTasks) && m.watchedTasks.length === 0);
  check('null config -> no scan opts', m.stack.scan === null && m.stack.infra === null);
}
{
  const m = resolveModules({ since: '2026-01-01T00:00:00Z' }, { home: HOME });
  check('config without modules -> stack off', m.stack.enabled === false);
}
{
  const m = resolveModules({ modules: { stack: { enabled: false, baseUrl: 'https://a.example' } } }, { home: HOME });
  check('enabled:false -> off', m.stack.enabled === false);
}
{
  const m = resolveModules({ modules: { stack: { enabled: 'true', baseUrl: 'https://a.example' } } }, { home: HOME });
  check('enabled must be boolean true', m.stack.enabled === false);
}
{
  const m = resolveModules({ modules: { stack: { enabled: true } } }, { home: HOME });
  check('enabled without baseUrl -> off', m.stack.enabled === false);
  check('enabled without baseUrl -> says why', /baseUrl/.test(m.stack.reason));
}
{
  const m = resolveModules({ modules: { stack: { enabled: true, baseUrl: 'ftp://x.example' } } }, { home: HOME });
  check('non-http baseUrl -> off', m.stack.enabled === false);
}

// enabled
{
  const m = resolveModules({
    modules: { stack: {
      enabled: true, baseUrl: 'https://app.example.com/', root: '~/src/app', localPort: 4000,
      infra: { appLabel: 'App', services: [
        { id: 'site', label: 'Site', origin: 'https://site.example.com' },
        { id: 'portal', label: 'Portal', origin: 'not a url' } ] },
    } },
  }, { home: HOME });
  check('enabled -> on', m.stack.enabled === true && m.stack.reason === null);
  check('trailing slash trimmed', m.stack.scan.baseUrl === 'https://app.example.com');
  check('~ expanded', m.stack.scan.stackRoot === path.join(HOME, 'src', 'app'), m.stack.scan.stackRoot);
  check('localPort kept', m.stack.scan.localPort === 4000);
  check('infra origin', m.stack.infra.stackOrigin === 'https://app.example.com');
  check('site origin kept', m.stack.infra.profile.services[0].origin === 'https://site.example.com');
  check('bad portal origin dropped', m.stack.infra.profile.services[1].origin === null);
  check('profile passes labels through', m.stack.infra.profile.appLabel === 'App');
  check('infra home', m.stack.infra.home === HOME);
}
{
  const m = resolveModules({ modules: { stack: { enabled: true, baseUrl: 'https://a.example', localPort: 'x' } } }, { home: HOME });
  check('bad localPort -> 3000', m.stack.scan.localPort === 3000);
  check('no root -> null', m.stack.scan.stackRoot === null);
  check('no label -> Stack', m.stack.label === 'Stack' && m.stack.scan.label === 'Stack');
  check('no profile -> null', m.stack.scan.profile === null);
  check('no map -> null', m.stack.scan.map === null);
  check('no formerIds -> []', Array.isArray(m.stack.formerIds) && m.stack.formerIds.length === 0);
}

// label, formerIds, profile path, map
{
  const m = resolveModules({ modules: { stack: {
    enabled: true, baseUrl: 'https://a.example', label: '  My App\u0007  ',
    formerIds: ['Old-Name', 'bad id', 'stack', 7, 'old-name', 'x2'],
    profile: '~/profiles/app.local.js', map: { healthServices: [] },
  } } }, { home: HOME });
  check('label trimmed, control chars dropped', m.stack.label === 'My App', JSON.stringify(m.stack.label));
  check('label passed to the scan', m.stack.scan.label === 'My App');
  check('formerIds filtered + lowercased + deduped', JSON.stringify(m.stack.formerIds) === '["old-name","x2"]',
        JSON.stringify(m.stack.formerIds));
  check('profile ~ expanded', m.stack.scan.profile === path.join(HOME, 'profiles', 'app.local.js'), m.stack.scan.profile);
  check('map passed through', m.stack.scan.map && Array.isArray(m.stack.scan.map.healthServices));
  const r = resolveModules({ modules: { stack: { enabled: true, baseUrl: 'https://a.example',
    profile: 'data/p.local.js', map: ['not', 'an', 'object'], label: 'x'.repeat(40) } } }, { home: HOME });
  check('relative profile -> repo root', r.stack.scan.profile === path.join(__dirname, '..', 'data', 'p.local.js'),
        r.stack.scan.profile);
  check('non-object map -> null', r.stack.scan.map === null);
  check('label capped at 24', r.stack.label.length === 24);
  const off = resolveModules({ modules: { stack: { enabled: false, label: 'Shown Anyway', formerIds: ['old'] } } },
    { home: HOME });
  check('label + formerIds resolved even when off', off.stack.enabled === false
        && off.stack.label === 'Shown Anyway' && off.stack.formerIds[0] === 'old');
}

// watchedTasks
{
  const m = resolveModules({ watchedTasks: [
    { id: 'a', taskName: 'Task A', label: 'A' },
    { taskName: 'My Task 2' },
    { id: 'a', taskName: 'dupe id' },
    { label: 'no name' },
    'junk',
  ] }, { home: HOME });
  check('valid tasks kept in order', m.watchedTasks.length === 2, JSON.stringify(m.watchedTasks));
  check('id derived', m.watchedTasks[1] && m.watchedTasks[1].id === 'task-my-task-2');
  check('label defaults to name', m.watchedTasks[1] && m.watchedTasks[1].label === 'My Task 2');
}

// expandHome
check('expandHome ~', expandHome('~', HOME) === HOME);
check('expandHome abs', expandHome('C:/x', HOME) === 'C:/x');

// loadModules: missing, broken, BOM
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-modules-'));
  const missing = loadModules(path.join(dir, 'nope.json'));
  check('missing file -> off, no error', missing.modules.stack.enabled === false && missing.error === null);

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  const b = loadModules(bad);
  check('broken file -> off + error', b.modules.stack.enabled === false && typeof b.error === 'string');
  check('broken file -> reason mentions it', /unreadable/.test(b.modules.stack.reason));

  const bom = path.join(dir, 'bom.json');
  fs.writeFileSync(bom, '\uFEFF' + JSON.stringify({ modules: { stack: { enabled: true, baseUrl: 'https://a.example' } } }));
  check('BOM tolerated', loadModules(bom).modules.stack.enabled === true);

  const ex = path.join(__dirname, '..', 'data', 'config.example.json');
  if (fs.existsSync(ex)) {
    const e = loadModules(ex);
    check('example config parses', e.error === null, e.error);
    check('example config keeps stack OFF', e.modules.stack.enabled === false);
    check('example config has a watched task', e.modules.watchedTasks.length === 1);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// real config files given on the command line
const expect = process.env.MC_EXPECT_STACK;
for (const file of process.argv.slice(2)) {
  const r = loadModules(file);
  const a = r.modules.stack;
  console.log(file + ': stack ' + (a.enabled ? 'ON' : 'OFF (' + a.reason + ')') +
              ', watchedTasks ' + r.modules.watchedTasks.length +
              (a.enabled ? ', root ' + a.scan.stackRoot + ', port ' + a.scan.localPort : ''));
  if (expect === 'on' || expect === 'off') {
    check(file + ' stack ' + expect, a.enabled === (expect === 'on'));
  }
}

console.log((fail ? 'FAIL' : 'PASS') + ' - ' + pass + ' checks passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
