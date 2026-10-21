#!/usr/bin/env node
// Claude Code status line for Mission Control.
//
// Claude Code pipes a JSON blob to this script on stdin after every change
// (debounced 300 ms). We do two things with it:
//   1. persist it to data/statusline/<session_id>.json so the dashboard can
//      show Claude Code's OWN cost (cost.total_cost_usd, the same number /cost
//      prints) and the /usage rate-limit windows, live and exact;
//   2. print a one-line status for the terminal footer.
// It must never fail loudly: any error still prints something and exits 0.
'use strict';
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data', 'statusline');

function readStdin() {
  return new Promise(resolve => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    setTimeout(() => resolve(buf), 1500).unref();
  });
}

function money(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  if (v < 10) return '$' + v.toFixed(2);
  if (v < 100) return '$' + v.toFixed(1);
  return '$' + Math.round(v);
}

function pct(v) {
  return (typeof v === 'number' && isFinite(v)) ? Math.round(v) + '%' : null;
}

function resetsIn(epochSec) {
  if (typeof epochSec !== 'number') return '';
  const ms = epochSec * 1000 - Date.now();
  if (ms <= 0) return '';
  const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
  return h > 0 ? h + 'h' + (m > 0 ? m + 'm' : '') : m + 'm';
}

function persist(data) {
  try {
    // Claude Code runs the command once with an empty payload when the
    // setting changes; nothing to persist in that case.
    if (!data.session_id) return;
    const id = String(data.session_id).replace(/[^0-9a-zA-Z_-]/g, '');
    if (!id) return;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, id + '.json');
    const tmp = file + '.' + process.pid + '.tmp';
    const record = {
      receivedAt: new Date().toISOString(),
      session_id: data.session_id || null,
      transcript_path: data.transcript_path || null,
      cwd: data.cwd || null,
      model: data.model || null,
      cost: data.cost || null,
      context_window: data.context_window ? {
        total_input_tokens: data.context_window.total_input_tokens,
        total_output_tokens: data.context_window.total_output_tokens,
        context_window_size: data.context_window.context_window_size,
        used_percentage: data.context_window.used_percentage,
        remaining_percentage: data.context_window.remaining_percentage,
      } : null,
      exceeds_200k_tokens: data.exceeds_200k_tokens,
      rate_limits: data.rate_limits || null,
      version: data.version || null,
    };
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
  } catch (e) {
    // never let persistence break the status line
  }
}

function line(data) {
  const parts = [];
  const model = data.model && (data.model.display_name || data.model.id);
  if (model) parts.push('[' + model + ']');
  const ctx = data.context_window ? pct(data.context_window.used_percentage) : null;
  if (ctx) parts.push('ctx ' + ctx);
  const cost = data.cost ? money(data.cost.total_cost_usd) : null;
  if (cost) parts.push(cost);
  const rl = data.rate_limits || {};
  if (rl.five_hour && pct(rl.five_hour.used_percentage)) {
    const r = resetsIn(rl.five_hour.resets_at);
    parts.push('5h ' + pct(rl.five_hour.used_percentage) + (r ? ' (' + r + ')' : ''));
  }
  if (rl.seven_day && pct(rl.seven_day.used_percentage)) {
    const r = resetsIn(rl.seven_day.resets_at);
    parts.push('wk ' + pct(rl.seven_day.used_percentage) + (r ? ' (' + r + ')' : ''));
  }
  if (rl.spend_limit && pct(rl.spend_limit.used_percentage)) parts.push('spend ' + pct(rl.spend_limit.used_percentage));
  return parts.join(' · ');
}

(async () => {
  let data = {};
  try { data = JSON.parse(await readStdin() || '{}'); } catch (e) { data = {}; }
  persist(data);
  let out = '';
  try { out = line(data); } catch (e) { out = ''; }
  process.stdout.write(out || 'mission control');
})();
