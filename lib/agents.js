'use strict';

/**
 * agents.js — live snapshot of Claude Code's on-disk subagent fan-out tree.
 *
 * Reads the sidecar files Claude Code writes per subagent:
 *   <projectsRoot>\<projectSlug>\<sessionId>\subagents\agent-<id>.meta.json
 *   <projectsRoot>\<projectSlug>\<sessionId>\subagents\agent-<id>.jsonl
 * plus the session's own transcript at
 *   <projectsRoot>\<projectSlug>\<sessionId>.jsonl
 *
 * Zero dependencies. CommonJS. Read-only. Never throws.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PROJECTS_ROOT = path.join(
  process.env.USERPROFILE || process.env.HOME || require('os').homedir(),
  '.claude',
  'projects'
);
const DEFAULT_ACTIVE_WINDOW_MS = 90000;
const DEFAULT_MAX_TAIL_BYTES = 65536;

const CONCURRENCY = 32;
const SESSION_HEAD_BYTES = 65536; // bounded head read for session cwd
const LAST_TEXT_MAX_CHARS = 160;

const OPEN_BRACE = 0x7b;
const NEWLINE = 0x0a;

// Cache retention. A shallow session does not touch its agents' cache entries,
// so eviction must NOT be "unseen this scan" — otherwise toggling the dropdown
// back to a history session re-pays the full cold cost every time. An entry
// survives until it has been unseen for BOTH of these.
const CACHE_TTL_SCANS = 10;
const CACHE_TTL_MS = 60000;

// --- token accounting -------------------------------------------------------

const TOKEN_BUDGET_BYTES = 8 * 1024 * 1024; // NEW bytes parsed per scanAgents()
const TOKEN_TIME_BUDGET_MS = 150; // wall-clock ceiling for the whole phase
const TOKEN_MIN_CHUNK_BYTES = 262144; // do not start a file for less than this
const TOKEN_MAX_IDS = 20000; // per-file dedupe map ceiling
const TOKEN_READ_CONCURRENCY = 8;
const TOKEN_CACHE_MAX_FILES = 4000;
const TOKEN_STALL_LIMIT = 3;
// Fingerprint of the bytes immediately BEFORE the resume offset, used to catch
// a rewrite in place.
//
// NOT the file head: on this disk 1152 of 1156 agent sidecars open with the
// same 32 bytes ({"parentUuid":null,"isSidechain), so a head print is a
// constant and catches nothing.
//
// The window has to be wide because what matters is ENTROPY, not length: these
// lines end in ~82 bytes of fixed boilerplate
// (,"cache_creation":{"ephemeral_5m_...}}}}), so a short tail print lands in
// dead text and compares equal across genuinely different content. A 64-byte
// print happened to work on fixtures whose last line carried varying digits and
// failed on ones where it did not -- not a size rule, a coverage rule. 4 KB
// spans several whole records including their ids and token counts, and real
// sidecar lines measure p50 1,937 B, so 4 KB reliably covers more than one.
//
// Residual limitation, measured and accepted. What still escapes is narrow: a
// rewrite that GROWS the file (so the same-length reset below does not fire)
// while leaving BOTH sampled windows byte-identical and changing only the
// middle. Measured at 67.7% understatement on a fixture built to that shape.
// Anything that changes the first 1 KB, the last 4 KB before the resume point,
// or the file's length is caught. Closing the remainder needs a hash of the
// whole consumed prefix -- a full re-read on every append, the exact cost this
// module exists to avoid, against a shape append-only writers do not produce.
const TOKEN_PRINT_BYTES = 4096;

// A SECOND window, over the first bytes of the file. The tail window alone
// guards only the last 4 KB before the resume point, and the escape that leaves
// is not exotic: an ordinary whole-file rewrite (an editor save) advances mtime
// AND grows the file, so the verify fires -- and then passes, because the bytes
// it samples happen to be identical. Measured on a 400 KB fixture whose first
// 197 of 200 records were rewritten: -202,910,000 tokens, $132.50 reported
// against a true $772.75, at full confidence.
//
// Any rewrite that touches the start of the file now fails this window. 1 KB is
// enough to be distinctive even though these sidecars share a fixed 32-byte
// opening, because it reaches well into the first record's own content. It does
// not catch a surgical edit confined to the middle -- that still needs a hash of
// the whole prefix, i.e. a full re-read per append, which this module exists to
// avoid.
const TOKEN_HEAD_PRINT_BYTES = 1024;

/** FNV-1a over a byte range. Cheap, non-crypto, plenty for change detection. */
function printHash(buf, from, to) {
  let h = 0x811c9dc5;
  for (let i = from; i < to; i++) {
    h ^= buf[i];
    // h * 16777619 without overflowing the 32-bit range through float mul.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
const TOKEN_CACHE_MAX_LINE = 1 << 22; // 4 MB: refuse to JSON.parse a bigger line

// Cheap Buffer pre-checks. A native indexOf over a line is orders of magnitude
// cheaper than handing that line to JSON.parse, and most lines are user turns
// or tool results that carry no usage at all.
const ASSISTANT_NEEDLE = Buffer.from('"type":"assistant"');
const USAGE_NEEDLE = Buffer.from('"usage"');
const COST_STATE_NEEDLE = Buffer.from('"type":"cost-state"');
const COST_STATE_SCAN_BYTES = 512;

const UNKNOWN_MODEL = 'unknown';

// ---------------------------------------------------------------------------
// Pricing table (lib/pricing.json), loaded once at module load.
//
// A missing or corrupt table is not fatal: token counts still work, every
// cost estimate just comes back null and one line lands in errors[] per scan.
// ---------------------------------------------------------------------------

const PRICING_PATH = path.join(__dirname, 'pricing.json');
let PRICING = null;
let PRICING_ERROR = null;

(function loadPricing() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object') {
      PRICING = parsed.models;
    } else {
      PRICING_ERROR = 'pricing table has no "models" object: ' + PRICING_PATH;
    }
  } catch (err) {
    PRICING_ERROR = errStr('cannot load pricing table ' + PRICING_PATH, err);
  }
})();

/**
 * readdir() uses lstat semantics, so a junction or symlink reports as a
 * symlink rather than a directory. Treat both as directory candidates — if the
 * target turns out not to be one, the readdir below fails harmlessly.
 */
function isDirLike(dirent) {
  return dirent.isDirectory() || dirent.isSymbolicLink();
}

// ---------------------------------------------------------------------------
// Bounded caches
// ---------------------------------------------------------------------------

// Expensive per-jsonl work (line count + tail parse), keyed by path+mtimeMs+size.
// Retained across scans that did not touch it — see CACHE_TTL_SCANS.
const jsonlCache = new Map();

// Session cwd, keyed by transcript path. The HEAD of an append-only transcript
// never changes, so this is safe to key without mtime (and the mtime changes
// constantly, which would make an mtime-keyed cache always miss).
const cwdCache = new Map();

// Parsed agent meta.json + its birthtime, keyed by path. The meta sidecar is
// written once at spawn time and never rewritten, so this needs no mtime in the
// key — and skipping the readFile+stat is most of the warm-scan saving.
const metaCache = new Map();

// Incremental token parse state, keyed by file path alone. Unlike the others
// this is a RESUME point, not a memo: it holds the byte offset we have already
// consumed plus the deduped per-message usage behind it, so a 12 MB transcript
// is parsed once and every later scan only reads the bytes that were appended.
// Dropping an entry therefore costs a full re-parse -- see evictStale().
const tokenCache = new Map();

// Debug counters. Deliberately NOT surfaced in errors[]: a malformed line in a
// megabyte of transcript is normal (Claude Code's line schema drifts between
// releases, and a live file can be read mid-append), and one errors[] entry per
// bad line would drown the real failures.
const tokenStats = {
  scans: 0,
  filesParsed: 0,
  bytesParsed: 0,
  parseFails: 0,
  readFails: 0,
  budgetSkips: 0,
  deadlineSkips: 0,
  // Resets force a full re-parse, so a non-zero rate on an append-only tree
  // means a guard is misfiring. Expected to stay 0 in normal operation.
  resetsVerifyFailed: 0,
  resetsSameSize: 0,
};

let scanSeq = 0;

function cacheGet(key) {
  const hit = jsonlCache.get(key);
  if (hit) {
    hit.seq = scanSeq;
    hit.t = Date.now();
    return hit.value;
  }
  return undefined;
}

function cacheSet(key, value) {
  jsonlCache.set(key, { seq: scanSeq, t: Date.now(), value: value });
}

/**
 * Drop cache entries that have gone unseen for both CACHE_TTL_SCANS scans and
 * CACHE_TTL_MS milliseconds. Requiring both means neither a fast poll loop
 * (which would burn through 10 scans in 20s) nor a slow one prematurely
 * discards a session the user is about to switch back to.
 */
function evictStale() {
  const now = Date.now();
  const seqCutoff = scanSeq - CACHE_TTL_SCANS;
  for (const [key, entry] of jsonlCache) {
    if (entry.seq < seqCutoff && now - entry.t > CACHE_TTL_MS) jsonlCache.delete(key);
  }
  for (const [key, entry] of metaCache) {
    if (entry.seq < seqCutoff && now - entry.t > CACHE_TTL_MS) metaCache.delete(key);
  }
  // Token entries hold a parse offset, so evicting one re-reads a file that may
  // be megabytes. `seq`/`t` are stamped when a file is REGISTERED as a target,
  // before any budget decision, so a file still on disk in a deep session is
  // re-seen every scan and can never be evicted mid-parse. Only a file that has
  // genuinely dropped out of the scan for 10 scans AND 60 s ages out.
  for (const [key, entry] of tokenCache) {
    if (entry.seq < seqCutoff && now - entry.t > CACHE_TTL_MS) tokenCache.delete(key);
  }

  // Hard ceilings, in case a single scan somehow explodes.
  if (jsonlCache.size > 20000) jsonlCache.clear();
  if (metaCache.size > 20000) metaCache.clear();
  if (cwdCache.size > 5000) cwdCache.clear();
  // Never clear() this one wholesale -- that would re-parse every transcript on
  // the next tick. Drop the least-recently-seen files down to the ceiling.
  if (tokenCache.size > TOKEN_CACHE_MAX_FILES) {
    const rows = [];
    for (const [key, entry] of tokenCache) rows.push([key, entry.seq]);
    rows.sort(function (a, b) {
      return a[1] - b[1];
    });
    const drop = tokenCache.size - TOKEN_CACHE_MAX_FILES;
    for (let i = 0; i < drop && i < rows.length; i++) tokenCache.delete(rows[i][0]);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function errStr(what, err) {
  const msg = err && err.message ? err.message : String(err);
  return what + ': ' + msg;
}

function toIso(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toISOString();
  } catch (e) {
    return null;
  }
}

/** birthtime, falling back to mtime when birthtime is epoch-0 or invalid. */
function birthMs(st) {
  const b = st.birthtimeMs;
  if (Number.isFinite(b) && b > 0) return b;
  const m = st.mtimeMs;
  return Number.isFinite(m) && m > 0 ? m : 0;
}

function collapse(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/** Bounded-concurrency map that never rejects; failures come back as __error. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = [];
  for (let w = 0; w < width; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          try {
            out[i] = await fn(items[i], i);
          } catch (err) {
            out[i] = { __error: err };
          }
        }
      })()
    );
  }
  await Promise.all(workers);
  return out;
}

async function safeStat(p) {
  try {
    return await fsp.stat(p);
  } catch (e) {
    return null;
  }
}

async function safeClose(fh) {
  if (!fh) return;
  try {
    await fh.close();
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// jsonl inspection: line count + defensive tail parse, sharing one open handle
// ---------------------------------------------------------------------------

/**
 * Pull lastTool / lastText out of the tail of a sidecar jsonl.
 *
 * The line schema is Claude Code internal and changes between releases, so
 * every step here is optional: anything unparseable yields nulls, and that is
 * NOT an error.
 */
/**
 * Read at most maxTailBytes from the end of an open file and split it into
 * whole lines. Bounded no matter how big the file is — the main session
 * transcript runs to megabytes.
 */
async function readTailLines(fh, size, maxTailBytes) {
  if (size === 0) return [];
  let text;
  try {
    const want = Math.min(maxTailBytes, size);
    const start = size - want;
    const buf = Buffer.allocUnsafe(want);
    const r = await fh.read(buf, 0, want, start);
    text = buf.toString('utf8', 0, Math.max(0, r.bytesRead));
    if (start > 0) {
      // We cut mid-line, so the first line is probably partial — drop it.
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
  } catch (e) {
    return [];
  }
  return text ? text.split('\n') : [];
}

/**
 * Harness scaffolding rather than anything the user wrote or Claude said:
 * injected reminders and slash-command wrappers. Never surfaced as prose.
 */
function isWrapperText(t) {
  return (
    t.startsWith('<system-reminder') ||
    t.startsWith('<command-') ||
    t.startsWith('<local-command')
  );
}

async function parseTail(fh, size, maxTailBytes) {
  const result = { lastTool: null, lastText: null };
  const lines = await readTailLines(fh, size, maxTailBytes);
  if (lines.length === 0) return result;

  let fallbackText = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line.charCodeAt(0) !== OPEN_BRACE) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    const msg = entry.message;
    if (!msg || typeof msg !== 'object') continue;

    const role = msg.role || entry.type;
    const isAssistant = role === 'assistant';
    const content = msg.content;

    // Content may be a plain string or an array of blocks — handle both.
    if (typeof content === 'string') {
      const t = collapse(content);
      if (t) {
        if (isAssistant && result.lastText === null) {
          result.lastText = t.slice(0, LAST_TEXT_MAX_CHARS);
        } else if (fallbackText === null) {
          fallbackText = t.slice(0, LAST_TEXT_MAX_CHARS);
        }
      }
    } else if (Array.isArray(content)) {
      for (let b = content.length - 1; b >= 0; b--) {
        const block = content[b];
        if (!block || typeof block !== 'object') continue;

        if (block.type === 'tool_use') {
          if (result.lastTool === null && typeof block.name === 'string' && block.name) {
            result.lastTool = block.name;
          }
        } else if (block.type === 'text' && typeof block.text === 'string') {
          const t = collapse(block.text);
          if (t) {
            if (isAssistant && result.lastText === null) {
              result.lastText = t.slice(0, LAST_TEXT_MAX_CHARS);
            } else if (fallbackText === null) {
              fallbackText = t.slice(0, LAST_TEXT_MAX_CHARS);
            }
          }
        }
      }
    }

    if (result.lastTool !== null && result.lastText !== null) break;
  }

  if (result.lastText === null) result.lastText = fallbackText;
  return result;
}

/**
 * What the MAIN session is doing, from the tail of its own transcript.
 *
 * Differs from the subagent walker: only non-sidechain lines count, only
 * assistant text counts (no user fallback — this drives a "working on X"
 * label), harness wrapper text is skipped, and the model is picked up from
 * the most recent assistant message that carries one.
 */
async function parseMainTail(fh, size, maxTailBytes) {
  const result = { lastTool: null, lastText: null, model: null };
  const lines = await readTailLines(fh, size, maxTailBytes);
  if (lines.length === 0) return result;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line.charCodeAt(0) !== OPEN_BRACE) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    // Subagent lines are not written to the main transcript, but guard anyway.
    if (entry.isSidechain === true) continue;

    const msg = entry.message;
    if (!msg || typeof msg !== 'object') continue;
    if ((msg.role || entry.type) !== 'assistant') continue;

    if (result.model === null && typeof msg.model === 'string' && msg.model) {
      result.model = msg.model;
    }

    const content = msg.content;
    if (typeof content === 'string') {
      const t = collapse(content);
      if (t && !isWrapperText(t) && result.lastText === null) {
        result.lastText = t.slice(0, LAST_TEXT_MAX_CHARS);
      }
    } else if (Array.isArray(content)) {
      for (let b = content.length - 1; b >= 0; b--) {
        const block = content[b];
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use') {
          if (result.lastTool === null && typeof block.name === 'string' && block.name) {
            result.lastTool = block.name;
          }
        } else if (block.type === 'text' && typeof block.text === 'string') {
          const t = collapse(block.text);
          if (t && !isWrapperText(t) && result.lastText === null) {
            result.lastText = t.slice(0, LAST_TEXT_MAX_CHARS);
          }
        }
      }
    }

    if (result.lastTool !== null && result.lastText !== null && result.model !== null) break;
  }

  return result;
}

/**
 * Cached tail parse of a session transcript. Same path+mtimeMs+size key shape
 * as the sidecar cache, so a quiet session costs nothing on repeat ticks.
 * Never counts lines — these files are megabytes.
 */
async function inspectTranscript(transcriptPath, st, maxTailBytes) {
  const key = 'main|' + transcriptPath + '|' + st.mtimeMs + '|' + st.size + '|' + maxTailBytes;
  const hit = cacheGet(key);
  if (hit) return hit;

  let value = { lastTool: null, lastText: null, model: null };
  let fh = null;
  try {
    fh = await fsp.open(transcriptPath, 'r');
    value = await parseMainTail(fh, st.size, maxTailBytes);
  } catch (e) {
    // Unreadable or vanished mid-scan: all nulls. Not an error.
  } finally {
    await safeClose(fh);
  }

  cacheSet(key, value);
  return value;
}

/**
 * The "main" block on a session: what the primary agent is doing, as opposed
 * to its fan-out. lastActivityAt here is the transcript mtime alone, so it can
 * legitimately be older than the session's own lastActivityAt when subagents
 * are busy and the main loop is blocked waiting on them.
 */
function buildMain(ctx, transcriptMs, tail) {
  const running = transcriptMs !== null && ctx.now - transcriptMs < ctx.activeWindowMs;
  return {
    lastTool: tail ? tail.lastTool : null,
    lastText: tail ? tail.lastText : null,
    lastActivityAt: toIso(transcriptMs),
    idleMs: transcriptMs === null ? null : Math.max(0, Math.round(ctx.now - transcriptMs)),
    status: running ? 'running' : 'idle',
    model: tail ? tail.model : null,
    // Deep sessions only -- a shallow session never opens its transcript, so
    // these stay null there by construction.
    tokens: null,
    costUsd: null,
    costModel: null,
  };
}

/**
 * bytes + lastTool + lastText for one sidecar jsonl, cached by
 * path + mtimeMs + size so a repeat scan seconds later is nearly free.
 *
 * `lines` is deliberately NOT computed here any more. It used to come from
 * countLines(), which re-read the ENTIRE file every time the file grew -- a
 * cache miss on every append, unbounded by tokenBudgetBytes, and by far the
 * largest single cost of a scan. The token parser already walks every newline
 * in the bytes it consumes, so the count comes from there instead (see
 * attachTokens). Side benefit: files over the old 5 MB ceiling now get a real
 * line count instead of null.
 */
async function inspectJsonl(jsonlPath, st, maxTailBytes) {
  const key = jsonlPath + '|' + st.mtimeMs + '|' + st.size + '|' + maxTailBytes;
  const hit = cacheGet(key);
  if (hit) return hit;

  const value = { lines: null, bytes: st.size, lastTool: null, lastText: null };
  let fh = null;
  try {
    fh = await fsp.open(jsonlPath, 'r');
    const tail = await parseTail(fh, st.size, maxTailBytes);
    value.lastTool = tail.lastTool;
    value.lastText = tail.lastText;
  } catch (e) {
    // Unreadable or vanished mid-scan: keep the nulls. Not an error.
  } finally {
    await safeClose(fh);
  }

  cacheSet(key, value);
  return value;
}

// ---------------------------------------------------------------------------
// Session cwd — bounded head read of the session transcript
// ---------------------------------------------------------------------------

/**
 * Best-effort session cwd. Reads only the first SESSION_HEAD_BYTES of the
 * transcript (never the whole file) and returns the first cwd it finds.
 *
 * NOTE: the literal first line of a real transcript is a control record
 * ({"type":"mode",...}) carrying no cwd — cwd first appears a few lines in —
 * so this scans the bounded head rather than line 1 only.
 */
async function readSessionCwd(transcriptPath) {
  const cached = cwdCache.get(transcriptPath);
  if (cached !== undefined) return cached;

  let cwd = null;
  let fh = null;
  try {
    fh = await fsp.open(transcriptPath, 'r');
    const buf = Buffer.allocUnsafe(SESSION_HEAD_BYTES);
    const r = await fh.read(buf, 0, SESSION_HEAD_BYTES, 0);
    let head = buf.toString('utf8', 0, Math.max(0, r.bytesRead));
    if (r.bytesRead === SESSION_HEAD_BYTES) {
      // Last line is probably partial — drop it.
      const nl = head.lastIndexOf('\n');
      if (nl !== -1) head = head.slice(0, nl);
    }
    const lines = head.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.charCodeAt(0) !== OPEN_BRACE) continue;
      if (line.indexOf('"cwd"') === -1) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.cwd === 'string' && obj.cwd) {
          cwd = obj.cwd;
          break;
        }
      } catch (e) {
        /* keep scanning */
      }
    }
  } catch (e) {
    cwd = null;
  } finally {
    await safeClose(fh);
  }

  cwdCache.set(transcriptPath, cwd);
  return cwd;
}

// ---------------------------------------------------------------------------
// Token accounting
//
// Every {"type":"assistant"} line carries message.usage. CRUCIAL: one assistant
// message is written as SEVERAL lines -- one per content block (text, thinking,
// tool_use) -- each repeating the same message.id with a usage snapshot, and
// only the LAST line for an id carries the final output_tokens. Summing lines
// therefore overcounts wildly (measured 186 usage lines vs 77 real messages on
// one fixture, and 89x too small on output_tokens if you keep the FIRST
// snapshot instead of the last). So: dedupe by message.id, last write wins.
//
// Parsing is incremental. Each file keeps a byte offset plus the deduped map
// behind it, so an appended transcript costs only the appended bytes. Complete
// lines only: the offset always lands just past a newline, which is also what
// makes the byte->string conversion UTF-8 safe (0x0a can never occur inside a
// multi-byte sequence, so a line boundary never splits a character).
// ---------------------------------------------------------------------------

function num0(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function intOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/** Money and per-model splits only ever need 4dp, and short numbers keep the
 *  snapshot small -- this runs per agent, per scan, over a websocket. */
function round4(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}

function newTally() {
  return {
    in: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    out: 0,
    total: 0,
    turns: 0,
  };
}

function addTally(dst, src) {
  dst.in += src.in;
  dst.cacheRead += src.cacheRead;
  dst.cacheWrite += src.cacheWrite;
  dst.cacheWrite5m += src.cacheWrite5m;
  dst.cacheWrite1h += src.cacheWrite1h;
  dst.out += src.out;
  dst.total += src.total;
  dst.turns += src.turns;
}

/** Fresh object every time: the snapshot is serialised and must not alias the
 *  cache, or a later scan would mutate an already-sent payload. */
function publicTally(t) {
  return {
    in: t.in,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    cacheWrite5m: t.cacheWrite5m,
    cacheWrite1h: t.cacheWrite1h,
    out: t.out,
    total: t.total,
    turns: t.turns,
  };
}

const MODEL_BRACKET_RE = /\[[^\]]*\]/g;
const MODEL_DATE_RE = /-\d{8}$/;

/**
 * "claude-opus-5[1m]" and "claude-haiku-4-5-20251001" both price as their base
 * model, so strip the variant bracket and any trailing date stamp before
 * looking the id up. Note this merges Claude Code's separate "[1m]" bucket into
 * the base one -- the estimate is per base model, the reported split is not.
 */
function normaliseModel(id) {
  if (typeof id !== 'string' || !id) return null;
  const m = id.replace(MODEL_BRACKET_RE, '').trim().replace(MODEL_DATE_RE, '');
  return m || null;
}

function newTokenEntry() {
  return {
    seq: -1,
    t: 0,
    size: 0,
    mtimeMs: 0,
    offset: 0,
    started: false,
    pending: false,
    approx: false,
    stalls: 0,
    parseFails: 0,
    readFails: 0,
    byId: new Map(),
    byModel: new Map(),
    totals: newTally(),
    costState: null,
    tailHash: 0,
    printLen: 0,
    headHash: 0,
    headLen: 0,
    lines: 0,
    linesApprox: false,
    forcedPartial: false,
  };
}

/** File shrank or was replaced: nothing we know about it is still true. */
function resetTokenEntry(entry) {
  entry.offset = 0;
  entry.started = false;
  entry.approx = false;
  entry.stalls = 0;
  entry.byId = new Map();
  entry.byModel = new Map();
  entry.totals = newTally();
  entry.costState = null;
  entry.tailHash = 0;
  entry.printLen = 0;
  entry.headHash = 0;
  entry.headLen = 0;
  entry.lines = 0;
  entry.linesApprox = false;
  entry.forcedPartial = false;
}

/**
 * Re-read the bytes just before the saved offset and check they are still what
 * we consumed. False means the file was rewritten underneath us and the offset
 * is meaningless. A read failure returns true: we cannot tell, and throwing
 * away good state on a transient error is the worse mistake.
 *
 * Takes an already-open handle -- a growing file is opened for its read anyway,
 * and opening a second time just to verify doubled the opens on every busy file.
 */
async function verifyOnHandle(fh, entry) {
  const n = entry.printLen;
  if (n <= 0 || entry.offset < n) return true;
  try {
    const b = Buffer.allocUnsafe(n);
    const r = await fh.read(b, 0, n, entry.offset - n);
    if (r.bytesRead !== n) return false;
    if (printHash(b, 0, n) !== entry.tailHash) return false;

    // Head window: catches a whole-file rewrite that leaves the tail window
    // byte-identical. Cheap (1 KB) and only on files that already changed.
    const h = entry.headLen;
    if (h > 0) {
      const hb = Buffer.allocUnsafe(h);
      const hr = await fh.read(hb, 0, h, 0);
      if (hr.bytesRead !== h) return false;
      if (printHash(hb, 0, h) !== entry.headHash) return false;
    }
    return true;
  } catch (e) {
    return true;
  }
}

/**
 * Recompute the resume-point fingerprint so it always covers a full
 * TOKEN_PRINT_BYTES window wherever the file is long enough.
 *
 * `endInBuf` is how much of `buf` now sits behind entry.offset. On a small
 * append that is far less than the window, and printing only that would shrink
 * the guard to the size of the last append -- measured: a single 8-byte line
 * collapsed a 4096-byte window to 8 bytes, letting a rewrite straight through.
 * So read the shortfall back off the handle we are still holding.
 */
async function reprintResumePoint(fh, entry, buf, endInBuf) {
  const want = Math.min(TOKEN_PRINT_BYTES, entry.offset);
  if (want <= 0) return;

  // Head window, captured once per file: the start of a transcript never
  // changes while it is only being appended to.
  const headWant = Math.min(TOKEN_HEAD_PRINT_BYTES, entry.offset);
  if (entry.headLen === 0 && headWant > 0) {
    try {
      const hb = Buffer.allocUnsafe(headWant);
      const hr = await fh.read(hb, 0, headWant, 0);
      if (hr.bytesRead === headWant) {
        entry.headHash = printHash(hb, 0, headWant);
        entry.headLen = headWant;
      }
    } catch (e) {
      /* leave it unset; the tail window still applies */
    }
  }

  if (endInBuf >= want) {
    entry.tailHash = printHash(buf, endInBuf - want, endInBuf);
    entry.printLen = want;
    return;
  }

  try {
    const pb = Buffer.allocUnsafe(want);
    const r = await fh.read(pb, 0, want, entry.offset - want);
    if (r.bytesRead === want) {
      entry.tailHash = printHash(pb, 0, want);
      entry.printLen = want;
      return;
    }
  } catch (e) {
    /* fall through to the narrow print */
  }

  // Could not widen it. Print what we actually hold rather than leave a stale
  // hash behind: a stale print against a moved offset is the infinite-reset bug.
  if (endInBuf > 0) {
    entry.tailHash = printHash(buf, 0, endInBuf);
    entry.printLen = endInBuf;
  }
}

function bucketFor(entry, model) {
  let b = entry.byModel.get(model);
  if (!b) {
    b = newTally();
    entry.byModel.set(model, b);
  }
  return b;
}

/**
 * Fold one usage record into the file totals and its model bucket. `sign` is
 * -1 when retracting the previous snapshot for a message id that has just been
 * superseded, which is how last-write-wins stays O(1) instead of re-summing the
 * whole map on every appended line.
 */
function accum(entry, rec, sign, turnDelta) {
  const t = entry.totals;
  const b = bucketFor(entry, rec.m);
  const sub = rec.i + rec.cr + rec.cw + rec.o;
  t.in += sign * rec.i;
  t.cacheRead += sign * rec.cr;
  t.cacheWrite += sign * rec.cw;
  t.cacheWrite5m += sign * rec.c5;
  t.cacheWrite1h += sign * rec.c1;
  t.out += sign * rec.o;
  t.total += sign * sub;
  t.turns += turnDelta;
  b.in += sign * rec.i;
  b.cacheRead += sign * rec.cr;
  b.cacheWrite += sign * rec.cw;
  b.cacheWrite5m += sign * rec.c5;
  b.cacheWrite1h += sign * rec.c1;
  b.out += sign * rec.o;
  b.total += sign * sub;
  b.turns += turnDelta;
}

function applyUsage(entry, id, rawModel, u) {
  const rec = {
    m: normaliseModel(rawModel) || UNKNOWN_MODEL,
    i: num0(u.input_tokens),
    cr: num0(u.cache_read_input_tokens),
    cw: num0(u.cache_creation_input_tokens),
    c5: 0,
    c1: 0,
    o: num0(u.output_tokens),
  };

  // Cache writes price differently by TTL, so keep the 5m/1h split when the
  // line carries one. When it does not, or when it disagrees with the headline
  // cache_creation_input_tokens, fall back to the 5m tier -- it is both the
  // cheaper assumption and by far the more common one in practice.
  const cc = u.cache_creation;
  if (cc && typeof cc === 'object') {
    rec.c5 = num0(cc.ephemeral_5m_input_tokens);
    rec.c1 = num0(cc.ephemeral_1h_input_tokens);
    const split = rec.c5 + rec.c1;
    if (split !== rec.cw) {
      if (split === 0) rec.c5 = rec.cw;
      else if (split > rec.cw) rec.cw = split;
      else rec.c5 += rec.cw - split;
    }
  } else {
    rec.c5 = rec.cw;
  }

  const prev = entry.byId.get(id);
  if (prev) {
    accum(entry, prev, -1, 0);
    entry.byId.set(id, rec);
    accum(entry, rec, 1, 0);
    return;
  }

  if (entry.byId.size >= TOKEN_MAX_IDS) {
    // Past the ceiling we can no longer tell a new message from a repeat block
    // of an old one, so the count becomes an upper bound. Flagged, not hidden.
    entry.approx = true;
    accum(entry, rec, 1, 1);
    return;
  }
  entry.byId.set(id, rec);
  accum(entry, rec, 1, 1);
}

/**
 * Claude Code's own cost checkpoint. Written into the main transcript at
 * intervals with no timestamp of its own, so "last one in the file" is the
 * newest -- which is exactly what a forward-only incremental parse sees.
 */
function summariseCostState(obj) {
  const byModel = {};
  const mu = obj.modelUsage;
  if (mu && typeof mu === 'object') {
    const keys = Object.keys(mu);
    for (let i = 0; i < keys.length; i++) {
      const v = mu[keys[i]];
      if (v && typeof v === 'object' && Number.isFinite(v.costUSD)) {
        byModel[keys[i]] = round4(v.costUSD);
      }
    }
  }
  return {
    totalUsd: Number.isFinite(obj.totalCostUSD) ? round4(obj.totalCostUSD) : null,
    byModel: byModel,
    linesAdded: intOrNull(obj.totalLinesAdded),
    linesRemoved: intOrNull(obj.totalLinesRemoved),
    apiMs: intOrNull(obj.totalAPIDuration),
    durationMs: intOrNull(obj.totalDuration),
  };
}

function applyTokenLine(entry, line, wantCostState) {
  // cost-state records start with the type key and run about a kilobyte, so a
  // bounded head scan finds them without paying a full-line scan per line.
  if (wantCostState) {
    const head = line.length > COST_STATE_SCAN_BYTES ? line.subarray(0, COST_STATE_SCAN_BYTES) : line;
    if (head.indexOf(COST_STATE_NEEDLE) !== -1) {
      if (line.length > TOKEN_CACHE_MAX_LINE) return;
      let obj;
      try {
        obj = JSON.parse(line.toString('utf8'));
      } catch (e) {
        entry.parseFails++;
        return;
      }
      if (obj && obj.type === 'cost-state') entry.costState = summariseCostState(obj);
      return;
    }
  }

  if (line.indexOf(ASSISTANT_NEEDLE) === -1) return;
  if (line.indexOf(USAGE_NEEDLE) === -1) return;
  if (line.length > TOKEN_CACHE_MAX_LINE) return;

  let obj;
  try {
    obj = JSON.parse(line.toString('utf8'));
  } catch (e) {
    // A live file read mid-append, or a schema we do not know. Counted, not
    // reported: one errors[] line per bad line would bury the real failures.
    entry.parseFails++;
    return;
  }
  if (!obj || obj.type !== 'assistant') return;
  const msg = obj.message;
  if (!msg || typeof msg !== 'object') return;
  const u = msg.usage;
  if (!u || typeof u !== 'object') return;
  const id = msg.id;
  if (typeof id !== 'string' || !id) return;
  applyUsage(entry, id, msg.model, u);
}

/**
 * Walk complete lines out of `buf` and return how many bytes were consumed --
 * always ending just past a newline, so a partial trailing line is left for the
 * next scan rather than parsed half-written.
 */
function consumeTokenChunk(entry, buf, wantCostState) {
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf(NEWLINE, pos);
    if (nl === -1) break;
    // Free line count: this walk already lands on every newline in the file, so
    // countLines() re-reading the whole file to do the same thing was pure waste
    // -- and waste OUTSIDE the byte budget, which is what made the budget a
    // fiction (measured 17.4 MB re-read per scan against 4.5 KB of token work on
    // 8 live 2 MB sidecars).
    if (entry.forcedPartial) {
      // This newline terminates a record whose leading fragment we already
      // force-consumed AND already counted on an earlier scan. Counting it
      // again adds +1 per pause/resume cycle and accumulates without bound
      // (measured 15 vs a true 10 over five cycles).
      entry.forcedPartial = false;
    } else {
      entry.lines++;
    }
    if (nl - pos > 2) applyTokenLine(entry, buf.subarray(pos, nl), wantCostState);
    pos = nl + 1;
  }
  return pos;
}

/**
 * Bring one file's token state up to date, spending from the shared byte and
 * time budget. Never throws; a failure just leaves the entry where it was.
 */
async function updateFileTokens(target, budget) {
  const filePath = target.path;
  let entry = tokenCache.get(filePath);
  if (!entry) {
    entry = newTokenEntry();
    tokenCache.set(filePath, entry);
  }
  // Stamp the sighting BEFORE any budget decision: a file we chose not to spend
  // budget on this scan is still present, and must not age out of the cache.
  entry.seq = scanSeq;
  entry.t = Date.now();

  const size = num0(target.size);
  const mtimeMs = num0(target.mtimeMs);

  // Truncated, rotated or restored from a backup: the offset points into a file
  // that no longer exists behind it. Start over.
  if (size < entry.offset || (entry.started && mtimeMs > 0 && mtimeMs < entry.mtimeMs)) {
    resetTokenEntry(entry);
  }

  // A rewrite IN PLACE is the dangerous case. It can leave the file the same
  // size or even larger, so neither test above sees it, and we would blend the
  // old totals into new content with nothing to correct it later -- reported at
  // full confidence, wrong forever. So re-verify the resume point whenever
  // ANYTHING about the file changed. Testing size-or-mtime rather than the
  // narrower "grew, or was touched without growing" also covers a rewrite to
  // exactly the saved offset, which slipped through the earlier version. A
  // genuinely quiet file changes neither and still costs zero IO.
  const mustVerify =
    entry.offset > 0 && entry.started && (size !== entry.size || mtimeMs !== entry.mtimeMs);

  // Touched but did not grow. On an append-only file that combination should be
  // impossible, so it means the bytes moved underneath us even if the 4 KB
  // window happens to still match -- see the blind spot noted at the top. Kept
  // separately because a PASSING verify in this state is exactly the case that
  // silently corrupted the line count once countLines() stopped re-reading the
  // whole file: 20 records rewritten as 19, same total size, same last 4 KB,
  // reported as 20 at full confidence.
  const touchedNotGrown = mustVerify && size === entry.size;

  // NOTE: entry.size / entry.mtimeMs are deliberately NOT stamped here. They
  // record the last state we actually VERIFIED, not the last state we saw. A
  // scan that skips this file for budget or deadline must leave them alone --
  // stamping first made a skipped scan look like quiescence, so the next scan
  // computed mustVerify === false and appended new bytes onto a prefix that had
  // never been checked. Measured: an in-place rewrite plus one skipped scan
  // reported 11,460 tokens against a true 235,200 (-95.1%), at full confidence
  // and permanently. They are stamped below, after the verify.

  // Cheap guards BEFORE any IO. A file the budget is going to skip must not pay
  // for a verification read: that was costing an open plus a full-window read on
  // every pending file on every scan, for nothing.
  const hasNew = size > entry.offset;

  // The deadline bounds the whole phase, so it applies to a verify-only pass
  // too -- that path opens a handle and reads a full window, which is not free.
  if ((hasNew || mustVerify) && Date.now() > budget.deadline) {
    tokenStats.deadlineSkips++;
    entry.pending = entry.offset < size;
    return;
  }
  if (hasNew) {
    // Skip rather than nibble: a read too small to clear a single long line just
    // burns budget and stalls. The file finishes on a later scan. Byte budget is
    // deliberately NOT applied to a verify-only pass: it reads a bounded window
    // and consumes no parse budget, and skipping it would leave the stale-prefix
    // hole above open.
    const ahead = size - entry.offset;
    if (budget.left <= 0 || (ahead > budget.left && budget.left < TOKEN_MIN_CHUNK_BYTES)) {
      tokenStats.budgetSkips++;
      entry.pending = true;
      return;
    }
  } else if (!mustVerify) {
    entry.pending = false;
    // A zero-byte sidecar (an agent that has only just spawned) really has been
    // read to the end. Report zeros rather than null: nothing is outstanding.
    if (size === 0) entry.started = true;
    return;
  }

  // Claim the budget BEFORE any await. A file being resumed has a verify to
  // wait on while a fresh file (offset 0, nothing to verify) does not, so
  // reserving after the verify let fresh files win the race every scan: the
  // budget went to a different new file each time and nothing ever finished.
  // Throughput was the same either way, but every file's completion was pushed
  // out and the board showed everything pending for twice as long.
  let reserved = Math.min(size - entry.offset, budget.left);
  if (reserved < 0) reserved = 0;
  budget.left -= reserved;

  // One handle for verify + read + re-print.
  let fh = null;
  try {
    fh = await fsp.open(filePath, 'r');
  } catch (e) {
    budget.left += reserved;
    entry.readFails++;
    tokenStats.readFails++;
    entry.pending = entry.offset < size;
    return;
  }

  try {
    if (mustVerify && !(await verifyOnHandle(fh, entry))) {
      tokenStats.resetsVerifyFailed++;
      resetTokenEntry(entry);
    } else if (touchedNotGrown) {
      tokenStats.resetsSameSize++;
      // Verify passed, but the file was written to WITHOUT changing length. On
      // an append-only transcript that is impossible, so the fingerprint passing
      // proves nothing beyond "the sampled windows survived" -- a
      // length-preserving rewrite keeps size, and can keep both windows, while
      // changing everything between them (measured: 422,200 reported against a
      // true 2,166,066). Flagging it as approximate was still serving a stale
      // number; re-read instead. The re-parse only ever costs anything on an
      // event append-only files do not produce.
      resetTokenEntry(entry);
    }

    // Now that the prefix has actually been checked, record what we verified.
    entry.mtimeMs = mtimeMs;
    entry.size = size;

    if (entry.offset >= size) {
      budget.left += reserved;
      reserved = 0;
      entry.pending = false;
      if (size === 0) entry.started = true;
      return;
    }

    const start = entry.offset;
    // A reset above rewound the offset, so more may be needed than was claimed.
    // Top up from whatever is left rather than crawling a scan at a time.
    const needed = size - start;
    if (needed > reserved && budget.left > 0) {
      const extra = Math.min(needed - reserved, budget.left);
      budget.left -= extra;
      reserved += extra;
    }
    if (reserved <= 0) {
      tokenStats.budgetSkips++;
      entry.pending = true;
      return;
    }

    let buf = Buffer.allocUnsafe(reserved);
    const r = await fh.read(buf, 0, reserved, start);
    const got = Math.max(0, r.bytesRead);
    if (got < reserved) {
      budget.left += reserved - got;
      buf = buf.subarray(0, got);
    }
    reserved = 0; // fully accounted for

    const atEof = start + buf.length >= size;
    let consumed = consumeTokenChunk(entry, buf, target.wantCostState);

    if (consumed < buf.length && atEof && target.settled) {
      // Nothing has been written here in activeWindowMs, so the unterminated
      // last line is never going to get its newline. Take it now, or this file
      // reports tokensPending forever.
      if (buf.length - consumed > 2) {
        applyTokenLine(entry, buf.subarray(consumed), target.wantCostState);
      }
      entry.lines++; // matches countLines(), which also counted a trailing partial
      entry.forcedPartial = true;
      // The fragment we just force-fed to applyTokenLine is half a record, so
      // it fails the needle pre-checks and contributes no usage -- and if the
      // writer later resumes, the other half fails them too. That record's
      // tokens are simply lost, silently, with parseFails never moving. Flag
      // it rather than report a short total at full confidence.
      entry.approx = true;
      consumed = buf.length;
    }

    entry.offset = start + consumed;
    // How much of buf ends up BEHIND the offset. Normally that is `consumed`,
    // but the stall path below steps the offset over an unconsumed blob.
    let endInBuf = consumed;

    if (consumed === 0 && buf.length > 0) {
      entry.stalls++;
      if (entry.stalls >= TOKEN_STALL_LIMIT) {
        // One line longer than the whole read window. Step over it rather than
        // re-reading the same bytes every scan; the totals become a lower bound.
        entry.offset = start + buf.length;
        entry.approx = true;
        // Deliberately NOT linesApprox: consumed === 0 means indexOf found no
        // newline anywhere in this chunk, so the bytes being stepped over
        // contain none and the count loses nothing. The record's TOKENS are
        // lost (hence approx above), but its terminating newline still arrives
        // in a later chunk and is counted exactly once. Setting linesApprox
        // here nulled `lines` permanently on a healthy append-only file, since
        // only a reset ever clears it.
        entry.stalls = 0;
        endInBuf = buf.length;
      }
    } else {
      entry.stalls = 0;
    }

    entry.started = true;
    entry.pending = entry.offset < size;
    tokenStats.filesParsed++;
    // Count what the budget actually paid for (bytes READ), not bytes consumed:
    // a partial trailing line is spent budget even though it was left unparsed.
    // NOTE this is a SPEND meter, not a distinct-bytes meter: an actively
    // appending file re-reads its unterminated trailing line every scan, so the
    // cumulative figure grows without bound (measured +86 B/scan on one file).
    // Correct for "did we stay inside the budget", wrong for "how much of the
    // tree have we actually read".
    tokenStats.bytesParsed += buf.length;

    // Re-print the resume point. This MUST also run on the stall path: that path
    // moves the offset without consuming a line, and leaving the old print
    // behind makes the next scan verify a stale hash against the new offset ->
    // mismatch -> reset -> full re-read -> stall again, forever, burning the
    // entire byte budget every scan and starving every other file.
    await reprintResumePoint(fh, entry, buf, endInBuf);
  } catch (e) {
    if (reserved > 0) budget.left += reserved;
    entry.readFails++;
    tokenStats.readFails++;
    entry.pending = entry.offset < size;
  } finally {
    await safeClose(fh);
  }
}

/**
 * Cost estimate for one file from its per-model buckets. Returns usd:null only
 * when NOTHING in the file could be priced -- a file that is mostly a known
 * model with one stray unknown still reports the part it can stand behind, and
 * flags the rest.
 */
function costOf(entry) {
  const out = { usd: null, model: null, unknown: false, byModel: null };
  if (!entry || entry.byModel.size === 0) return out;

  let usd = 0;
  let priced = 0;
  let bestTotal = -1;
  const byModel = {};

  for (const [model, b] of entry.byModel) {
    if (b.total <= 0) continue; // e.g. a synthetic turn with an all-zero usage
    if (b.total > bestTotal) {
      bestTotal = b.total;
      out.model = model;
    }
    const p = PRICING ? PRICING[model] : null;
    if (!p || typeof p !== 'object') {
      out.unknown = true;
      continue;
    }
    const c =
      (b.in * num0(p.in) +
        b.cacheRead * num0(p.cacheRead) +
        b.cacheWrite5m * num0(p.cacheWrite5m) +
        b.cacheWrite1h * num0(p.cacheWrite1h) +
        b.out * num0(p.out)) /
      1e6;
    usd += c;
    priced++;
    byModel[model] = round4(c);
  }

  if (priced > 0) {
    out.usd = round4(usd);
    out.byModel = byModel;
  }
  return out;
}

/** Copy one file's finished state onto the agent / main object it belongs to. */
function attachTokens(target) {
  const sink = target.sink;
  const entry = tokenCache.get(target.path);
  if (!entry) {
    sink.tokens = null;
    return;
  }
  target.entry = entry;

  if (!entry.started) {
    // Nothing consumed yet: null now, real numbers on a later scan.
    sink.tokens = null;
    if (entry.pending) sink.tokensPending = true;
    return;
  }

  sink.tokens = publicTally(entry.totals);
  if (entry.pending) sink.tokensPending = true;
  if (entry.approx) sink.tokensApprox = true;

  // Line count, from the newlines the parser already walked. Only once the file
  // is fully consumed: a partial count would silently understate. Files still
  // catching up keep lines:null, which was already a legal value (it is what
  // anything over 5 MB reported before), and they fill in within a few scans.
  if (typeof sink.lines !== 'undefined' && !entry.pending && !entry.linesApprox) {
    sink.lines = entry.lines;
  }

  const cost = costOf(entry);
  target.cost = cost;
  sink.costUsd = cost.usd;
  sink.costModel = cost.model;
  if (cost.unknown) sink.costUnknownModel = true;
  // costUsd is a SUM over per-model buckets, but costModel names only the
  // dominant one -- which invites re-pricing the whole tally at that single
  // rate and getting a different answer. Measured on this session's main
  // transcript: 121 fable-5-1 turns ($22.54) + 23 opus-5 turns ($5.64) = $28.18,
  // while the same aggregate priced entirely as fable-5-1 comes to $32.31, a
  // $4.13 gap. Publish the split whenever more than one model is in play so the
  // arithmetic is checkable without having to guess which rate applied.
  if (cost.byModel && Object.keys(cost.byModel).length > 1) sink.costByModel = cost.byModel;
}

/**
 * Register a file for the token phase. Shallow sessions never call this -- they
 * must stay one readdir plus one stat.
 */
function registerTokenTarget(ctx, filePath, st, sink, isMain) {
  const mtimeMs = Number.isFinite(st.mtimeMs) && st.mtimeMs > 0 ? st.mtimeMs : 0;
  const target = {
    path: filePath,
    size: Number.isFinite(st.size) ? st.size : 0,
    mtimeMs: mtimeMs,
    sink: sink,
    isMain: !!isMain,
    wantCostState: !!isMain,
    settled: mtimeMs > 0 && ctx.now - mtimeMs > ctx.activeWindowMs,
    cost: null,
    entry: null,
  };
  ctx.tokenTargets.push(target);
  return target;
}

/**
 * One global pass over every registered file, newest first, under a shared byte
 * and wall-clock budget. Global rather than per-session so the budget goes to
 * the busiest files on disk instead of whichever session happened to resolve
 * first.
 */
async function runTokenPhase(ctx) {
  const targets = ctx.tokenTargets;
  if (targets.length === 0) return 0;

  const t0 = Date.now();
  tokenStats.scans++;

  targets.sort(function (a, b) {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    // Exact mtime ties are common (same-second writes). Break them towards the
    // main transcript: session.tokens is gated on main finishing, and main is
    // pushed last, so a stable sort would otherwise starve the one file the
    // session total cannot be published without.
    return (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0);
  });

  const budget = { left: ctx.tokenBudgetBytes, deadline: t0 + TOKEN_TIME_BUDGET_MS };
  await mapLimit(targets, TOKEN_READ_CONCURRENCY, function (t) {
    return updateFileTokens(t, budget);
  });

  // Attach unconditionally, including for a file whose update failed this scan:
  // its cache entry still holds everything consumed on earlier scans, and stale
  // -but-real numbers beat dropping the agent's tokens to null on one bad read.
  for (let i = 0; i < targets.length; i++) attachTokens(targets[i]);
  return Date.now() - t0;
}

/**
 * Session roll-up: main plus every agent. Deliberately refuses to publish a
 * total it cannot anchor -- if the main transcript has not finished parsing,
 * the session number would silently understate by the whole main thread, so it
 * stays null until main is complete and only then climbs as agents land.
 */
function rollUpSessionTokens(session) {
  const targets = session._tokenTargets;
  const sl = session._statusline;
  delete session._tokenTargets;
  delete session._statusline;

  if (session.shallow) {
    session.tokens = null;
    session.cost = null;
    session.live = null;
    return;
  }

  session.live = sl ? sl.live : null;

  const sum = newTally();
  const estByModel = {};
  let reported = null;
  let mainOk = false;
  let estUsd = 0;
  let estEligible = 0;
  let estPriced = 0;
  let anyPending = false;
  let anyApprox = false;

  const list = targets || [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const sink = t.sink;
    if (t.isMain) {
      if (t.entry && t.entry.costState) reported = t.entry.costState;
      mainOk = !!sink.tokens && !sink.tokensPending;
    }
    if (sink.tokens) {
      addTally(sum, sink.tokens);
      // Only sinks that actually burned something can have a price. A
      // just-spawned agent with a zero-byte transcript is not a coverage miss,
      // and counting it as one produces a false "missing a model" signal.
      if (sink.tokens.total > 0) estEligible++;
      if (typeof sink.costUsd === 'number') {
        estUsd += sink.costUsd;
        estPriced++;
        const bm = t.cost && t.cost.byModel;
        if (bm) {
          const keys = Object.keys(bm);
          for (let k = 0; k < keys.length; k++) {
            estByModel[keys[k]] = (estByModel[keys[k]] || 0) + bm[keys[k]];
          }
        }
      }
    }
    if (sink.tokensPending) anyPending = true;
    if (sink.tokensApprox) anyApprox = true;
  }

  session.tokens = mainOk ? sum : null;
  if (anyPending) session.tokensPending = true;
  if (anyApprox) session.tokensApprox = true;

  let byModel = null;
  if (estPriced > 0) {
    byModel = {};
    const keys = Object.keys(estByModel);
    for (let k = 0; k < keys.length; k++) byModel[keys[k]] = round4(estByModel[keys[k]]);
  }

  session.cost = {
    // Ordered by trust. `live` is Claude Code's own /cost figure, exact and
    // seconds old. `reported` is the transcript checkpoint, exact but stale.
    // `estimatedUsd` is ours, always short (see the status-line note above) and
    // only worth reading when the first two are absent.
    live:
      sl && sl.totalUsd !== null
        ? {
            totalUsd: sl.totalUsd,
            at: sl.receivedAt,
            ageMs: sl.receivedMs !== null ? Math.max(0, Date.now() - sl.receivedMs) : null,
            source: 'claude-code',
          }
        : null,
    reported: reported,
    estimatedUsd: estPriced > 0 ? round4(estUsd) : null,
    estimatedByModel: byModel,
    // Fraction of the sinks that had tokens AND a price we knew. Below 1.0
    // means estimatedUsd is missing a model, not that the arithmetic is wrong.
    estimatedCoverage: estEligible > 0 ? Math.round((estPriced / estEligible) * 1000) / 1000 : null,
  };
}

// ---------------------------------------------------------------------------
// Claude Code status-line sidecar
//
// bin/statusline.js writes data/statusline/<sessionId>.json after every turn.
// cost.total_cost_usd is exactly what /cost prints and rate_limits is what
// /usage shows, which makes this the only EXACT cost source we have. The other
// two are both structurally short: the transcript cost-state checkpoint lags by
// however long ago it was written, and our own estimate cannot match by
// construction -- Claude Code prices the [1m] long-context variant at a premium
// and bills background Haiku turns that never appear in any transcript. So live
// is the number to trust, reported is the fallback, estimate is the last resort.
//
// One stat plus one small read per deep session per scan, cached by mtime like
// everything else. A missing file is the normal state for a session that
// predates the hook: null, never an error.
// ---------------------------------------------------------------------------

const STATUSLINE_DIR = path.join(__dirname, '..', 'data', 'statusline');

function pctOf(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** resets_at is epoch SECONDS in the sidecar; every other time here is ms. */
function secsToMs(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : null;
}

function rateWindow(w) {
  if (!w || typeof w !== 'object') return null;
  return { pct: pctOf(w.used_percentage), resetsAt: secsToMs(w.resets_at) };
}

function shapeStatusline(o) {
  const cost = o.cost && typeof o.cost === 'object' ? o.cost : {};
  const win = o.context_window && typeof o.context_window === 'object' ? o.context_window : {};
  const model = o.model && typeof o.model === 'object' ? o.model : {};
  const rl = o.rate_limits && typeof o.rate_limits === 'object' ? o.rate_limits : null;

  // Windows may be absent individually; only publish the ones that are there.
  let rateLimits = null;
  if (rl) {
    const five = rateWindow(rl.five_hour);
    const seven = rateWindow(rl.seven_day);
    const spend = rateWindow(rl.spend_limit);
    rateLimits = {};
    if (five) rateLimits.fiveHour = five;
    if (seven) rateLimits.sevenDay = seven;
    if (spend) rateLimits.spendLimit = spend;
    if (Object.keys(rateLimits).length === 0) rateLimits = null;
  }

  const receivedMs = typeof o.receivedAt === 'string' ? Date.parse(o.receivedAt) : NaN;

  return {
    receivedAt: typeof o.receivedAt === 'string' ? o.receivedAt : null,
    receivedMs: Number.isFinite(receivedMs) ? receivedMs : null,
    totalUsd: Number.isFinite(cost.total_cost_usd) ? round4(cost.total_cost_usd) : null,
    live: {
      model:
        (typeof model.display_name === 'string' && model.display_name) ||
        (typeof model.id === 'string' && model.id) ||
        null,
      contextPct: pctOf(win.used_percentage),
      contextSize: intOrNull(win.context_window_size),
      contextTokens: intOrNull(win.total_input_tokens),
      exceeds200k: o.exceeds_200k_tokens === true,
      rateLimits: rateLimits,
      linesAdded: intOrNull(cost.total_lines_added),
      linesRemoved: intOrNull(cost.total_lines_removed),
    },
  };
}

async function readStatusline(sessionId) {
  const p = path.join(STATUSLINE_DIR, sessionId + '.json');
  const st = await safeStat(p);
  if (!st || !st.isFile()) return null;

  const key = 'sl|' + p + '|' + st.mtimeMs + '|' + st.size;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  let value = null;
  try {
    const parsed = JSON.parse(await fsp.readFile(p, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      value = shapeStatusline(parsed);
    }
  } catch (e) {
    // Caught mid-write by the hook, or a shape we do not know. Null, not an
    // error: the next turn rewrites the file and it comes good on its own.
    value = null;
  }

  cacheSet(key, value);
  return value;
}

// ---------------------------------------------------------------------------
// Agent + session assembly
// ---------------------------------------------------------------------------

// <sessionId>.jsonl transcripts are enumerated as sessions too (see
// readProject); only UUID-shaped basenames qualify.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_PREFIX = 'agent-';
const META_SUFFIX = '.meta.json';

async function readAgent(ctx, subagentsDir, metaFile) {
  const id = metaFile.slice(META_PREFIX.length, metaFile.length - META_SUFFIX.length);
  const metaPath = path.join(subagentsDir, metaFile);
  const jsonlPath = path.join(subagentsDir, META_PREFIX + id + '.jsonl');

  let cached = metaCache.get(metaPath);
  if (cached) {
    cached.seq = scanSeq;
    cached.t = Date.now();
  } else {
    const pair = await Promise.all([
      safeStat(metaPath),
      fsp.readFile(metaPath, 'utf8').catch(function () {
        return null;
      }),
    ]);
    const metaStat = pair[0];
    const rawMeta = pair[1];

    if (rawMeta === null || metaStat === null) {
      ctx.errors.push('agent meta unreadable: ' + metaPath);
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(rawMeta);
    } catch (err) {
      ctx.errors.push(errStr('agent meta unparseable ' + metaPath, err));
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      ctx.errors.push('agent meta is not an object: ' + metaPath);
      return null;
    }

    cached = { seq: scanSeq, t: Date.now(), meta: parsed, spawnedMs: birthMs(metaStat) };
    metaCache.set(metaPath, cached);
  }

  const meta = cached.meta;
  const spawnedMs = cached.spawnedMs;
  const jsonlStat = await safeStat(jsonlPath);

  let lines = null;
  let bytes = null;
  let lastTool = null;
  let lastText = null;
  let lastActivityMs = null;

  if (jsonlStat && jsonlStat.isFile()) {
    lastActivityMs = Number.isFinite(jsonlStat.mtimeMs) && jsonlStat.mtimeMs > 0
      ? jsonlStat.mtimeMs
      : null;
    const info = await inspectJsonl(jsonlPath, jsonlStat, ctx.maxTailBytes);
    lines = info.lines;
    bytes = info.bytes;
    lastTool = info.lastTool;
    lastText = info.lastText;
  }

  // We cannot truly know completion from disk. "done" means only "nothing
  // written to its transcript inside the active window".
  let status;
  if (lastActivityMs === null) status = 'spawning';
  else if (ctx.now - lastActivityMs < ctx.activeWindowMs) status = 'running';
  else status = 'done';

  const agent = {
    id: id,
    agentType: typeof meta.agentType === 'string' ? meta.agentType : null,
    description: typeof meta.description === 'string' ? meta.description : null,
    model: typeof meta.model === 'string' ? meta.model : null,
    spawnDepth: Number.isFinite(meta.spawnDepth) ? meta.spawnDepth : null,
    parentId:
      typeof meta.parentAgentId === 'string' && meta.parentAgentId ? meta.parentAgentId : null,
    toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : null,
    spawnedAt: toIso(spawnedMs),
    lastActivityAt: toIso(lastActivityMs),
    // Windows stat timestamps are fractional — keep these whole milliseconds.
    ageMs: spawnedMs > 0 ? Math.max(0, Math.round(ctx.now - spawnedMs)) : null,
    idleMs: lastActivityMs === null ? null : Math.max(0, Math.round(ctx.now - lastActivityMs)),
    status: status,
    lines: lines,
    bytes: bytes,
    lastTool: lastTool,
    lastText: lastText,
    // Filled in by the token phase once every session has registered its files.
    // Present-and-null rather than absent, so the shape never varies.
    tokens: null,
    costUsd: null,
    costModel: null,
    _spawnedMs: spawnedMs,
    _lastActivityMs: lastActivityMs,
    _tokenTarget: null,
  };

  if (jsonlStat && jsonlStat.isFile()) {
    agent._tokenTarget = registerTokenTarget(ctx, jsonlPath, jsonlStat, agent, false);
  }

  return agent;
}

/**
 * Phase 1: one readdir + one stat per session. This is the whole cost of a
 * shallow session, and it runs for every session before any deep work starts
 * so that scanAgents() can pick the newest transcript globally.
 */
async function readSessionHead(ctx, projectSlug, projectDir, sessionId) {
  const sessionDir = path.join(projectDir, sessionId);
  const subagentsDir = path.join(sessionDir, 'subagents');
  const transcriptPath = path.join(projectDir, sessionId + '.jsonl');

  // One readdir (for the agent count) and one stat (for the activity signal)
  // are the whole cost of a shallow session.
  const head = await Promise.all([
    fsp.readdir(subagentsDir, { withFileTypes: true }).then(
      function (v) {
        return { ok: v };
      },
      function (e) {
        return { err: e };
      }
    ),
    safeStat(transcriptPath),
  ]);
  const transcriptStat = head[1];

  if (head[0].err) {
    const err = head[0].err;
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      // No subagents dir YET. Until 2026-09-05 this was a silent skip, which
      // hid every session until its first subagent spawned -- the main session
      // was invisible exactly while it worked solo (reported as "its not
      // loading in this session"). A transcript on disk is a session; report it with zero
      // agents. A missing dir with no transcript is still nothing to show.
      if (!(transcriptStat && transcriptStat.isFile())) return null;
      head[0] = { ok: [] };
    } else {
      ctx.errors.push(errStr('cannot read subagents dir ' + subagentsDir, err));
      return null;
    }
  }
  const entries = head[0].ok;

  const metaFiles = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.isDirectory() && e.name.startsWith(META_PREFIX) && e.name.endsWith(META_SUFFIX)) {
      metaFiles.push(e.name);
    }
  }

  const hasTranscript = !!(transcriptStat && transcriptStat.isFile());
  const transcriptMs =
    hasTranscript && Number.isFinite(transcriptStat.mtimeMs) && transcriptStat.mtimeMs > 0
      ? transcriptStat.mtimeMs
      : null;

  return {
    sessionId: sessionId,
    projectSlug: projectSlug,
    subagentsDir: subagentsDir,
    transcriptPath: transcriptPath,
    transcriptStat: transcriptStat,
    hasTranscript: hasTranscript,
    transcriptMs: transcriptMs,
    metaFiles: metaFiles,
    isNewest: false,
  };
}

/**
 * Phase 2: turn one head into a session object, reading its agents only if it
 * is being scanned deeply.
 */
async function finishSession(ctx, head) {
  const sessionId = head.sessionId;
  const projectSlug = head.projectSlug;
  const subagentsDir = head.subagentsDir;
  const transcriptPath = head.transcriptPath;
  const transcriptStat = head.transcriptStat;
  const hasTranscript = head.hasTranscript;
  const transcriptMs = head.transcriptMs;
  const metaFiles = head.metaFiles;

  const transcriptActive = transcriptMs !== null && ctx.now - transcriptMs < ctx.activeWindowMs;

  // Deep-scan when asked for everything, when this id was named explicitly,
  // when the session's own transcript says it is live, or when it is the
  // newest transcript on disk. The named ids are a union with that set, never
  // a replacement.
  //
  // The newest-transcript rule closes a real gap: a main agent that blocks on
  // a long fan-out stops writing its own transcript, so its mtime goes stale
  // and the window test would flip the session shallow — hiding exactly the
  // churning subagent tree the dashboard exists to show.
  const deep = ctx.deepAll || ctx.deepIds.has(sessionId) || transcriptActive || head.isNewest;

  if (!deep) {
    // Shallow: same object shape, but no agent files are opened or stat'ed.
    // cwd comes from the head-read cache, which is keyed by path and so is
    // free after the first scan.
    return {
      sessionId: sessionId,
      projectSlug: projectSlug,
      cwd: hasTranscript ? await readSessionCwd(transcriptPath) : null,
      main: buildMain(ctx, transcriptMs, null),
      startedAt: toIso(hasTranscript ? birthMs(transcriptStat) : 0),
      lastActivityAt: toIso(transcriptMs),
      isActive: transcriptActive,
      agentCount: metaFiles.length,
      runningCount: null,
      maxDepth: null,
      shallow: true,
      agents: [],
      tokens: null,
      cost: null,
      live: null,
      _lastMs: transcriptMs,
      _tokenTargets: null,
      _statusline: null,
    };
  }

  const agentResults = await mapLimit(metaFiles, CONCURRENCY, function (name) {
    return readAgent(ctx, subagentsDir, name);
  });

  const agents = [];
  for (let i = 0; i < agentResults.length; i++) {
    const r = agentResults[i];
    if (!r) continue;
    if (r.__error) {
      ctx.errors.push(errStr('agent scan failed in ' + subagentsDir, r.__error));
      continue;
    }
    agents.push(r);
  }

  agents.sort(function (a, b) {
    return (a._spawnedMs || 0) - (b._spawnedMs || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });

  let cwd = null;
  let mainTail = null;
  // Kick the sidecar read off first so it overlaps the transcript work; it is
  // wanted whether or not this session has a transcript on disk.
  const statuslineP = readStatusline(sessionId);
  if (hasTranscript) {
    const pair = await Promise.all([
      readSessionCwd(transcriptPath),
      inspectTranscript(transcriptPath, transcriptStat, ctx.maxTailBytes),
    ]);
    cwd = pair[0];
    mainTail = pair[1];
  }
  const statusline = await statuslineP;

  // startedAt: transcript birthtime, else oldest agent spawnedAt, else null.
  let startedMs = hasTranscript ? birthMs(transcriptStat) : 0;
  if (!startedMs) {
    for (let i = 0; i < agents.length; i++) {
      const s = agents[i]._spawnedMs;
      if (s > 0 && (startedMs === 0 || s < startedMs)) startedMs = s;
    }
  }

  // lastActivityAt: max(transcript mtime, all agent lastActivityAt).
  let lastMs = transcriptMs;

  let maxDepth = 0;
  let runningCount = 0;
  // Every file this session contributes to the token phase, so the roll-up can
  // find them again once the global pass has run.
  const tokenTargets = [];
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    if (a._lastActivityMs !== null && (lastMs === null || a._lastActivityMs > lastMs)) {
      lastMs = a._lastActivityMs;
    }
    if (Number.isFinite(a.spawnDepth) && a.spawnDepth > maxDepth) maxDepth = a.spawnDepth;
    if (a.status === 'running') runningCount++;
    if (a._tokenTarget) tokenTargets.push(a._tokenTarget);
    delete a._spawnedMs;
    delete a._lastActivityMs;
    delete a._tokenTarget;
  }

  const main = buildMain(ctx, transcriptMs, mainTail);
  if (hasTranscript) {
    tokenTargets.push(registerTokenTarget(ctx, transcriptPath, transcriptStat, main, true));
  }

  return {
    sessionId: sessionId,
    projectSlug: projectSlug,
    cwd: cwd,
    main: main,
    startedAt: toIso(startedMs),
    lastActivityAt: toIso(lastMs),
    isActive: lastMs !== null && ctx.now - lastMs < ctx.activeWindowMs,
    agentCount: agents.length,
    runningCount: runningCount,
    maxDepth: maxDepth,
    shallow: false,
    agents: agents,
    tokens: null,
    cost: null,
    live: null,
    _lastMs: lastMs,
    _tokenTargets: tokenTargets,
    _statusline: statusline,
  };
}

async function readProject(ctx, projectSlug) {
  const projectDir = path.join(ctx.projectsRoot, projectSlug);

  let entries;
  try {
    entries = await fsp.readdir(projectDir, { withFileTypes: true });
  } catch (err) {
    ctx.errors.push(errStr('cannot read project dir ' + projectDir, err));
    return [];
  }

  // A session is a <sessionId>/ dir (which appears only on its FIRST Agent
  // spawn) or a bare <sessionId>.jsonl transcript (from its first turn). A
  // main session working solo has only the transcript, so enumerate both and
  // dedupe, or it stays invisible until it fans out. Transcript-derived ids
  // must look like session ids; dirs keep the old, permissive rule.
  const seen = new Set();
  const sessionIds = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let sid = null;
    if (isDirLike(e)) sid = e.name;
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      const base = e.name.slice(0, -'.jsonl'.length);
      if (SESSION_ID_RE.test(base)) sid = base;
    }
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    sessionIds.push(sid);
  }

  const results = await mapLimit(sessionIds, CONCURRENCY, function (sid) {
    return readSessionHead(ctx, projectSlug, projectDir, sid);
  });

  const heads = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) continue;
    if (r.__error) {
      ctx.errors.push(errStr('session scan failed in ' + projectDir, r.__error));
      continue;
    }
    heads.push(r);
  }
  return heads;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan Claude Code's on-disk subagent sidecars and return a live snapshot of
 * the agent fan-out tree. Resolves even when the disk is in a weird state:
 * every failure becomes a string in `errors` rather than a thrown exception.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectsRoot]   default %USERPROFILE%\.claude\projects
 * @param {number} [opts.activeWindowMs] default 90000 — newer than this = "running"
 * @param {number} [opts.maxTailBytes]   default 65536
 * @param {('all'|'active'|string[])} [opts.deep] default 'active'. Which
 *   sessions get their agents read. 'all' scans every session (expensive — the
 *   full tree is gigabytes of jsonl). 'active' scans only sessions whose own
 *   transcript was written inside activeWindowMs. An array deep-scans those
 *   session ids as well as the active ones; unknown ids are ignored. In every
 *   mode except 'all', the session with the newest transcript mtime on disk is
 *   also always scanned deeply, so the one being watched cannot go shallow
 *   while its main transcript is briefly quiet. Every
 *   other session comes back shallow: same keys, but agents: [], shallow: true,
 *   runningCount: null, maxDepth: null, and agentCount from a bare readdir.
 * @returns {Promise<object>} Snapshot
 */
async function scanAgents(opts) {
  const t0 = Date.now();
  scanSeq++;

  const o = opts && typeof opts === 'object' ? opts : {};
  const ctx = {
    now: Date.now(),
    projectsRoot:
      typeof o.projectsRoot === 'string' && o.projectsRoot
        ? o.projectsRoot
        : DEFAULT_PROJECTS_ROOT,
    activeWindowMs:
      Number.isFinite(o.activeWindowMs) && o.activeWindowMs > 0
        ? o.activeWindowMs
        : DEFAULT_ACTIVE_WINDOW_MS,
    maxTailBytes:
      Number.isFinite(o.maxTailBytes) && o.maxTailBytes > 0
        ? o.maxTailBytes
        : DEFAULT_MAX_TAIL_BYTES,
    deepAll: false,
    deepIds: new Set(),
    errors: [],
    // Session-history floor. Parsed leniently like everything else here: a
    // malformed `since` means no filter rather than an error.
    sinceMs: null,
    sinceSession:
      typeof o.sinceSession === 'string' && o.sinceSession ? o.sinceSession : null,
    includeOlder: o.includeOlder === true,
    tokenTargets: [],
    tokenBudgetBytes:
      Number.isFinite(o.tokenBudgetBytes) && o.tokenBudgetBytes >= 0
        ? o.tokenBudgetBytes
        : TOKEN_BUDGET_BYTES,
  };

  // since: ISO string or epoch ms.
  if (typeof o.since === 'number' && Number.isFinite(o.since) && o.since > 0) {
    ctx.sinceMs = o.since;
  } else if (typeof o.since === 'string' && o.since) {
    const parsed = Date.parse(o.since);
    if (Number.isFinite(parsed)) ctx.sinceMs = parsed;
  }

  // One line per scan, not one per agent: the table either loaded at require
  // time or it did not, and every cost estimate is null either way.
  if (PRICING_ERROR) ctx.errors.push(PRICING_ERROR);

  // opts.deep — anything unrecognised falls back to the 'active' default
  // rather than erroring, in keeping with the rest of this module.
  const deepOpt = o.deep;
  if (deepOpt === 'all') {
    ctx.deepAll = true;
  } else if (Array.isArray(deepOpt)) {
    for (let i = 0; i < deepOpt.length; i++) {
      const id = deepOpt[i];
      if (typeof id === 'string' && id) ctx.deepIds.add(id);
    }
  } else if (typeof deepOpt === 'string' && deepOpt && deepOpt !== 'active') {
    // Lenient: a bare session id behaves like a one-element array.
    ctx.deepIds.add(deepOpt);
  }

  let sessions = [];
  let tokenMs = 0;
  let hidden = 0;

  try {
    let slugs = null;
    try {
      const entries = await fsp.readdir(ctx.projectsRoot, { withFileTypes: true });
      slugs = [];
      for (let i = 0; i < entries.length; i++) {
        if (isDirLike(entries[i])) slugs.push(entries[i].name);
      }
    } catch (err) {
      ctx.errors.push(errStr('cannot read projects root ' + ctx.projectsRoot, err));
      slugs = null;
    }

    if (slugs) {
      const perProject = await mapLimit(slugs, CONCURRENCY, function (slug) {
        return readProject(ctx, slug);
      });

      let heads = [];
      for (let i = 0; i < perProject.length; i++) {
        const r = perProject[i];
        if (!r) continue;
        if (r.__error) {
          ctx.errors.push(errStr('project scan failed', r.__error));
          continue;
        }
        for (let j = 0; j < r.length; j++) heads.push(r[j]);
      }

      // Session-history floor, applied between phase 1 and phase 2 so a dropped
      // session costs exactly the one readdir + one stat already spent and is
      // never deep-scanned. sinceSession is always kept: it is the session that
      // set the floor, and hiding it would be absurd.
      if (ctx.sinceMs !== null && !ctx.includeOlder) {
        const kept = [];
        for (let i = 0; i < heads.length; i++) {
          const h = heads[i];
          if (h.sessionId === ctx.sinceSession) {
            kept.push(h);
            continue;
          }
          // A session with no transcript cannot be dated; keep it rather than
          // silently hide something we simply failed to measure.
          const startedMs = h.hasTranscript ? birthMs(h.transcriptStat) : 0;
          if (startedMs > 0 && startedMs < ctx.sinceMs) {
            hidden++;
            continue;
          }
          kept.push(h);
        }
        heads = kept;
      }

      // The single most-recently-written transcript is always scanned deeply,
      // whatever its mtime says about the active window. Redundant under
      // deep:'all', which scans everything anyway.
      let newest = null;
      for (let i = 0; i < heads.length; i++) {
        const h = heads[i];
        if (h.transcriptMs === null) continue;
        if (newest === null || h.transcriptMs > newest.transcriptMs) newest = h;
      }
      if (newest) newest.isNewest = true;

      const finished = await mapLimit(heads, CONCURRENCY, function (h) {
        return finishSession(ctx, h);
      });
      for (let i = 0; i < finished.length; i++) {
        const r = finished[i];
        if (!r) continue;
        if (r.__error) {
          ctx.errors.push(errStr('session scan failed', r.__error));
          continue;
        }
        sessions.push(r);
      }

      sessions.sort(function (a, b) {
        const av = a._lastMs === null ? -Infinity : a._lastMs;
        const bv = b._lastMs === null ? -Infinity : b._lastMs;
        if (bv !== av) return bv - av;
        return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
      });
      for (let i = 0; i < sessions.length; i++) delete sessions[i]._lastMs;
    }
  } catch (err) {
    // Belt and braces: the contract is that this never throws.
    ctx.errors.push(errStr('unexpected scan failure', err));
  }

  // Tokens run last and globally: every deep session has registered its files
  // by now, so the shared budget can go to the most recently written ones
  // wherever they live rather than to whichever session finished first.
  try {
    tokenMs = await runTokenPhase(ctx);
    for (let i = 0; i < sessions.length; i++) rollUpSessionTokens(sessions[i]);
  } catch (err) {
    // Token accounting is additive: if it fails the rest of the snapshot is
    // still good, so report and carry on rather than losing the whole scan.
    ctx.errors.push(errStr('token scan failure', err));
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      delete s._tokenTargets;
      delete s._statusline;
      if (s.tokens === undefined) s.tokens = null;
      if (s.cost === undefined) s.cost = null;
      if (s.live === undefined) s.live = null;
    }
  }

  try {
    evictStale();
  } catch (e) {
    /* ignore */
  }

  return {
    generatedAt: new Date().toISOString(),
    scanMs: Date.now() - t0,
    // What the session list was narrowed to, so the UI can offer the rest.
    filter: {
      since: ctx.sinceMs === null ? null : toIso(ctx.sinceMs),
      sinceSession: ctx.sinceSession,
      includeOlder: ctx.includeOlder,
      hidden: hidden,
    },
    // Share of scanMs spent reading and parsing transcripts for tokens. Held
    // under TOKEN_TIME_BUDGET_MS; a cold start spreads the backlog over scans.
    tokenMs: tokenMs,
    errors: ctx.errors,
    sessions: sessions,
  };
}

module.exports = { scanAgents, __tokenStats: tokenStats };

// ---------------------------------------------------------------------------
// CLI: node lib/agents.js
// ---------------------------------------------------------------------------

if (require.main === module) {
  scanAgents()
    .then(function (snapshot) {
      console.log(JSON.stringify(snapshot, null, 2));
      let totalAgents = 0;
      let running = 0;
      let active = 0;
      let deep = 0;
      for (let i = 0; i < snapshot.sessions.length; i++) {
        const s = snapshot.sessions[i];
        totalAgents += s.agentCount;
        running += s.runningCount || 0;
        if (s.isActive) active++;
        if (!s.shallow) deep++;
      }
      process.stderr.write(
        '[agents] ' +
          snapshot.sessions.length +
          ' sessions (' +
          active +
          ' active, ' +
          deep +
          ' deep), ' +
          totalAgents +
          ' agents, ' +
          running +
          ' running, ' +
          snapshot.errors.length +
          ' errors, ' +
          snapshot.scanMs +
          'ms\n'
      );
    })
    .catch(function (err) {
      // Should be unreachable — scanAgents never rejects.
      process.stderr.write('[agents] FATAL ' + (err && err.stack ? err.stack : err) + '\n');
      process.exitCode = 1;
    });
}
