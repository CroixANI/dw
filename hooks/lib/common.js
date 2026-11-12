'use strict';
// Shared helpers for dw hook scripts. Node built-ins only (no npm install needed).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

// ---------- I/O ----------

function readInput() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    raw = '';
  }
  try {
    return JSON.parse(raw || '{}');
  } catch (_) {
    return {};
  }
}

// Emit a PreToolUse decision. decision: 'deny' | 'ask'. Silence (no output, exit 0) = no opinion.
function decide(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }) + '\n'
  );
  process.exit(0);
}

// A crashing gate hook exits 1, which Claude Code treats as non-blocking: the command would run with every gate skipped.
// Call this first in a gate hook so any uncaught error becomes an "ask" instead.
function failSafe() {
  process.on('uncaughtException', (e) =>
    decide('ask', '[dw guard] internal hook error, asking for safety: ' + String((e && e.message) || e).slice(0, 200))
  );
}

// Combine findings: deny beats ask. Each finding: {decision, reason}.
function emit(findings) {
  if (!findings.length) process.exit(0);
  const denies = findings.filter((f) => f.decision === 'deny');
  const chosen = denies.length ? denies : findings;
  const reason = chosen.map((f) => f.reason).join('\n\n');
  decide(denies.length ? 'deny' : 'ask', reason);
}

// ---------- config (plugin userConfig -> CLAUDE_PLUGIN_OPTION_<KEY>) ----------

const DEFAULTS = {
  protected_branches: 'main,master,develop,release/*',
  github_mcp_servers: 'github',
  branch_template: '{prefix}/{id}-{slug}',
  type_labels: 'bug=bug;epic=epic;feature=enhancement|feature;task=task',
};

function option(key) {
  const candidates = [
    'CLAUDE_PLUGIN_OPTION_' + key.toUpperCase(),
    'CLAUDE_PLUGIN_OPTION_' + key,
  ];
  for (const name of candidates) {
    const v = process.env[name];
    if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return DEFAULTS[key];
}

function listOption(key) {
  return (option(key) || '')
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- paths ----------

function norm(p) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/');
  // Git Bash style /c/Views -> C:/Views
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(s);
  if (IS_WIN && m) s = m[1].toUpperCase() + ':/' + m[2];
  s = s.replace(/\/+$/, '');
  return s;
}

function same(a, b) {
  return IS_WIN ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

// true when child is inside (or equal to) parent
function isInside(child, parent) {
  if (!child || !parent) return false;
  let c = norm(child);
  let p = norm(parent);
  if (IS_WIN) {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }
  return c === p || c.startsWith(p + '/');
}

function resolveFrom(cwd, file) {
  if (!file) return '';
  const f = String(file);
  if (path.isAbsolute(f) || /^[a-zA-Z]:[\\/]/.test(f)) return norm(f);
  return norm(path.resolve(cwd || process.cwd(), f));
}

// nearest existing directory for a (possibly new) file path
function existingDir(p) {
  let d = path.dirname(p);
  for (let i = 0; i < 64; i++) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch (_) {
      /* keep walking up */
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

// ---------- git ----------

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 8000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').trim();
}

// Info about the git work tree containing dir (or null when not in a repo).
function repoInfo(dir) {
  if (!dir) return null;
  const out = git(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--abbrev-ref', 'HEAD']);
  if (!out) {
    // unborn branch: --abbrev-ref HEAD fails; retry without it
    const top = git(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
    if (!top) return null;
    const [toplevel, gitDir] = top.split(/\r?\n/);
    const branch = git(dir, ['symbolic-ref', '--short', 'HEAD']) || '';
    return { toplevel: norm(toplevel), gitDir: norm(gitDir), branch };
  }
  const [toplevel, gitDir, branch] = out.split(/\r?\n/);
  return { toplevel: norm(toplevel), gitDir: norm(gitDir), branch: branch === 'HEAD' ? '' : branch };
}

// Real path (8.3 short names, symlinks and junctions resolved) of p, also when p does not exist yet:
// the nearest existing ancestor is resolved and the rest appended. Use it before comparing paths for a security decision.
function real(p) {
  let cur = path.resolve(String(p));
  const rest = [];
  for (;;) {
    try {
      return norm(path.join(fs.realpathSync.native(cur), ...rest));
    } catch (_) {
      const up = path.dirname(cur);
      if (up === cur) return norm(p);
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}

// Main checkout of the repo that contains dir (the parent of the common git dir), '' outside a repo.
function mainCheckout(dir) {
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common ? norm(path.dirname(common)) : '';
}

// Every checkout (main + linked worktrees) of the repo that contains dir.
function worktrees(dir) {
  return (git(dir, ['worktree', 'list', '--porcelain']) || '')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9));
}

function isIgnored(toplevel, absFile) {
  const rel = path.relative(real(toplevel), real(absFile)).replace(/\\/g, '/');
  const r = spawnSync('git', ['check-ignore', '-q', '--', rel], {
    cwd: toplevel,
    windowsHide: true,
    timeout: 8000,
  });
  return r.status === 0;
}

const PRE_APPROVAL_PHASES = new Set(['intake', 'investigate', 'design', 'plan']);

// ---------- dw item state (lives in <git-dir>/dw/, per worktree, never committed) ----------

function stateDir(gitDir) {
  return gitDir ? norm(path.join(gitDir, 'dw')) : '';
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

// item.json of the checkout at dir (null when none is bound)
function itemAt(dir) {
  const gd = git(dir, ['rev-parse', '--absolute-git-dir']);
  return gd ? readJson(path.join(stateDir(gd), 'item.json')) : null;
}

// Active item for the work tree containing cwd: {item, info, locked: [relpaths]} or null
function activeItem(cwd) {
  const info = repoInfo(cwd);
  if (!info) return null;
  const dir = stateDir(info.gitDir);
  const item = readJson(path.join(dir, 'item.json'));
  if (!item) return null;
  const lock = readJson(path.join(dir, 'tests-locked.json'));
  return { item, info, dir, lock, locked: (lock && lock.files) || [] };
}

// Content hash of a text file, ignoring a leading BOM and CRLF vs LF: on Windows, git autocrlf, editors and
// formatters flip those without anyone changing the test.
function fileHash(abs) {
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (_) {
    return null; // missing file counts as changed
  }
  return crypto.createHash('sha256').update(text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')).digest('hex');
}

// Plan text as compared between the ExitPlanMode approval and plan.md: no frontmatter, no HTML comments,
// no dw-state log lines, whitespace and line endings collapsed.
function normalizePlan(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .filter((l) => !/^- \d{4}-\d\d-\d\dT\S+ test lock /.test(l))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function planSha(text) {
  return crypto.createHash('sha256').update(normalizePlan(text)).digest('hex');
}

// Locked test files whose content differs from what was locked (shell writes, deletes, git checkout ...).
// Locks written before hashes existed have no hashes and are not verified.
function changedLocks(active) {
  if (!active || !active.lock || !active.lock.hashes) return [];
  return Object.keys(active.lock.hashes).filter(
    (rel) => fileHash(path.join(active.info.toplevel, rel)) !== active.lock.hashes[rel]
  );
}

// pre-approval includes "unknown": a bound item with no readable phase is treated as not approved (fail closed)
function isPreApproval(phase) {
  return !phase || PRE_APPROVAL_PHASES.has(phase);
}

// phase from YAML frontmatter of plan.md (no YAML lib: a simple line match is enough)
function planPhase(itemDir) {
  if (!itemDir) return null;
  try {
    const text = fs.readFileSync(path.join(itemDir, 'plan.md'), 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!fm) return null;
    const m = /^phase:\s*["']?([A-Za-z_-]+)/m.exec(fm[1]);
    return m ? m[1].toLowerCase() : null;
  } catch (_) {
    return null;
  }
}


// ---------- item identity ----------

// Item id: a GitHub issue number ("42") or a local item ("local-3"). Accepts "#42" too.
const ITEM_ID = /^(\d+|local-\d+)$/;
function normId(id) {
  const s = String(id == null ? '' : id).trim().replace(/^#/, '').toLowerCase();
  return ITEM_ID.test(s) ? s : '';
}

// Display reference: "#42" for an issue, "local-3" for a local item.
function itemRef(item) {
  const id = item && item.item_id != null ? String(item.item_id) : '';
  if (!id) return 'the item';
  return /^\d+$/.test(id) ? '#' + id : id;
}

// ---------- globs ----------

function globToRegex(glob) {
  let g = norm(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // '**/' matches zero or more dirs; trailing '**' matches anything
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) {
        const alts = g.slice(i + 1, end).split(',').map((a) => a.replace(/[.+^$()|[\]\\]/g, '\\$&'));
        re += '(?:' + alts.join('|') + ')';
        i = end;
      } else re += '\\{';
    } else if ('.+^$()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', IS_WIN ? 'i' : '');
}

// globs list with optional '!' negations; relPath is repo-relative with forward slashes
function matchesGlobs(relPath, globs) {
  const rel = norm(relPath);
  let hit = false;
  for (const g of globs) {
    if (g.startsWith('!')) {
      if (globToRegex(g.slice(1)).test(rel)) return false;
    } else if (globToRegex(g).test(rel)) {
      hit = true;
    }
  }
  return hit;
}

function branchProtected(branch) {
  if (!branch) return false;
  return listOption('protected_branches').some((g) => globToRegex(g).test(branch));
}

// plugin agents may arrive as "dw:implementer"; compare on the bare name
function agentName(input) {
  const a = input && (input.agent_type || '');
  return String(a).split(':').pop().toLowerCase();
}

module.exports = {
  IS_WIN,
  DEFAULTS,
  failSafe,
  readInput,
  decide,
  emit,
  option,
  listOption,
  norm,
  same,
  isInside,
  resolveFrom,
  existingDir,
  git,
  repoInfo,
  real,
  mainCheckout,
  worktrees,
  itemAt,
  isIgnored,
  stateDir,
  readJson,
  activeItem,
  fileHash,
  changedLocks,
  normalizePlan,
  planSha,
  planPhase,
  PRE_APPROVAL_PHASES,
  isPreApproval,
  globToRegex,
  matchesGlobs,
  branchProtected,
  agentName,
  ITEM_ID,
  normId,
  itemRef,
};
