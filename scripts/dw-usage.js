#!/usr/bin/env node
'use strict';
// dw usage stats: tokens and ESTIMATED $ per dw item (GitHub issue or local item), from Claude Code transcripts (read-only).
//   node dw-usage.js item   --id 42 [--root <research root> | --item-dir <dir>] [--projects-dir <dir>]
//   node dw-usage.js item   --item-dir <dir> --session <id[,id]>   (a folder without an item id: count these sessions;
//                                                                    remembered in usage.json for later refreshes)
//        -> <item folder>/usage.json + usage.md   (refresh = item + report)
//   node dw-usage.js report [--root <research root>] [--projects-dir <dir>]
//        -> <research root>/usage-dashboard.html + usage-help.html from all <item folder>/usage.json
// Sources: <projects-dir>/*/<session>.jsonl and <session>/subagents/agent-*.jsonl (+ .meta.json agentType).
// Attribution per entry: cwd ...\worktrees\<id>-slug, else gitBranch .../<id>_slug; entries without an id (e.g. work done
// in the main checkout before the worktree was entered) get the id that dominates their session.
// Settings (areas, stages, thresholds): scripts/usage-config.json, overridden by <research root>/usage-config.local.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// user entries that are not something the user typed to Claude
const NOISE_PROMPT = /^\s*(<task-notification|<local-command|<system-reminder|<bash-|\[Request interrupted)/;
const STAGE_ORDER = ['understand', 'implement', 'test', 'review', 'pr feedback', 'ceremony', 'conversation', 'other'];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(argv[i]);
  }
  return out;
}
function fail(m) {
  process.stderr.write(m + '\n');
  process.exit(1);
}
function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return null;
  }
}
function readText(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch (_) {
    return '';
  }
}
const argStr = (v) => (v && v !== true ? String(v) : null);

// ---------- config ----------
function loadConfig(root) {
  const cfg = readJson(path.join(__dirname, 'usage-config.json')) || {};
  const local = root ? readJson(path.join(root, 'usage-config.local.json')) : null;
  if (local) {
    for (const [k, v] of Object.entries(local)) {
      if (k === 'thresholds' && v && typeof v === 'object') {
        cfg.thresholds = { ...(cfg.thresholds || {}) };
        for (const [t, r] of Object.entries(v)) cfg.thresholds[t] = { ...(cfg.thresholds[t] || {}), ...r };
      } else cfg[k] = v;
    }
  }
  cfg.active_gap_min = cfg.active_gap_min || 15;
  cfg.context_heavy_tokens = cfg.context_heavy_tokens || 150000;
  const lookup = {};
  for (const [stage, names] of Object.entries(cfg.stages || {})) for (const n of names) lookup[n] = stage;
  cfg._stageOf = (phase) => (phase === 'main' ? 'conversation' : lookup[phase.startsWith('main:') ? phase.slice(5) : phase] || 'other');
  const a = cfg.areas || {};
  cfg._areas = {
    rules: (a.rules || []).map((r) => ({ re: new RegExp(r.match), area: r.area, module: r.module || r.area })),
    test: a.test_match ? new RegExp(a.test_match) : null,
    ignore: a.ignore ? new RegExp(a.ignore) : null,
  };
  return cfg;
}

// ---------- locating transcripts ----------
function walkJsonl(projectsDir) {
  const files = []; // {file, session, project, agent}
  let projects = [];
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (_) {
    return files;
  }
  for (const p of projects) {
    const pdir = path.join(projectsDir, p.name);
    for (const e of fs.readdirSync(pdir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        files.push({ file: path.join(pdir, e.name), session: e.name.slice(0, -6), project: p.name, agent: null });
      } else if (e.isDirectory()) {
        const sub = path.join(pdir, e.name, 'subagents');
        let list = [];
        try {
          list = fs.readdirSync(sub);
        } catch (_) {
          continue;
        }
        for (const f of list.filter((x) => x.endsWith('.jsonl'))) {
          const meta = readJson(path.join(sub, f.replace(/\.jsonl$/, '.meta.json')));
          files.push({ file: path.join(sub, f), session: e.name, project: p.name, agent: (meta && meta.agentType) || 'subagent' });
        }
      }
    }
  }
  return files;
}

// Item id of a transcript entry: the worktree folder (<...>worktrees/<id>-<slug>) or the branch's last segment
// (default branch_template {prefix}/{id}-{slug}); ids are issue numbers or local-<n>.
const ID_AT_START = /^(\d+|local-\d+)(?:[-_]|$)/i;
const ref = (id) => (/^\d+$/.test(String(id)) ? '#' + id : String(id || ''));

function idFromEntry(o) {
  const cwd = String(o.cwd || '').replace(/\\/g, '/');
  const w = cwd.match(/worktrees\/([^/]+)/i);
  let m = w && ID_AT_START.exec(w[1]);
  if (m) return m[1].toLowerCase();
  const last = String(o.gitBranch || '').split('/').pop();
  m = ID_AT_START.exec(last);
  return m ? m[1].toLowerCase() : null;
}

function promptText(o) {
  const c = o.message && o.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result')) {
    const t = c.find((b) => b && b.type === 'text');
    return t ? t.text : null;
  }
  return null;
}

// One pass per file: API calls (with edited file paths), compactions and, for main sessions, the user's prompts.
// Sticky skill attribution (main sessions): Claude Code tags only the first turns after a skill loads with
// attributionSkill. An untagged call inherits the last skill seen in the file until the user's next own prompt, so
// "conversation" means turns that answer a prompt of the user, not the untagged rest of a running pipeline.
function readEntries(f) {
  const out = [];
  const text = readText(f.file);
  let sticky = null;
  for (const line of text.split('\n')) {
    const isUsage = line.includes('"usage"') && line.includes('"assistant"');
    const isUser = !f.agent && line.includes('"type"') && line.includes('"user"');
    if (!isUsage && !isUser && !line.includes('compact_boundary')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const cm = o.compactMetadata || {};
      out.push({ kind: 'compact', key: 'c|' + (o.uuid || o.timestamp), session: f.session, project: f.project, ts: o.timestamp || null, id: idFromEntry(o), trigger: cm.trigger || 'auto', pre: cm.preTokens || 0, post: cm.postTokens || 0 });
      continue;
    }
    if (o.type === 'user') {
      if (f.agent || o.isMeta || o.isCompactSummary || o.toolUseResult) continue;
      const t = promptText(o);
      if (!t || NOISE_PROMPT.test(t)) continue;
      sticky = null;
      out.push({ kind: 'prompt', key: 'p|' + (o.uuid || o.timestamp), session: f.session, project: f.project, ts: o.timestamp || null, id: idFromEntry(o) });
      continue;
    }
    if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
    if (!f.agent && o.attributionSkill) sticky = o.attributionSkill;
    const files = [];
    for (const b of Array.isArray(o.message.content) ? o.message.content : []) {
      if (b && b.type === 'tool_use' && EDIT_TOOLS.has(b.name) && b.input) {
        const p = b.input.file_path || b.input.notebook_path;
        if (p) files.push(String(p));
      }
    }
    out.push({
      key: (o.message.id || o.uuid) + '|' + (o.requestId || ''),
      session: f.session,
      project: f.project,
      agent: f.agent,
      skill: o.attributionSkill || (f.agent ? null : sticky),
      model: o.message.model || 'unknown',
      ts: o.timestamp || null,
      id: idFromEntry(o),
      u: o.message.usage,
      files,
    });
  }
  return out;
}

// ---------- pricing ----------
function loadPrices() {
  return readJson(path.join(__dirname, 'usage-prices.json')) || { default: { input: 3, output: 15 } };
}
function rates(prices, model, unknown) {
  let r = prices[model];
  if (!r) {
    unknown.add(model);
    r = prices.default || { input: 3, output: 15 };
  }
  return {
    input: r.input,
    output: r.output,
    read: r.cache_read != null ? r.cache_read : r.input * 0.1,
    w5: r.cache_write_5m != null ? r.cache_write_5m : r.input * 1.25,
    w1: r.cache_write_1h != null ? r.cache_write_1h : r.input * 2,
  };
}
function tokensOf(u) {
  const cc = u.cache_creation || {};
  const w1 = cc.ephemeral_1h_input_tokens || 0;
  const w5 = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, (u.cache_creation_input_tokens || 0) - w1);
  return { input: u.input_tokens || 0, output: u.output_tokens || 0, read: u.cache_read_input_tokens || 0, w5, w1 };
}
function costOf(t, r) {
  return (t.input * r.input + t.output * r.output + t.read * r.read + t.w5 * r.w5 + t.w1 * r.w1) / 1e6;
}
const zero = () => ({ input: 0, output: 0, read: 0, w5: 0, w1: 0, usd: 0, calls: 0 });
function add(a, t, usd) {
  a.input += t.input;
  a.output += t.output;
  a.read += t.read;
  a.w5 += t.w5;
  a.w1 += t.w1;
  a.usd += usd;
  a.calls += 1;
}
// Minutes of activity: sum of gaps between consecutive timestamps that are at most gapMin apart.
function activeMin(tsList, gapMin) {
  const ms = tsList.map((t) => Date.parse(t)).filter((x) => !isNaN(x)).sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < ms.length; i++) {
    const d = ms[i] - ms[i - 1];
    if (d <= gapMin * 60e3) sum += d;
  }
  return +(sum / 60e3).toFixed(1);
}

// ---------- collect ----------
function collect(projectsDir) {
  const files = walkJsonl(projectsDir);
  const byKey = new Map(); // dedupe streaming duplicates: keep the last entry, union the edited files of all chunks
  for (const f of files) {
    for (const e of readEntries(f)) {
      const prev = byKey.get(e.key);
      if (prev && prev.files && prev.files.length) e.files = [...new Set([...prev.files, ...(e.files || [])])];
      byKey.set(e.key, e);
    }
  }
  const all = [...byKey.values()];
  const entries = all.filter((e) => !e.kind);
  const compacts = all.filter((e) => e.kind === 'compact');
  const prompts = all.filter((e) => e.kind === 'prompt');
  // dominant id per session
  const votes = new Map();
  for (const e of entries) {
    if (!e.id) continue;
    const m = votes.get(e.session) || new Map();
    m.set(e.id, (m.get(e.id) || 0) + 1);
    votes.set(e.session, m);
  }
  const dominant = new Map();
  for (const [s, m] of votes) dominant.set(s, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  for (const e of entries) {
    e.inferred = !e.id;
    if (!e.id) e.id = dominant.get(e.session) || null;
  }
  for (const c of compacts.concat(prompts)) {
    c.inferred = !c.id;
    if (!c.id) c.id = dominant.get(c.session) || null;
  }
  return { entries, compacts, prompts };
}

function summarize(entries, prices, compacts, cfg) {
  const unknown = new Set();
  const total = zero();
  const byModel = {};
  const byPhase = {};
  const byStage = {};
  const stageTs = {};
  const sessions = {};
  const mainModel = {};
  const main = { usd: 0, calls: 0, heavy_usd: 0, heavy_calls: 0 };
  const files = new Set();
  const allTs = [];
  let first = null;
  let last = null;
  let subCost = 0;
  const ctxPts = [];
  for (const e of entries) {
    const t = tokensOf(e.u);
    const r = rates(prices, e.model, unknown);
    const usd = costOf(t, r);
    add(total, t, usd);
    add((byModel[e.model] = byModel[e.model] || zero()), t, usd);
    const phase = e.agent || (e.skill ? 'main:' + e.skill : 'main');
    add((byPhase[phase] = byPhase[phase] || zero()), t, usd);
    const stage = cfg._stageOf(phase);
    const bs = (byStage[stage] = byStage[stage] || { usd: 0, calls: 0, minutes: 0 });
    bs.usd += usd;
    bs.calls += 1;
    const s = (sessions[e.session] = sessions[e.session] || { ...zero(), first: e.ts, last: e.ts });
    add(s, t, usd);
    for (const f of e.files || []) files.add(f);
    if (e.ts) {
      (stageTs[stage] = stageTs[stage] || []).push(e.ts);
      allTs.push(e.ts);
      if (!s.first || e.ts < s.first) s.first = e.ts;
      if (!s.last || e.ts > s.last) s.last = e.ts;
      if (!first || e.ts < first) first = e.ts;
      if (!last || e.ts > last) last = e.ts;
    }
    if (e.agent) subCost += usd;
    else {
      const ctx = t.input + t.read + t.w5 + t.w1;
      main.usd += usd;
      main.calls += 1;
      mainModel[e.model] = (mainModel[e.model] || 0) + usd;
      if (ctx > cfg.context_heavy_tokens) {
        main.heavy_usd += usd;
        main.heavy_calls += 1;
      }
      if (e.ts) ctxPts.push({ ts: e.ts, session: e.session, ctx });
    }
  }
  for (const [k, v] of Object.entries(stageTs)) byStage[k].minutes = activeMin(v, cfg.active_gap_min);
  main.usd_per_call = main.calls ? main.usd / main.calls : 0;
  main.model = Object.entries(mainModel).sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || null;
  const context = contextStats(ctxPts, compacts, prices);
  const inputAll = total.input + total.read + total.w5 + total.w1;
  return {
    total,
    cache_read_ratio: inputAll ? total.read / inputAll : 0,
    subagent_share: total.usd ? subCost / total.usd : 0,
    active_min: activeMin(allTs, cfg.active_gap_min),
    main,
    by_stage: byStage,
    by_model: byModel,
    by_phase: byPhase,
    sessions,
    context,
    files: [...files],
    first,
    last,
    unknown_models: [...unknown],
  };
}

// ---------- context size ----------
// Window: prices.context_window (default 200k); a session that ever exceeded it (call or compaction) is treated as the 1M window.
function contextStats(pts, compacts, prices) {
  const base = prices.context_window || 200000;
  const ext = prices.context_window_extended || 1000000;
  const win = new Map();
  for (const p of pts) win.set(p.session, Math.max(win.get(p.session) || 0, p.ctx));
  for (const c of compacts) win.set(c.session, Math.max(win.get(c.session) || 0, c.pre));
  const windowOf = (s) => ((win.get(s) || 0) > base ? ext : base);
  const series = pts
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : 1))
    .map((p) => ({ ts: p.ts, ctx: p.ctx, win: windowOf(p.session), pct: Math.min(100, (p.ctx / windowOf(p.session)) * 100) }));
  const step = Math.ceil(series.length / 400) || 1; // keep usage.json small: peak per bucket
  const points = [];
  for (let i = 0; i < series.length; i += step) {
    const b = series.slice(i, i + step);
    const top = b.reduce((m, x) => (x.pct > m.pct ? x : m), b[0]);
    points.push([top.ts, +top.pct.toFixed(1)]);
  }
  const events = compacts.map((c) => ({ ts: c.ts, trigger: c.trigger, pre: c.pre, post: c.post })).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const top = series.reduce((m, x) => (x.pct > m.pct ? x : m), { pct: 0, ctx: 0, win: base });
  return {
    window: top.win,
    peak_pct: +top.pct.toFixed(1),
    peak_tokens: top.ctx,
    avg_pct: series.length ? +(series.reduce((n, x) => n + x.pct, 0) / series.length).toFixed(1) : 0,
    compactions: { auto: events.filter((e) => e.trigger !== 'manual').length, manual: events.filter((e) => e.trigger === 'manual').length, events },
    points,
  };
}

// ---------- areas ----------
function areaOf(file, A) {
  let p = String(file).replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  if (A.ignore && A.ignore.test(p)) return { ignored: true };
  for (const r of A.rules) {
    const m = r.re.exec(p);
    if (!m) continue;
    const fill = (tpl) => tpl.replace(/\$(\d)/g, (_, n) => m[+n] || '');
    const area = fill(r.area);
    const refs = [...r.module.matchAll(/\$(\d)/g)].map((x) => +x[1]);
    const module = refs.some((n) => !m[n]) ? area : fill(r.module);
    return { area, module, kind: A.test && A.test.test(p) ? 'test' : 'prod' };
  }
  return null;
}
function areasOf(files, A) {
  const groups = {};
  let unmapped = 0;
  const seen = new Set();
  for (const f of files) {
    const norm = String(f).replace(/\\/g, '/').toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    const a = areaOf(f, A);
    if (!a) unmapped++;
    if (!a || a.ignored) continue;
    const k = a.area + '|' + a.module + '|' + a.kind;
    (groups[k] = groups[k] || { area: a.area, module: a.module, kind: a.kind, files: 0 }).files++;
  }
  return { areas: Object.values(groups).sort((x, y) => (x.area + x.module < y.area + y.module ? -1 : 1)), unmapped_files: unmapped };
}

// ---------- research root ----------
function researchRoot(a) {
  const root = require('../hooks/lib/profiles').researchRoot(process.cwd(), a.root);
  if (!root) fail('not in a git repo and no --root given');
  return root;
}
// Closed items live in <root>/archive/<id>-<slug> (dw-state.js archive); they keep counting on the dashboard.
const ARCHIVE = 'archive';
// Item folders of the root and of <root>/archive
function itemDirs(root) {
  const out = [];
  for (const base of [root, path.join(root, ARCHIVE)]) {
    try {
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        if (d.isDirectory() && !(base === root && d.name.toLowerCase() === ARCHIVE)) out.push({ name: d.name, dir: path.join(base, d.name) });
      }
    } catch (_) {
      /* no such folder */
    }
  }
  return out;
}
// The research root of an item folder (an archived folder's root is two levels up)
function itemRootOf(dir) {
  const parent = path.dirname(path.resolve(dir));
  return path.basename(parent).toLowerCase() === ARCHIVE ? path.dirname(parent) : parent;
}
function findItemDir(root, id) {
  const hit = itemDirs(root).find((x) => x.name.toLowerCase() === id || x.name.toLowerCase().startsWith(id + '-'));
  return hit ? hit.dir : null;
}

// ---------- formatting ----------
const fmt = (n) => Math.round(n || 0).toLocaleString('en-US');
const usd = (n) => '$' + (n || 0).toFixed(2);
const pct = (n) => ((n || 0) * 100).toFixed(0) + '%';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const minutes = (m) => (m == null ? '-' : m < 60 ? Math.round(m) + 'm' : Math.floor(m / 60) + 'h ' + String(Math.round(m % 60)).padStart(2, '0') + 'm');
function fmtVal(v, format) {
  if (v == null) return '-';
  if (format === 'pct') return pct(v);
  if (format === 'tokens') return Math.round(v / 1000) + 'k';
  if (format === 'x') return v.toFixed(1) + 'x';
  return fmt(v);
}
const labelOf = (i) => (i.item_id ? ref(i.item_id) : i.label || '?');

// ---------- metrics and thresholds ----------
// by_stage for usage.json files written before stages existed
function stagesOf(i, cfg) {
  if (i.by_stage) return i.by_stage;
  const s = {};
  for (const [k, v] of Object.entries(i.by_phase || {})) {
    const st = cfg._stageOf(k);
    s[st] = s[st] || { usd: 0, calls: 0, minutes: null };
    s[st].usd += v.usd;
    s[st].calls += v.calls;
  }
  return s;
}
function metricsOf(i, cfg, range) {
  const T = (i.total && i.total.usd) || 0;
  const st = stagesOf(i, cfg);
  const ph = i.by_phase || {};
  const su = (k) => (st[k] || {}).usd || 0;
  const p = (k) => ph[k] || { usd: 0, calls: 0 };
  return {
    ceremony_share: T ? su('ceremony') / T : null,
    conversation_share: T ? su('conversation') / T : null,
    heavy_context_share: T && i.main ? i.main.heavy_usd / T : null,
    peak_context_tokens: i.context ? i.context.peak_tokens : null,
    test_to_impl_ratio: p('dw:implementer').usd > 0 && p('dw:test-author').usd > 0 ? p('dw:test-author').usd / p('dw:implementer').usd : null,
    explore_calls: p('Explore').calls + p('general-purpose').calls,
    over_estimate: range && range.high ? T / range.high : null,
    after_merge_share: i.final && T ? (i.usd_after_merge || 0) / T : null,
    user_prompts: i.prompts != null ? i.prompts : null,
    compactions: i.context ? i.context.compactions.auto + i.context.compactions.manual : null,
  };
}
function flagsOf(m, cfg) {
  return Object.entries(cfg.thresholds || {})
    .filter(([k, t]) => m[k] != null && t && t.max != null && m[k] > t.max)
    .map(([k]) => k);
}

// Expected cost range per size: 25th-75th percentile of merged items of that size when >= 3 exist, else the editable defaults.
function expectedRange(size, items, prices) {
  const same = items
    .filter((i) => i.final && i.estimate && i.estimate.size === size)
    .map((i) => i.total.usd)
    .sort((a, b) => a - b);
  if (same.length >= 3) return { low: same[Math.floor(same.length * 0.25)], high: same[Math.min(same.length - 1, Math.floor(same.length * 0.75))], src: 'history' };
  const d = (prices.size_usd || {})[size];
  return d ? { low: d[0], high: d[1], src: 'default' } : null;
}
function whyHints(i) {
  const g = i.signals || {};
  const h = [];
  if (g.sessions >= 3) h.push(`${g.sessions} sessions (restarts or scope drift)`);
  if (g.iterations >= 2) h.push(`scope grew: ${g.iterations} iterations`);
  if (g.fix_cycles >= 2) h.push(`${g.fix_cycles} fix cycles`);
  if (g.superseded_decisions >= 1) h.push(`${g.superseded_decisions} spec decisions changed`);
  if (g.compactions >= 2) h.push(`${g.compactions} compactions (context overflow)`);
  const amb = (i.estimate && i.estimate.ambiguity) || [];
  if (amb.length >= 2) h.push('unclear at start: ' + amb.join(', '));
  return h;
}

// ---------- usage.md ----------
function itemMd(i, cfg, prices) {
  const range = i.estimate ? expectedRange(i.estimate.size, [], prices) : null;
  const m = metricsOf(i, cfg, range);
  const flags = flagsOf(m, cfg);
  const T = i.total.usd || 1;
  const L = [`# Usage ${labelOf(i)}`, ''];
  L.push(i.final ? `Status: **merged** ${i.merged_at} · cost up to merge ${usd(i.usd_to_merge)}, after merge ${usd(i.usd_after_merge)}` : i.item_id ? 'Status: **in progress** (no merged PR yet)' : `Scope: sessions ${(i.scope.sessions || []).join(', ')}`, '');
  L.push(`Estimated list-price cost (not a bill): **${usd(i.total.usd)}** · ${i.total.calls} API calls · ${i.first || '?'} → ${i.last || '?'}`, '');
  L.push(`Active time ${minutes(i.active_min)} · your prompts ${i.prompts} · sessions ${i.sessions} · subagent share ${pct(i.subagent_share)} · main model ${i.main.model || '-'} · plugin ${i.plugin_version || '-'}`);
  L.push(`Tokens: input ${fmt(i.total.input)} · output ${fmt(i.total.output)} · cache read ${fmt(i.total.read)} · cache write ${fmt(i.total.w5 + i.total.w1)}`);
  const cx = i.context;
  L.push(`Context: peak ${cx.peak_pct}% of ${fmt(cx.window)} (${fmt(cx.peak_tokens)} tokens) · average ${cx.avg_pct}% · compactions ${cx.compactions.auto + cx.compactions.manual} · main session ${usd(i.main.usd_per_call)}/call · calls above ${fmt(cfg.context_heavy_tokens)} tokens: ${i.main.heavy_calls} (${usd(i.main.heavy_usd)})`, '');
  L.push('## Signals', '');
  if (!flags.length) L.push('None of the thresholds is crossed.');
  for (const k of flags) {
    const t = cfg.thresholds[k];
    L.push(`- **${t.label || k}**: ${fmtVal(m[k], t.format)} (threshold ${fmtVal(t.max, t.format)})`);
  }
  L.push('', 'How to read these numbers: `usage-help.html` in the research root.', '');
  L.push('## By stage', '', '| Stage | $ | Share | Calls | Active |', '|---|---:|---:|---:|---:|');
  for (const s of STAGE_ORDER) {
    const v = i.by_stage[s];
    if (v) L.push(`| ${s} | ${usd(v.usd)} | ${pct(v.usd / T)} | ${v.calls} | ${minutes(v.minutes)} |`);
  }
  L.push('', '## Areas', '');
  if (!i.areas.length) L.push('No mapped files changed.');
  else {
    L.push('| Area | Module | Prod files | Test files |', '|---|---|---:|---:|');
    const mods = {};
    for (const a of i.areas) {
      const r = (mods[a.area + '|' + a.module] = mods[a.area + '|' + a.module] || { area: a.area, module: a.module, prod: 0, test: 0 });
      r[a.kind] += a.files;
    }
    for (const r of Object.values(mods)) L.push(`| ${r.area} | ${r.module} | ${r.prod} | ${r.test} |`);
  }
  if (i.unmapped_files) L.push('', `${i.unmapped_files} changed file(s) outside the area rules (research notes, other repos).`);
  if (i.outcome) {
    const o = i.outcome;
    L.push('', '## Outcome (merged PRs)', '', `+${fmt(o.additions)} / -${fmt(o.deletions)} lines · ${o.changed_files} files · ${usd(i.total.usd / (o.changed_files || 1))} per changed file · ${o.reviews} reviews · ${o.review_threads} review threads (incl. bots)` + (i.estimate ? ` · files estimated ${i.estimate.files_touched}, actual ${o.changed_files}` : ''));
  }
  L.push('', '## By phase', '', '| Phase | Stage | Calls | Output tok | $ |', '|---|---|---:|---:|---:|');
  for (const [k, v] of Object.entries(i.by_phase).sort((a, b) => b[1].usd - a[1].usd)) L.push(`| ${k} | ${cfg._stageOf(k)} | ${v.calls} | ${fmt(v.output)} | ${usd(v.usd)} |`);
  L.push('', '## By model', '', '| Model | Calls | $ |', '|---|---:|---:|');
  for (const [k, v] of Object.entries(i.by_model).sort((a, b) => b[1].usd - a[1].usd)) L.push(`| ${k} | ${v.calls} | ${usd(v.usd)} |`);
  if (i.signals) {
    const g = i.signals;
    L.push('', '## How it went', '', `Sessions ${g.sessions} · iterations ${g.iterations} · fix cycles ${g.fix_cycles} · superseded spec decisions ${g.superseded_decisions} · compactions ${g.compactions}`);
    const e = i.estimate;
    L.push(e ? `Estimate at plan approval: size **${e.size}**, ${e.files_touched} files, ${e.projects_touched} projects, ambiguity: ${(e.ambiguity || []).join(', ') || 'none'} (confidence ${e.confidence})` : 'No complexity estimate recorded (estimate.json missing).');
  }
  if (i.unknown_models.length) L.push('', `Prices missing for: ${i.unknown_models.join(', ')} (default rate used; edit scripts/usage-prices.json).`);
  return L.join('\n') + '\n';
}

// ---------- charts ----------
function chart(points, events, maxGapMs, w = 760, h = 150) {
  if (!points || !points.length) return '<p class="mut">no context data</p>';
  const L = 38;
  const R = 8;
  const T = 8;
  const B = 22;
  const ts = points.map((p) => Date.parse(p[0]));
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts, t0 + 1);
  const X = (t) => L + ((t - t0) / (t1 - t0)) * (w - L - R);
  const Y = (v) => T + (1 - Math.min(100, v) / 100) * (h - T - B);
  let g = '';
  for (const v of [0, 50, 100]) g += `<line x1="${L}" x2="${w - R}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${L - 4}" y="${Y(v) + 4}" text-anchor="end" class="lbl">${v}%</text>`;
  const days = [];
  for (let d = new Date(t0); d.getTime() <= t1; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))) {
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    if (day.getTime() >= t0) days.push(day);
  }
  const stride = Math.max(1, Math.ceil(days.length / 8));
  days.forEach((d, i) => {
    if (i % stride) return;
    g += `<line x1="${X(d.getTime())}" x2="${X(d.getTime())}" y1="${T}" y2="${h - B}" class="grid"/><text x="${X(d.getTime())}" y="${h - 6}" class="lbl">${d.toISOString().slice(5, 10)}</text>`;
  });
  let seg = [];
  const segs = [];
  points.forEach((p, i) => {
    if (seg.length && ts[i] - ts[i - 1] > maxGapMs) {
      segs.push(seg);
      seg = [];
    }
    seg.push([X(ts[i]), Y(p[1])]);
  });
  segs.push(seg);
  for (const sg of segs) {
    const pts = sg.map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' ');
    g += sg.length > 1 ? `<polyline points="${pts}" class="line"/>` : `<circle cx="${sg[0][0]}" cy="${sg[0][1]}" r="2" class="dot"/>`;
  }
  for (const e of events || []) {
    const t = Date.parse(e.ts);
    if (t >= t0 && t <= t1) g += `<line x1="${X(t)}" x2="${X(t)}" y1="${T}" y2="${h - B}" class="${e.trigger === 'manual' ? 'cm' : 'ca'}"><title>${esc(e.trigger)} compaction ${fmt(e.pre)} → ${fmt(e.post)} tokens</title></line>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="context size over time">${g}</svg>`;
}

// ---------- coverage: how much of all transcript $ in the period is in an item ----------
function coverage(col, items, prices, claims) {
  const firsts = items.map((i) => i.first).filter(Boolean).sort();
  const lasts = items.map((i) => i.last).filter(Boolean).sort();
  if (!col || !firsts.length) return null;
  const from = firsts[0];
  const to = lasts[lasts.length - 1];
  const keys = new Set(items.map((i) => (i.item_id ? String(i.item_id).toLowerCase() : i.label)));
  const unknown = new Set();
  const out = { from, to, total: 0, tracked: 0, id_without_usage: {}, no_id_by_project: {} };
  for (const e of col.entries) {
    if (!e.ts || e.ts < from || e.ts > to) continue;
    const c = costOf(tokensOf(e.u), rates(prices, e.model, unknown));
    const owner = ownerOf(e, claims);
    out.total += c;
    if (owner && keys.has(owner)) out.tracked += c;
    else if (owner) out.id_without_usage[owner] = (out.id_without_usage[owner] || 0) + c;
    else out.no_id_by_project[e.project] = (out.no_id_by_project[e.project] || 0) + c;
  }
  return out;
}

// ---------- dashboard ----------
const CSS = `:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#ddd;--bar:#4c7cf0;--chip:#eef2ff;--warn:#b45309;--warnbg:#fef3c7;--ok:#16a34a;--bad:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mut:#999;--line:#333;--bar:#6b93ff;--chip:#1f2a44;--warn:#fbbf24;--warnbg:#3a2a05;--ok:#4ade80;--bad:#f87171}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:16px}
h2{margin-top:32px}table{border-collapse:collapse;width:100%;margin:8px 0 16px}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600}.n{text-align:right;white-space:nowrap}
.bar{height:4px;background:var(--bar);margin-top:2px}.cards{display:flex;flex-wrap:wrap;gap:12px}.card{min-width:150px;padding:10px 14px;border:1px solid var(--line);border-radius:8px}
.card b{display:block;font-size:22px}.mut{color:var(--mut)}.ok{color:var(--ok)}.bad{color:var(--bad);font-weight:600}.wip{color:var(--warn)}
.chip{display:inline-block;margin:1px 2px;padding:0 6px;border-radius:10px;background:var(--chip);font-size:12px}
.flag{display:inline-block;margin:1px 2px;padding:0 6px;border-radius:10px;background:var(--warnbg);color:var(--warn);font-size:12px;text-decoration:none}
.grid{stroke:var(--line);stroke-width:1}.lbl{fill:var(--mut);font-size:10px}.line{fill:none;stroke:var(--bar);stroke-width:1.5}.dot{fill:var(--bar)}
.ca{stroke:#e5484d;stroke-dasharray:3 3}.cm{stroke:#3b82f6;stroke-dasharray:3 3}details{margin:6px 0}summary{cursor:pointer}
.filter{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0;padding:10px;border:1px solid var(--line);border-radius:8px}
select{padding:4px;background:var(--bg);color:var(--fg);border:1px solid var(--line)}a{color:var(--bar)}.help{font-size:12px;text-decoration:none}
.scroll{overflow-x:auto}`;

function dashboard(items, cfg, cov) {
  const prices = loadPrices();
  const data = items
    .slice()
    .sort((a, b) => b.total.usd - a.total.usd)
    .map((i) => {
      const range = i.estimate ? expectedRange(i.estimate.size, items, prices) : null;
      const m = metricsOf(i, cfg, range);
      const est = i.estimate
        ? {
            size: i.estimate.size,
            files: i.estimate.files_touched != null ? i.estimate.files_touched : null,
            range: range ? usd(range.low) + ' - ' + usd(range.high) + (range.src === 'default' ? ' *' : '') : '-',
            verdict: range && i.total.usd > range.high ? 'over x' + (i.total.usd / range.high).toFixed(1) : 'within',
            hints: whyHints(i).join('; '),
          }
        : null;
      return {
        key: labelOf(i),
        title: i.title || '',
        final: !!i.final,
        folder: !i.item_id,
        usd: i.total.usd,
        to_merge: i.usd_to_merge,
        after_merge: i.usd_after_merge,
        last: (i.last || '').slice(0, 10),
        sessions: i.sessions,
        prompts: i.prompts,
        active: i.active_min,
        peak: i.context ? i.context.peak_pct : null,
        stages: stagesOf(i, cfg),
        areas: i.areas || [],
        fix: (i.signals && i.signals.fix_cycles) || 0,
        m,
        flags: flagsOf(m, cfg),
        est,
        outcome: i.outcome || null,
        model: (i.main && i.main.model) || '',
        plugin: i.plugin_version || '',
      };
    });
  const th = {};
  for (const [k, t] of Object.entries(cfg.thresholds || {})) th[k] = { max: t.max, format: t.format, label: t.label || k };
  const payload = JSON.stringify({ items: data, thresholds: th, stages: STAGE_ORDER }).replace(/</g, '\\u003c');
  const daily = {};
  for (const i of items)
    for (const p of (i.context && i.context.points) || []) {
      const d = p[0].slice(0, 10);
      daily[d] = Math.max(daily[d] || 0, p[1]);
    }
  const dailyPts = Object.entries(daily)
    .sort()
    .map(([d, v]) => [d + 'T12:00:00Z', v]);
  const charts = data
    .map((d) => items.find((i) => labelOf(i) === d.key))
    .filter((i) => i && i.context)
    .map((i) => `<details data-key="${esc(labelOf(i))}"><summary>${esc(labelOf(i))} ${esc(i.title || '')} - peak ${i.context.peak_pct}% of ${fmt(i.context.window)}</summary>${chart(i.context.points, i.context.compactions.events, 2 * 3600e3)}</details>`)
    .join('');
  let covHtml = '<p class="mut">No transcript scan in this run.</p>';
  let covCard = '';
  if (cov) {
    const top = (o) =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${usd(v)}</td></tr>`)
        .join('');
    const share = cov.total ? cov.tracked / cov.total : 0;
    covCard = `<div class="card"><b>${pct(share)}</b>of transcript $ is in an item <a class="help" href="usage-help.html#coverage">?</a></div>`;
    covHtml = `<p>${cov.from.slice(0, 10)} → ${cov.to.slice(0, 10)}: all transcripts ${usd(cov.total)}, in an item folder ${usd(cov.tracked)} (${pct(share)}).</p>
<div class="cards"><div><h3>Item id but no usage.json</h3><table>${top(cov.id_without_usage) || '<tr><td class="mut">none</td></tr>'}</table></div><div><h3>No item id, by project folder</h3><table>${top(cov.no_id_by_project) || '<tr><td class="mut">none</td></tr>'}</table></div></div>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claude usage by work item</title><style>${CSS}</style></head><body>
<h1>Claude usage by work item</h1>
<p class="mut">Generated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} · costs are <b>list-price estimates</b> (a subscription is not billed per token) · <a href="usage-help.html">How to read this page</a></p>
<div class="filter"><label>Area <select id="fArea"><option value="">all</option></select></label><label>Module <select id="fModule"><option value="">all</option></select></label><span id="fInfo" class="mut"></span></div>
<div class="cards"><div id="cards" style="display:contents"></div>${covCard}</div>
<h2>Signals <a class="help" href="usage-help.html#signals">?</a></h2><div id="signals"></div>
<h2>Stages <a class="help" href="usage-help.html#stages">?</a></h2><div class="scroll" id="stages"></div>
<h2>Areas <a class="help" href="usage-help.html#areas">?</a></h2><div id="areas"></div>
<h2>Items</h2><div class="scroll" id="items"></div>
<h2>Estimated vs actual <a class="help" href="usage-help.html#estimate">?</a></h2><div class="scroll" id="est"></div>
<h2>Context size per day (peak, all items) <a class="help" href="usage-help.html#context">?</a></h2>${chart(dailyPts, [], Infinity)}<p class="mut">% of the context window. Item charts: dashed lines are compactions (red = auto, blue = manual).</p>
<h2>Context size per item</h2><div id="charts">${charts}</div>
<h2>Coverage <a class="help" href="usage-help.html#coverage">?</a></h2>${covHtml}
<script type="application/json" id="data">${payload}</script>
<script>${CLIENT_JS}</script></body></html>`;
}

// Browser side of the dashboard: filter by area/module and recompute every table for the filtered items.
const CLIENT_JS = `(function(){
var D=JSON.parse(document.getElementById('data').textContent),I=D.items,TH=D.thresholds;
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function usd(n){return '$'+(n||0).toFixed(2)}function pct(n){return ((n||0)*100).toFixed(0)+'%'}
function mins(m){if(m==null)return '-';return m<60?Math.round(m)+'m':Math.floor(m/60)+'h '+('0'+Math.round(m%60)).slice(-2)+'m'}
function val(v,f){if(v==null)return '-';if(f==='pct')return pct(v);if(f==='tokens')return Math.round(v/1000)+'k';if(f==='x')return v.toFixed(1)+'x';return Math.round(v).toLocaleString('en-US')}
function q(a,p){a=a.filter(function(x){return x!=null}).sort(function(x,y){return x-y});if(!a.length)return null;return a[Math.min(a.length-1,Math.floor(a.length*p))]}
function med(a){return q(a,0.5)}
var fA=document.getElementById('fArea'),fM=document.getElementById('fModule');
var areas={};I.forEach(function(i){i.areas.forEach(function(a){(areas[a.area]=areas[a.area]||{})[a.module]=1})});
Object.keys(areas).sort().forEach(function(a){var o=document.createElement('option');o.value=o.textContent=a;fA.appendChild(o)});
function fillModules(){fM.innerHTML='<option value="">all</option>';if(!fA.value)return;Object.keys(areas[fA.value]).sort().forEach(function(m){var o=document.createElement('option');o.value=o.textContent=m;fM.appendChild(o)})}
function sel(){return I.filter(function(i){return !fA.value||i.areas.some(function(a){return a.area===fA.value&&(!fM.value||a.module===fM.value)})})}
function chips(i){var s={};i.areas.forEach(function(a){s[a.area]=1});return Object.keys(s).map(function(a){return '<span class="chip">'+esc(a)+'</span>'}).join('')}
function flags(i){return i.flags.map(function(f){return '<a class="flag" href="usage-help.html#t-'+f+'" title="'+esc(TH[f].label)+': '+val(i.m[f],TH[f].format)+'">'+esc(f.replace(/_/g,' '))+'</a>'}).join('')}
function render(){
 var S=sel(),done=S.filter(function(i){return i.final}),B=done.length?done:S,bl=done.length?'merged ':'';
 document.getElementById('fInfo').textContent=(fA.value?S.length+' of '+I.length+' items touch '+(fM.value||fA.value)+'. An item counts in full under every area it touches.':'');
 var tot=S.reduce(function(n,i){return n+i.usd},0),fl=S.reduce(function(n,i){return n+(i.flags.length?1:0)},0);
 document.getElementById('cards').innerHTML='<div class="card"><b>'+S.length+'</b>items ('+done.length+' merged)</div><div class="card"><b>'+usd(tot)+'</b>est. total</div><div class="card"><b>'+usd(med(B.map(function(i){return i.usd})))+'</b>median per '+bl+'item</div><div class="card"><b>'+mins(med(B.map(function(i){return i.active})))+'</b>median active time</div><div class="card"><b>'+fl+'</b>items with signals</div>';
 var sh='<table><tr><th>Signal</th><th class="n">Threshold</th><th class="n">Items over</th><th>Which</th></tr>';
 Object.keys(TH).forEach(function(k){var t=TH[k],o=S.filter(function(i){return i.flags.indexOf(k)>=0});
  sh+='<tr><td><a href="usage-help.html#t-'+k+'">'+esc(t.label)+'</a></td><td class="n">'+val(t.max,t.format)+'</td><td class="n">'+(o.length?'<span class="bad">'+o.length+'</span>':'<span class="ok">0</span>')+' / '+S.length+'</td><td>'+o.map(function(i){return esc(i.key)+' <span class="mut">'+val(i.m[k],t.format)+'</span>'}).join(', ')+'</td></tr>'});
 document.getElementById('signals').innerHTML=sh+'</table>';
 var all=B.reduce(function(n,i){return n+i.usd},0),st='<table><tr><th>Stage</th><th class="n">Median $ per '+bl+'item</th><th class="n">Share of $</th><th class="n">Median active</th><th class="n">Median calls</th><th class="n">p90 $</th></tr>';
 D.stages.forEach(function(s){var u=B.map(function(i){return (i.stages[s]||{}).usd||0}),sum=u.reduce(function(n,x){return n+x},0);if(!sum)return;
  st+='<tr><td>'+esc(s)+'</td><td class="n">'+usd(med(u))+'</td><td class="n">'+pct(all?sum/all:0)+'<div class="bar" style="width:'+(all?sum/all*100:0).toFixed(0)+'%"></div></td><td class="n">'+mins(med(B.map(function(i){return (i.stages[s]||{}).minutes||0})))+'</td><td class="n">'+med(B.map(function(i){return (i.stages[s]||{}).calls||0}))+'</td><td class="n">'+(B.length>=10?usd(q(u,0.9)):'<span class="mut">n&lt;10</span>')+'</td></tr>'});
 document.getElementById('stages').innerHTML=st+'</table><p class="mut">Over '+B.length+' '+bl+'item(s). Active times of stages overlap (subagents run in parallel).</p>';
 var ar={};I.forEach(function(i){var seen={};i.areas.forEach(function(a){var r=ar[a.area]=ar[a.area]||{items:{},mods:{},prod:0,test:0};r[a.kind]+=a.files;r.items[i.key]=i;(r.mods[a.module]=r.mods[a.module]||{})[i.key]=i})});
 var rows=Object.keys(ar).map(function(a){var r=ar[a],its=Object.keys(r.items).map(function(k){return r.items[k]});return {a:a,r:r,its:its,m:med(its.map(function(i){return i.usd}))}}).sort(function(x,y){return y.m-x.m});
 var ah='<table><tr><th>Area</th><th class="n">Items</th><th class="n">Median $</th><th class="n">Median fix cycles</th><th class="n">Test share of files</th><th class="n">Signals</th></tr>';
 rows.forEach(function(x){var nf=x.its.reduce(function(n,i){return n+i.flags.length},0),tf=x.r.prod+x.r.test;
  ah+='<tr><td><details><summary>'+esc(x.a)+'</summary>'+Object.keys(x.r.mods).sort().map(function(m){var its=Object.keys(x.r.mods[m]).map(function(k){return x.r.mods[m][k]});return '<div class="mut">'+esc(m)+': '+its.length+' item(s), median '+usd(med(its.map(function(i){return i.usd})))+'</div>'}).join('')+'</details></td><td class="n">'+x.its.length+'</td><td class="n">'+usd(x.m)+'</td><td class="n">'+med(x.its.map(function(i){return i.fix}))+'</td><td class="n">'+(tf?pct(x.r.test/tf):'-')+'</td><td class="n">'+nf+'</td></tr>'});
 document.getElementById('areas').innerHTML=rows.length?ah+'</table><p class="mut">All items, not filtered. Areas come from files changed (edits in transcripts, plus PR files once merged).</p>':'<p class="mut">No area data yet (re-run /dw:usage on an item).</p>';
 var mx=Math.max.apply(null,S.map(function(i){return i.usd}).concat([1]));
 var it='<table><tr><th>Item</th><th>Status</th><th class="n">Est. $</th><th class="n">Active</th><th class="n">Prompts</th><th class="n">Ceremony</th><th class="n">Heavy ctx</th><th class="n">Peak ctx</th><th>Areas</th><th>Signals</th><th>Last</th></tr>';
 S.forEach(function(i){it+='<tr><td>'+esc(i.key)+'<div class="mut">'+esc(i.title)+'</div></td><td>'+(i.folder?'<span class="mut">folder</span>':i.final?'<span class="ok">merged</span>':'<span class="wip">in progress</span>')+'</td><td class="n" title="'+(i.final?'to merge '+usd(i.to_merge)+', after merge '+usd(i.after_merge):'')+'">'+usd(i.usd)+'<div class="bar" style="width:'+(i.usd/mx*100).toFixed(0)+'%"></div></td><td class="n">'+mins(i.active)+'</td><td class="n">'+(i.prompts==null?'-':i.prompts)+'</td><td class="n">'+val(i.m.ceremony_share,'pct')+'</td><td class="n">'+val(i.m.heavy_context_share,'pct')+'</td><td class="n">'+(i.peak==null?'-':i.peak+'%')+'</td><td>'+chips(i)+'</td><td>'+flags(i)+'</td><td>'+esc(i.last)+'</td></tr>'});
 document.getElementById('items').innerHTML=it+'</table>';
 var E=S.filter(function(i){return i.est});
 document.getElementById('est').innerHTML=E.length?'<table><tr><th>Item</th><th>Size</th><th class="n">Expected</th><th class="n">Actual</th><th>Verdict</th><th class="n">Files est./actual</th><th>Why it may be expensive</th></tr>'+E.map(function(i){return '<tr><td>'+esc(i.key)+' '+esc(i.title)+'</td><td>'+esc(i.est.size)+'</td><td class="n">'+esc(i.est.range)+'</td><td class="n">'+usd(i.usd)+'</td><td>'+(i.est.verdict==='within'?'<span class="ok">within</span>':'<span class="bad">'+esc(i.est.verdict)+'</span>')+'</td><td class="n">'+(i.outcome?(i.est.files!=null?i.est.files:'-')+' / '+i.outcome.changed_files:'-')+'</td><td>'+(esc(i.est.hints)||'<span class="mut">-</span>')+'</td></tr>'}).join('')+'</table><p class="mut">* default range (size_usd in usage-prices.json); after 3 merged items of a size the range comes from your history (25th-75th percentile).</p>':'<p class="mut">No estimates in this selection.</p>';
 var keys={};S.forEach(function(i){keys[i.key]=1});document.querySelectorAll('#charts details').forEach(function(d){d.style.display=keys[d.getAttribute('data-key')]?'':'none'});
}
fA.onchange=function(){fillModules();render()};fM.onchange=render;render();
})();`;

// ---------- help page ----------
function helpPage(cfg) {
  const t = cfg.thresholds || {};
  const tips = {
    ceremony_share: 'Worktree, commit, PR, resume, tracker lookups and usage runs are mostly the same every time. Move fixed steps into scripts so no LLM turn is needed, or make the skill text shorter.',
    conversation_share: 'Most of the $ is in the main session without a skill: long back-and-forth, research done in the main context. Delegate reading to subagents (they return a summary, not file dumps) and give tighter instructions up front.',
    heavy_context_share: 'Every call re-reads the whole context, so cost per call grows with context size. Use /clear or a fresh session between phases (grill → plan → deliver → PR feedback); the item folder (spec.md, plan.md) is the handoff.',
    peak_context_tokens: 'A very large context is slow and expensive and the model loses focus. Same remedy as above; also avoid pasting big logs or reading whole large files in the main session.',
    test_to_impl_ratio: 'Writing tests cost much more than writing the code. Check whether tests were rewritten in fix cycles, whether the plan described the test cases clearly, and whether test-author explored too much.',
    explore_calls: 'Many Explore / general-purpose calls usually mean an open question was explored broadly. Narrow the brief (where to look, what is already ruled out) or add the missing facts to CLAUDE.md for that area.',
    over_estimate: 'The item cost much more than its size class suggests. Look at the hints in "Estimated vs actual": unclear acceptance criteria, scope changes, restarts. A short retro on why is the most valuable follow-up.',
    after_merge_share: 'Work after merge was counted on the item: follow-ups, unrelated work in the same worktree, or usage collection. Close the worktree after merge and start new work as its own item.',
    user_prompts: 'You stepped in often. Fine for design talks; during delivery it hints at unclear plans or the agent asking for things it could decide. Check which questions repeat and move the answers into the plan or skills.',
    compactions: 'The context overflowed and was summarised; detail gets lost and work is often repeated after it. Prefer a manual /clear with a written handoff before you reach the limit.',
  };
  const rows = Object.entries(t)
    .map(([k, r]) => `<tr id="t-${esc(k)}"><td><b>${esc(r.label || k)}</b><div class="mut">${esc(k)}</div></td><td class="n">&gt; ${esc(fmtVal(r.max, r.format))}</td><td>${esc(tips[k] || '')}</td></tr>`)
    .join('');
  const stages = Object.entries(cfg.stages || {})
    .map(([s, n]) => `<tr><td>${esc(s)}</td><td>${n.map(esc).join(', ')}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reading usage stats</title><style>${CSS}</style></head><body>
<p><a href="usage-dashboard.html">← Dashboard</a></p>
<h1>How to read the usage stats</h1>
<p>The goal is to find <b>where your way of working costs more than it needs to</b>, not to minimise a number. A big item can be legitimately big. Look for patterns that repeat across items.</p>
<h2 id="cost">Cost</h2>
<p>$ is a <b>list-price estimate</b> from token counts (prices in <code>scripts/usage-prices.json</code>); a subscription is not billed per token. Typically 60-70% of the $ is <b>cache read</b>: every call re-reads the whole conversation. So cost ≈ number of calls × context size. Output tokens (what the model writes) are a small part.</p>
<h2 id="time">Time and prompts</h2>
<p><b>Active time</b> adds up gaps of at most ${esc(cfg.active_gap_min)} minutes between API calls, so breaks don't count. Stage times overlap because subagents run in parallel. <b>Prompts</b> counts what you typed in the main session (slash commands included, tool approvals and notifications not): a rough measure of how often you had to step in.</p>
<h2 id="stages">Stages</h2>
<p>Each call is put into a stage by the skill or subagent it ran under. Claude Code tags only the first turns after a skill loads, so a main-session call without a tag keeps the last skill until your next own prompt. <b>conversation</b> is therefore the main session answering your prompts (discussion, side questions, research you asked for directly); <b>other</b> is any skill or agent not in the map. Edit the map in <code>usage-config.json</code>.</p>
<table><tr><th>Stage</th><th>Skills and agents</th></tr>${stages}<tr><td>conversation</td><td>main session after one of your prompts, until a skill starts</td></tr><tr><td>other</td><td>everything else (e.g. general-purpose)</td></tr></table>
<p>What to look for: ceremony is pure overhead, so it should be small and stable. If understand is large, specs were unclear or the area is unfamiliar (see Areas). If test or pr feedback is large, check the plan quality and fix cycles.</p>
<h2 id="areas">Areas</h2>
<p>By default, the top-level folder is the area and the next folder is the module. They come from the files the item changed: edits in transcripts, plus the PR file list once merged. Default rules are in <code>scripts/usage-config.json</code>; customize them with regex rules in <code>usage-config.local.json</code> in the research root.</p>
<p>An item that touches three areas counts <b>in full</b> under each one: cost can't be split fairly between areas. Trust a median only when the area has several items. An area that is consistently expensive or needs many fix cycles is a candidate for better docs (CLAUDE.md for that area), smaller files or better test helpers.</p>
<h2 id="signals">Signals and thresholds</h2>
<p>A signal fires when an item crosses a threshold. Defaults are in <code>scripts/usage-config.json</code>; override them in <code>usage-config.local.json</code> in the research root, e.g. <code>{"thresholds": {"ceremony_share": {"max": 0.25}}}</code>. One signal on one item means little; the same signal on many items is worth acting on.</p>
<table><tr><th>Signal</th><th class="n">Fires when</th><th>What to try</th></tr>${rows}</table>
<h2 id="context">Context size</h2>
<p>% of the context window per main-session call (200k, or 1M once a session went above 200k). A curve that only rises means one long session; drops are /clear, new sessions or compactions. <b>Heavy-context $</b> is the $ of calls above ${esc(fmt(cfg.context_heavy_tokens))} tokens.</p>
<h2 id="estimate">Estimated vs actual</h2>
<p>A small model sizes the item (XS-XL) when the plan is approved, before any code exists. The expected range starts from defaults and becomes your own 25th-75th percentile after three merged items of a size. "Over" items are the best candidates for a short retro.</p>
<h2 id="outcome">Outcome</h2>
<p>For merged items: lines and files changed, $ per changed file, reviews and review threads (bot reviewers included). These put cost next to the size of what was delivered.</p>
<h2 id="coverage">Coverage</h2>
<p>How much of all transcript $ in the period is counted in an item folder. Work without an item (plugin changes, research, quick questions) is not wrong, but if coverage is low the dashboard shows only part of the picture. "Item id but no usage.json" lists items to collect with <code>/dw:usage &lt;id&gt;</code>; transcripts are deleted after about 30 days.</p>
</body></html>`;
}

// ---------- merged check and outcome ----------
function prUrls(itemDir) {
  const t = readText(path.join(itemDir, 'plan.md'));
  const fm = (t.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [null, ''])[1];
  return fm.match(/https?:\/\/\S+?\/pull\/\d+/g) || [];
}
function gh(args) {
  const r = cp.spawnSync('gh', args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}
// {state:'merged', merged_at} | {state:'open'} | {state:'none'} (no PR recorded, or gh failed -> stays in progress)
function prState(urls, previous) {
  if (!urls.length) return { state: 'none' };
  if (previous && previous.final && previous.pr_urls && previous.pr_urls.join() === urls.join()) return { state: 'merged', merged_at: previous.merged_at };
  let latest = '';
  for (const u of urls) {
    const j = readJsonText(gh(['pr', 'view', u, '--json', 'state,mergedAt']));
    if (!j) return { state: 'none' };
    if (j.state !== 'MERGED') return { state: 'open' };
    if (j.mergedAt > latest) latest = j.mergedAt;
  }
  return { state: 'merged', merged_at: latest };
}
function readJsonText(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch (_) {
    return null;
  }
}
// Size of what was delivered: summed over the item's merged PRs. null when gh fails.
function prOutcome(urls) {
  const o = { additions: 0, deletions: 0, changed_files: 0, reviews: 0, review_threads: 0, files: [] };
  for (const u of urls) {
    const j = readJsonText(gh(['pr', 'view', u, '--json', 'additions,deletions,changedFiles,files,reviews']));
    if (!j) return null;
    o.additions += j.additions || 0;
    o.deletions += j.deletions || 0;
    o.changed_files += j.changedFiles || 0;
    o.reviews += (j.reviews || []).length;
    o.files.push(...(j.files || []).map((f) => f.path));
    const m = u.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    const t = m && gh(['api', '--hostname', m[1], '--paginate', `repos/${m[2]}/${m[3]}/pulls/${m[4]}/comments`, '--jq', '.[] | select(.in_reply_to_id == null) | .id']);
    if (t != null) o.review_threads += t.split('\n').filter(Boolean).length;
  }
  return o;
}

// Facts about how the item went, from the item folder: used to explain expensive items.
function itemSignals(dir, s) {
  const hist = readText(path.join(dir, 'history.md'));
  const plan = readText(path.join(dir, 'plan.md'));
  const fm = (plan.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [null, ''])[1];
  const fc = fm.match(/^fix_cycles:\s*(\d+)/m);
  const cx = s.context.compactions;
  return {
    estimate: readJson(path.join(dir, 'estimate.json')),
    signals: {
      sessions: Object.keys(s.sessions).length,
      iterations: Math.max(1, (hist.match(/^## Iteration/gm) || []).length),
      fix_cycles: fc ? +fc[1] : 0,
      superseded_decisions: (readText(path.join(dir, 'spec.md')).match(/\bsuperseded\b/gi) || []).length,
      compactions: cx.auto + cx.manual,
    },
  };
}

// Sessions claimed with --session (stored as scope.sessions in usage.json): session -> item key (item id or folder name).
// A claim wins over the "dominant id of the session" guess, but never over an id read from the entry's own cwd/branch.
function readClaims(root) {
  const claims = {};
  for (const d of itemDirs(root)) {
    const j = readJson(path.join(d.dir, 'usage.json'));
    if (j && j.scope && j.scope.sessions) for (const s of j.scope.sessions) claims[s] = j.item_id ? String(j.item_id).toLowerCase() : d.name;
  }
  return claims;
}
const ownerOf = (e, claims) => ((!e.id || e.inferred) && claims[e.session] ? claims[e.session] : e.id);

function writeItem(scope, dir, col, cfg, claims) {
  const inScope = (e) => ownerOf(e, claims) === scope.key;
  const entries = col.entries.filter(inScope);
  const compacts = col.compacts.filter(inScope);
  const prompts = col.prompts.filter(inScope);
  if (!entries.length) return null;
  const prices = loadPrices();
  const s = summarize(entries, prices, compacts, cfg);
  const previous = readJson(path.join(dir, 'usage.json'));
  const urls = scope.id ? prUrls(dir) : [];
  const pr = prState(urls, previous);
  const st = { status: pr.state === 'merged' ? 'merged' : scope.id ? 'in_progress' : 'folder', final: pr.state === 'merged', pr_urls: urls };
  let files = s.files;
  if (pr.state === 'merged') {
    st.merged_at = pr.merged_at;
    const before = summarize(
      entries.filter((e) => e.ts && e.ts <= pr.merged_at),
      prices,
      [],
      cfg
    );
    st.usd_to_merge = before.total.usd;
    st.usd_after_merge = Math.max(0, s.total.usd - before.total.usd);
    const same = previous && previous.outcome && previous.pr_urls && previous.pr_urls.join() === urls.join();
    st.outcome = same ? previous.outcome : prOutcome(urls);
    if (st.outcome) files = files.concat(st.outcome.files);
  }
  const ar = areasOf(files, cfg._areas);
  const plugin = readJson(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'));
  const name = path.basename(path.resolve(dir));
  const out = {
    item_id: scope.id || null,
    label: scope.id ? ref(scope.id) : name,
    title: name.replace(/^(\d+|local-\d+)-/i, '').replace(/-/g, ' '),
    scope: scope.sessions ? { sessions: scope.sessions } : undefined,
    generated: new Date().toISOString(),
    plugin_version: plugin && plugin.version,
    ...st,
    ...itemSignals(dir, s),
    ...s,
    files: undefined,
    edited_files: s.files,
    areas: ar.areas,
    unmapped_files: ar.unmapped_files,
    prompts: prompts.length,
    sessions: Object.keys(s.sessions).length,
    session_detail: s.sessions,
  };
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(dir, 'usage.md'), itemMd(out, cfg, prices));
  return out;
}

function writeReport(root, col, cfg) {
  const items = [];
  for (const d of itemDirs(root)) {
    const j = readJson(path.join(d.dir, 'usage.json'));
    if (j && j.total) items.push({ ...j, label: j.item_id ? j.label || ref(j.item_id) : d.name });
  }
  const cov = coverage(col, items, loadPrices(), readClaims(root));
  const file = path.join(root, 'usage-dashboard.html');
  fs.writeFileSync(file, dashboard(items, cfg, cov));
  fs.writeFileSync(path.join(root, 'usage-help.html'), helpPage(cfg));
  return { file: file.replace(/\\/g, '/'), items: items.length, coverage: cov && cov.total ? +(cov.tracked / cov.total).toFixed(2) : null };
}

// ---------- main ----------
if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  const projects = argStr(a['projects-dir']) || path.join(os.homedir(), '.claude', 'projects');
  if (cmd === 'item' || cmd === 'refresh') {
    const rawId = argStr(a.id);
    let id = null;
    if (rawId != null) {
      id = rawId.trim().replace(/^#/, '').toLowerCase();
      if (!/^(\d+|local-\d+)$/.test(id)) fail(cmd + ' needs --id <issue number | local-<n>>');
    }
    const rawDir = argStr(a['item-dir']) || (id ? findItemDir(researchRoot(a), id) : null);
    const dir = rawDir ? path.resolve(rawDir) : null;
    if (!dir || !fs.existsSync(dir)) fail(id ? `no item folder for ${id}` : cmd + ' needs --id <issue number | local-<n>> or --item-dir <dir>');
    const prev = readJson(path.join(dir, 'usage.json'));
    const sessions = argStr(a.session) ? argStr(a.session).split(',').map((s) => s.trim()).filter(Boolean) : prev && prev.scope ? prev.scope.sessions : null;
    if (!id && (!sessions || !sessions.length)) fail('a folder without an item id needs --session <id[,id]>');
    const root = argStr(a.root) ? researchRoot(a) : itemRootOf(dir);
    const cfg = loadConfig(root);
    const col = collect(projects);
    const key = id || path.basename(dir);
    const claims = readClaims(root);
    for (const s of sessions || []) claims[s] = key;
    const r = writeItem({ id, key, sessions }, dir, col, cfg, claims);
    if (!r) fail(`no transcript usage found for ${id ? ref(id) : key} under ${projects}`);
    const dash = cmd === 'refresh' ? writeReport(root, col, cfg) : null;
    process.stdout.write(
      JSON.stringify({
        item_dir: dir.replace(/\\/g, '/'),
        usd: +r.total.usd.toFixed(2),
        calls: r.total.calls,
        sessions: r.sessions,
        status: r.status,
        signals: flagsOf(metricsOf(r, cfg, r.estimate ? expectedRange(r.estimate.size, [], loadPrices()) : null), cfg),
        dashboard: dash,
      }) + '\n'
    );
  } else if (cmd === 'report') {
    const root = researchRoot(a);
    const cfg = loadConfig(root);
    process.stdout.write(JSON.stringify(writeReport(root, a['no-scan'] ? null : collect(projects), cfg)) + '\n');
  } else {
    fail('usage: dw-usage.js item|refresh --id <id> [--root <dir> | --item-dir <dir>] [--session <id,...>] | report [--root <dir>] [--no-scan]');
  }
}

module.exports = { areaOf, loadConfig, metricsOf, flagsOf, activeMin };
