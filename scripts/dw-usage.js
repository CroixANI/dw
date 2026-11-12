#!/usr/bin/env node
'use strict';
// dw usage stats: tokens and ESTIMATED $ per dw item (GitHub issue or local item), from Claude Code transcripts (read-only).
//   node dw-usage.js item   --id 42 [--root <research root>] [--projects-dir <dir>]
//        -> <item folder>/usage.json + usage.md
//   node dw-usage.js report [--root <research root>]
//        -> <research root>/usage-dashboard.html from all <item folder>/usage.json
// Sources: <projects-dir>/*/<session>.jsonl and <session>/subagents/agent-*.jsonl (+ .meta.json agentType).
// Attribution per entry: cwd ...\worktrees\<id>-slug, else gitBranch .../<id>_slug; entries without an id (e.g. work done
// in the main checkout before the worktree was entered) get the id that dominates their session.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MECHANICAL = new Set(['dw:test-runner', 'dw:researcher', 'dw:log-analyst', 'dw:call-summarizer']);

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

// ---------- locating transcripts ----------
function walkJsonl(projectsDir) {
  const files = []; // {file, session, agentFile, meta}
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
          let agentType = 'subagent';
          try {
            agentType = JSON.parse(fs.readFileSync(path.join(sub, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')).agentType || agentType;
          } catch (_) {
            /* no meta */
          }
          files.push({ file: path.join(sub, f), session: e.name, project: p.name, agent: agentType });
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

// Cheap pre-pass: which ids does a file mention? (lets `item` skip unrelated files without full parsing)
function readEntries(f) {
  const out = [];
  let text;
  try {
    text = fs.readFileSync(f.file, 'utf8');
  } catch (_) {
    return out;
  }
  for (const line of text.split('\n')) {
    const isUsage = line.includes('"usage"') && line.includes('"assistant"');
    if (!isUsage && !line.includes('compact_boundary')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const cm = o.compactMetadata || {};
      out.push({ kind: 'compact', key: 'c|' + (o.uuid || o.timestamp), session: f.session, ts: o.timestamp || null, id: idFromEntry(o), trigger: cm.trigger || 'auto', pre: cm.preTokens || 0, post: cm.postTokens || 0 });
      continue;
    }
    if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
    out.push({
      key: (o.message.id || o.uuid) + '|' + (o.requestId || ''),
      session: f.session,
      agent: f.agent,
      skill: o.attributionSkill || null,
      model: o.message.model || 'unknown',
      ts: o.timestamp || null,
      id: idFromEntry(o),
      u: o.message.usage,
    });
  }
  return out;
}

// ---------- pricing ----------
function loadPrices() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'usage-prices.json'), 'utf8'));
  } catch (_) {
    return { default: { input: 3, output: 15 } };
  }
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

// ---------- collect ----------
function collect(projectsDir) {
  const files = walkJsonl(projectsDir);
  const byKey = new Map(); // dedupe streaming duplicates: keep the last entry
  for (const f of files) for (const e of readEntries(f)) byKey.set(e.key, e);
  const all = [...byKey.values()];
  const entries = all.filter((e) => e.kind !== 'compact');
  const compacts = all.filter((e) => e.kind === 'compact');
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
  for (const c of compacts) if (!c.id) c.id = dominant.get(c.session) || null;
  return { entries, compacts };
}

function summarize(entries, prices, compacts = []) {
  const unknown = new Set();
  const total = zero();
  const byModel = {};
  const byPhase = {};
  const sessions = {};
  let first = null;
  let last = null;
  let mechOpusSave = 0;
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
    const s = (sessions[e.session] = sessions[e.session] || { ...zero(), first: e.ts, last: e.ts });
    add(s, t, usd);
    if (e.ts && (!s.first || e.ts < s.first)) s.first = e.ts;
    if (e.ts && (!s.last || e.ts > s.last)) s.last = e.ts;
    if (e.ts && (!first || e.ts < first)) first = e.ts;
    if (e.ts && (!last || e.ts > last)) last = e.ts;
    if (e.agent) subCost += usd;
    else if (e.ts) ctxPts.push({ ts: e.ts, session: e.session, ctx: t.input + t.read + t.w5 + t.w1 });
    // savings rule: mechanical subagent that ran on an Opus-class model -> price at the Sonnet rate
    if (e.agent && MECHANICAL.has(e.agent) && /opus/.test(e.model)) {
      const alt = costOf(t, rates(prices, 'claude-sonnet-5-5', unknown));
      mechOpusSave += Math.max(0, usd - alt);
    }
  }
  const context = contextStats(ctxPts, compacts, prices);
  const inputAll = total.input + total.read + total.w5 + total.w1;
  return {
    total,
    cache_read_ratio: inputAll ? total.read / inputAll : 0,
    subagent_share: total.usd ? subCost / total.usd : 0,
    by_model: byModel,
    by_phase: byPhase,
    sessions,
    context,
    first,
    last,
    savings: [
      {
        rule: 'Mechanical subagents (test-runner, researcher, log-analyst, call-summarizer) that ran on an Opus-class model, re-priced at the Sonnet rate',
        usd: mechOpusSave,
      },
    ],
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
  let step = Math.ceil(series.length / 400) || 1; // keep usage.json small: peak per bucket
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

// ---------- research root ----------
function researchRoot(a) {
  const root = require('../hooks/lib/profiles').researchRoot(process.cwd(), a.root);
  if (!root) fail('not in a git repo and no --root given');
  return root;
}
function findItemDir(root, id) {
  try {
    const d = fs.readdirSync(root).find((x) => x.toLowerCase() === id || x.toLowerCase().startsWith(id + '-'));
    return d ? path.join(root, d) : null;
  } catch (_) {
    return null;
  }
}

// ---------- formatting ----------
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const usd = (n) => '$' + n.toFixed(2);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function itemMd(id, s, st = {}, extra = {}) {
  const L = [`# Usage ${ref(id)}`, '', st.final ? `Status: **merged** ${st.merged_at} · cost up to merge ${usd(st.usd_to_merge)}, after merge ${usd(st.usd_after_merge)}` : 'Status: **in progress** (no merged PR yet)', '',`Estimated list-price cost (not a bill): **${usd(s.total.usd)}** · ${s.total.calls} API calls · ${s.first || '?'} → ${s.last || '?'}`, ''];
  L.push(`Tokens: input ${fmt(s.total.input)} · output ${fmt(s.total.output)} · cache read ${fmt(s.total.read)} · cache write ${fmt(s.total.w5 + s.total.w1)}`);
  L.push(`Cache read ratio ${(s.cache_read_ratio * 100).toFixed(0)}% · subagent share of cost ${(s.subagent_share * 100).toFixed(0)}% · sessions ${Object.keys(s.sessions).length}`, '');
  const cx = s.context;
  L.push(`Context: peak ${cx.peak_pct}% of ${fmt(cx.window)} (${fmt(cx.peak_tokens)} tokens) · average ${cx.avg_pct}% · compactions ${cx.compactions.auto + cx.compactions.manual} (auto ${cx.compactions.auto}, manual ${cx.compactions.manual})`, '');
  L.push('## By phase', '', '| Phase | Calls | Output tok | $ |', '|---|---:|---:|---:|');
  for (const [k, v] of Object.entries(s.by_phase).sort((a, b) => b[1].usd - a[1].usd)) L.push(`| ${k} | ${v.calls} | ${fmt(v.output)} | ${usd(v.usd)} |`);
  L.push('', '## By model', '', '| Model | Calls | $ |', '|---|---:|---:|');
  for (const [k, v] of Object.entries(s.by_model).sort((a, b) => b[1].usd - a[1].usd)) L.push(`| ${k} | ${v.calls} | ${usd(v.usd)} |`);
  if (extra.signals) {
    const g = extra.signals;
    L.push('', '## How it went', '', `Sessions ${g.sessions} · iterations ${g.iterations} · fix cycles ${g.fix_cycles} · superseded spec decisions ${g.superseded_decisions} · compactions ${g.compactions}`);
    const e = extra.estimate;
    L.push(e ? `Estimate at plan approval: size **${e.size}**, ${e.files_touched} files, ${e.projects_touched} projects, ambiguity: ${(e.ambiguity || []).join(', ') || 'none'} (confidence ${e.confidence})` : 'No complexity estimate recorded (estimate.json missing).');
  }
  L.push('', '## Potential savings (estimate)', '');
  for (const x of s.savings) L.push(`- up to ${usd(x.usd)}: ${x.rule}`);
  if (s.unknown_models.length) L.push('', `Prices missing for: ${s.unknown_models.join(', ')} (default rate used; edit scripts/usage-prices.json).`);
  return L.join('\n') + '\n';
}

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

// Expected cost range per size: median of merged items of that size when >= 3 exist, else the editable defaults.
function expectedRange(size, items, prices) {
  const same = items.filter((i) => i.final && i.estimate && i.estimate.size === size).map((i) => i.total.usd).sort((a, b) => a - b);
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

function dashboard(items) {
  const prices = loadPrices();
  const sorted = items.slice().sort((a, b) => b.total.usd - a.total.usd);
  const done = items.filter((i) => i.final);
  const basis = done.length ? done : items; // averages and savings use finished (merged) tasks when there are any
  const costs = basis.map((i) => i.total.usd).sort((a, b) => a - b);
  const median = costs.length ? costs[Math.floor(costs.length / 2)] : 0;
  const sum = (f) => items.reduce((n, i) => n + f(i), 0);
  const sumB = (f) => basis.reduce((n, i) => n + f(i), 0);
  const max = sorted.length ? sorted[0].total.usd || 1 : 1;
  const mech = sumB((i) => i.savings.reduce((n, x) => n + x.usd, 0));
  const outlier = sumB((i) => Math.max(0, i.total.usd - median * 2));
  const phases = {};
  for (const i of items) for (const [k, v] of Object.entries(i.by_phase)) phases[k] = (phases[k] || 0) + v.usd;
  const phaseRows = Object.entries(phases).sort((a, b) => b[1] - a[1]);
  const pmax = phaseRows.length ? phaseRows[0][1] || 1 : 1;
  const rows = sorted
    .map(
      (i) => `<tr><td>${esc(ref(i.item_id))}</td><td>${i.final ? '<span class="ok">merged</span>' : '<span class="wip">in progress</span>'}</td><td>${esc(i.title || '')}</td><td class="n" title="${i.final ? 'to merge ' + usd(i.usd_to_merge) + ', after merge ' + usd(i.usd_after_merge) : ''}">${usd(i.total.usd)}<div class="bar" style="width:${((i.total.usd / max) * 100).toFixed(0)}%"></div></td><td class="n">${fmt(i.total.output)}</td><td class="n">${i.context ? i.context.peak_pct + '%' : '-'}</td><td class="n">${i.context ? i.context.compactions.auto + ' auto / ' + i.context.compactions.manual + ' manual' : '-'}</td><td class="n">${(i.cache_read_ratio * 100).toFixed(0)}%</td><td class="n">${(i.subagent_share * 100).toFixed(0)}%</td><td class="n">${i.sessions}</td><td>${esc((i.last || '').slice(0, 10))}</td></tr>`
    )
    .join('');
  const daily = {};
  for (const i of items) for (const p of (i.context && i.context.points) || []) {
    const d = p[0].slice(0, 10);
    daily[d] = Math.max(daily[d] || 0, p[1]);
  }
  const dailyPts = Object.entries(daily).sort().map(([d, v]) => [d + 'T12:00:00Z', v]);
  const allEv = items.flatMap((i) => (i.context ? i.context.compactions.events : []));
  const cmpAuto = allEv.filter((e) => e.trigger !== 'manual').length;
  const cmpMan = allEv.length - cmpAuto;
  const charts = sorted
    .filter((i) => i.context)
    .map((i) => `<details><summary>${esc(ref(i.item_id))} ${esc(i.title || '')} - context size over time (peak ${i.context.peak_pct}%, window ${fmt(i.context.window)})</summary>${chart(i.context.points, i.context.compactions.events, 2 * 3600e3)}</details>`)
    .join('');
  const est = sorted
    .filter((i) => i.estimate)
    .map((i) => {
      const r = expectedRange(i.estimate.size, items, prices);
      const over = r && i.total.usd > r.high;
      const hints = whyHints(i);
      return `<tr><td>${esc(ref(i.item_id))} ${esc(i.title || '')}</td><td>${esc(i.estimate.size)}</td><td class="n">${r ? usd(r.low) + ' - ' + usd(r.high) + (r.src === 'default' ? ' *' : '') : '-'}</td><td class="n">${usd(i.total.usd)}</td><td>${over ? '<span class="bad">over x' + (i.total.usd / r.high).toFixed(1) + '</span>' : '<span class="ok">within</span>'}</td><td>${hints.length ? esc(hints.join('; ')) : '<span class="mut">-</span>'}</td></tr>`;
    })
    .join('');
  const prow = phaseRows
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${usd(v)}<div class="bar" style="width:${((v / pmax) * 100).toFixed(0)}%"></div></td></tr>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claude usage by work item</title>
<style>:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#ddd;--bar:#4c7cf0}@media(prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mut:#999;--line:#333;--bar:#6b93ff}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px}table{border-collapse:collapse;width:100%;margin:8px 0 24px}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.n{text-align:right;white-space:nowrap}.bar{height:4px;background:var(--bar);margin-top:2px}
.cards{display:flex;gap:12px;flex-wrap:wrap}.card{border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:150px}.card b{font-size:22px;display:block}.mut{color:var(--mut)}.ok{color:#16a34a}.bad{color:#e5484d;font-weight:600}.wip{color:#d97706}.grid{stroke:var(--line);stroke-width:1}.lbl{fill:var(--mut);font-size:10px}.line{fill:none;stroke:var(--bar);stroke-width:1.5}.dot{fill:var(--bar)}.ca{stroke:#e5484d;stroke-dasharray:3 3}.cm{stroke:#3b82f6;stroke-dasharray:3 3}details{margin:6px 0}summary{cursor:pointer}</style></head><body>
<h1>Claude usage by work item</h1><p class="mut">Generated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} · costs are <b>list-price estimates</b> (subscription is not billed per token), edit scripts/usage-prices.json.</p>
<div class="cards"><div class="card"><b>${items.length}</b>items (${done.length} merged, ${items.length - done.length} in progress)</div><div class="card"><b>${usd(sum((i) => i.total.usd))}</b>est. total</div><div class="card"><b>${usd(median)}</b>median per ${done.length ? "merged " : ""}item</div><div class="card"><b>${usd(mech + outlier)}</b>potential savings (est.)</div><div class="card"><b>${cmpAuto + cmpMan}</b>compactions (${cmpAuto} auto, ${cmpMan} manual)</div></div>
<h2>Potential savings (estimates)</h2><ul><li>up to ${usd(mech)}: mechanical subagents that ran on an Opus-class model, re-priced at the Sonnet rate</li><li>up to ${usd(outlier)}: cost above 2x the median item (only a hint: big items can be legitimately big)</li></ul>
<h2>Items</h2><table><tr><th>Item</th><th>Status</th><th>Title</th><th class="n">Est. $</th><th class="n">Output tok</th><th class="n">Peak ctx</th><th class="n">Compactions</th><th class="n">Cache read</th><th class="n">Subagents</th><th class="n">Sessions</th><th>Last</th></tr>${rows}</table>
<h2>Context size per day (peak, all items)</h2>${chart(dailyPts, [], Infinity)}<p class="mut">% of the context window (200k, or 1M for sessions that exceeded 200k). Dashed lines in item charts: compactions (red = auto, blue = manual).</p>
<h2>Context size per item</h2>${charts}
<h2>Estimated vs actual</h2>${est ? '<table><tr><th>Item</th><th>Size</th><th class="n">Expected</th><th class="n">Actual</th><th>Verdict</th><th>Why it may be expensive</th></tr>' + est + '</table><p class="mut">* default range (editable: size_usd in usage-prices.json); after 3 merged items of a size the range comes from your own history (25th-75th percentile). Size is estimated by a small model when the plan is approved.</p>' : '<p class="mut">No estimates yet: they are written by /dw:deliver right after plan approval.</p>'}
<h2>Cost by phase (all items)</h2><table>${prow}</table></body></html>`;
}

// ---------- merged check ----------
function prUrls(itemDir) {
  try {
    const t = fs.readFileSync(path.join(itemDir, 'plan.md'), 'utf8');
    const fm = (t.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [null, ''])[1];
    return fm.match(/https?:\/\/\S+?\/pull\/\d+/g) || [];
  } catch (_) {
    return [];
  }
}
// {state:'merged', merged_at} | {state:'open'} | {state:'none'} (no PR recorded, or gh failed -> stays in progress)
function prState(itemDir, previous) {
  const urls = prUrls(itemDir);
  if (!urls.length) return { state: 'none' };
  if (previous && previous.final && previous.pr_urls && previous.pr_urls.join() === urls.join()) return { state: 'merged', merged_at: previous.merged_at };
  let latest = '';
  for (const u of urls) {
    const r = require('child_process').spawnSync('gh', ['pr', 'view', u, '--json', 'state,mergedAt'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (r.status !== 0) return { state: 'none' };
    let j;
    try {
      j = JSON.parse(r.stdout);
    } catch (_) {
      return { state: 'none' };
    }
    if (j.state !== 'MERGED') return { state: 'open' };
    if (j.mergedAt > latest) latest = j.mergedAt;
  }
  return { state: 'merged', merged_at: latest };
}

function readText(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch (_) {
    return '';
  }
}
// Facts about how the item went, from the item folder: used to explain expensive items.
function itemSignals(dir, s) {
  const hist = readText(path.join(dir, 'history.md'));
  const plan = readText(path.join(dir, 'plan.md'));
  const fm = (plan.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [null, ''])[1];
  const fc = fm.match(/^fix_cycles:\s*(\d+)/m);
  const cx = s.context.compactions;
  let estimate = null;
  try {
    estimate = JSON.parse(readText(path.join(dir, 'estimate.json')));
  } catch (_) {
    /* no estimate */
  }
  return {
    estimate,
    signals: {
      sessions: Object.keys(s.sessions).length,
      iterations: Math.max(1, (hist.match(/^## Iteration/gm) || []).length),
      fix_cycles: fc ? +fc[1] : 0,
      superseded_decisions: (readText(path.join(dir, 'spec.md')).match(/superseded in it\d+/g) || []).length,
      compactions: cx.auto + cx.manual,
    },
  };
}

function writeItem(id, dir, projects) {
  const col = collect(projects);
  const entries = col.entries.filter((e) => e.id === id);
  const compacts = col.compacts.filter((c) => c.id === id);
  if (!entries.length) return null;
  const prices = loadPrices();
  const s = summarize(entries, prices, compacts);
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'));
  } catch (_) {
    /* first run */
  }
  const pr = prState(dir, previous);
  const st = { status: pr.state === 'merged' ? 'merged' : 'in_progress', final: pr.state === 'merged', pr_urls: prUrls(dir) };
  if (pr.state === 'merged') {
    st.merged_at = pr.merged_at;
    const before = summarize(entries.filter((e) => e.ts && e.ts <= pr.merged_at), prices, []);
    st.usd_to_merge = before.total.usd;
    st.usd_after_merge = Math.max(0, s.total.usd - before.total.usd);
  }
  const title = path.basename(dir).replace(/^(\d+|local-\d+)-/i, '').replace(/-/g, ' ');
  const extra = itemSignals(dir, s);
  const out = { item_id: id, title, generated: new Date().toISOString(), ...st, ...extra, ...s, sessions: Object.keys(s.sessions).length, session_detail: s.sessions };
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(dir, 'usage.md'), itemMd(id, s, st, extra));
  return { out, s };
}

function writeReport(root) {
  const items = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    try {
      items.push(JSON.parse(fs.readFileSync(path.join(root, d.name, 'usage.json'), 'utf8')));
    } catch (_) {
      /* no usage.json */
    }
  }
  const file = path.join(root, 'usage-dashboard.html');
  fs.writeFileSync(file, dashboard(items));
  return { file: file.replace(/\\/g, '/'), items: items.length };
}

// ---------- main ----------
const a = parseArgs(process.argv.slice(2));
const cmd = a._[0];
if (cmd === 'item' || cmd === 'refresh') {
  const id = String(a.id && a.id !== true ? a.id : '').trim().replace(/^#/, '').toLowerCase();
  if (!/^(\d+|local-\d+)$/.test(id)) fail(cmd + ' needs --id <issue number | local-<n>>');
  const dir = a['item-dir'] && a['item-dir'] !== true ? String(a['item-dir']) : findItemDir(researchRoot(a), id);
  if (!dir || !fs.existsSync(dir)) fail(`no item folder for ${id}`);
  const projects = a['projects-dir'] && a['projects-dir'] !== true ? String(a['projects-dir']) : path.join(os.homedir(), '.claude', 'projects');
  const r = writeItem(id, dir, projects);
  if (!r) fail(`no transcript usage found for ${ref(id)} under ${projects}`);
  const dash = cmd === 'refresh' ? writeReport(path.dirname(path.resolve(dir))) : null;
  process.stdout.write(JSON.stringify({ item_dir: dir.replace(/\\/g, '/'), usd: +r.s.total.usd.toFixed(2), calls: r.s.total.calls, sessions: r.out.sessions, status: r.out.status, dashboard: dash }) + '\n');
} else if (cmd === 'report') {
  process.stdout.write(JSON.stringify(writeReport(researchRoot(a))) + '\n');
} else {
  fail('usage: dw-usage.js item|refresh --id <id> [--root <dir> | --item-dir <dir>] | report [--root <dir>]');
}
