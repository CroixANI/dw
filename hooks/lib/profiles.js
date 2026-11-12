'use strict';
// Repo profiles. The core knows no stack: hooks and agents only read the effective profile of a checkout.
//   test_globs, test_command_pattern            -> enforcement (test lock, no test runs during coding)
//   build_cmd, test_cmd, test_filter_hint,
//   lint_cmd, format_cmd                        -> what test-runner / test-author run
//   base_branch, gh_repo, copy_untracked, single_command_shell
// Resolution, per field: <checkout>/.claude/dw.json > <research_root>/dw-repos.json {"<repo>": {...}} > detected presets
// (presets/*.json) > built-in fallback. Test globs and test command patterns are never replaced, only ADDED to the
// fallback: a profile cannot switch test protection off.
const fs = require('fs');
const path = require('path');
const c = require('./common');

const PRESET_DIR = path.join(__dirname, '..', '..', 'presets');

// Generic fallback: what counts as a test file / test run when nothing else says so. Deliberately broad (fail safe).
const FALLBACK = {
  test_globs: [
    '**/test/**',
    '**/tests/**',
    '**/__tests__/**',
    '**/spec/**',
    '**/*.test.*',
    '**/*.spec.*',
    '**/*_test.*',
    '**/*_spec.*',
    '**/test_*.py',
  ],
  test_command_pattern: [
    '\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?test\\b',
    '\\b(jest|vitest|mocha|ava|karma|jasmine)\\b',
    '\\bplaywright\\s+test\\b',
    '\\bng\\s+test\\b',
    '\\bnode\\b[^|;&]*\\s--test\\b',
    '\\b(deno|bun)\\s+test\\b',
    '\\bdotnet(\\.exe)?\\s+(test|vstest)\\b',
    'vstest\\.console',
    '\\bpytest\\b',
    '\\bpython[0-9.]*\\s+-m\\s+(pytest|unittest)\\b',
    '\\b(tox|nox)\\b',
    '\\bcargo\\s+(test|nextest)\\b',
    '\\bgo\\s+test\\b',
    '\\b(mvn|mvnw|gradle|gradlew)\\b[^|;&]*\\btest\\b',
    '\\b(rspec|phpunit|ctest)\\b',
    '\\brake\\s+test\\b',
    '\\bmix\\s+test\\b',
    '\\bswift\\s+test\\b',
    '\\bmake\\s+(test|check)\\b',
  ].join('|'),
};

const TEXT_FIELDS = ['build_cmd', 'test_cmd', 'test_filter_hint', 'lint_cmd', 'format_cmd'];

// ---- validation: profile files can be written by an agent, so every field is checked ----
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_GH = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const okText = (v) => typeof v === 'string' && v.length > 0 && v.length <= 300 && !/[\r\n]/.test(v);
function validPattern(p) {
  try {
    if (typeof p !== 'string' || !p || p.length > 600) return false;
    if (/\([^)]*[+*][^)]*\)[+*{]/.test(p)) return false; // nested quantifier: catastrophic backtracking
    new RegExp(p);
    return true;
  } catch (_) {
    return false;
  }
}
const own = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\n]/)).map((s) => String(s).trim()).filter(Boolean);

// Keep only valid fields of one profile source; everything dropped is reported in warnings (`dw-state.js repos|profile`).
function cleanProfile(o, src, warnings) {
  const out = {};
  const bad = (k, why) => warnings.push(`${src}: ignored ${k} (${why})`);
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  if (o.base_branch !== undefined) SAFE_BRANCH.test(String(o.base_branch)) ? (out.base_branch = String(o.base_branch)) : bad('base_branch', 'not a plain branch name');
  if (o.gh_repo !== undefined) SAFE_GH.test(String(o.gh_repo)) ? (out.gh_repo = String(o.gh_repo)) : bad('gh_repo', 'expected host/owner/repo');
  if (o.stacks !== undefined) {
    const all = asList(o.stacks);
    out.stacks = all.filter((s) => SAFE_NAME.test(s));
    if (out.stacks.length !== all.length) bad('stacks', 'names must be plain preset names');
  }
  if (o.test_globs !== undefined) {
    const all = asList(o.test_globs);
    out.test_globs = all.filter((g) => okText(g) && !g.startsWith('!'));
    if (out.test_globs.length !== all.length || !all.length) bad('test_globs', 'empty, or negated entries are not allowed (tests can only be added)');
  }
  if (o.test_command_pattern !== undefined) {
    validPattern(o.test_command_pattern) ? (out.test_command_pattern = o.test_command_pattern) : bad('test_command_pattern', 'invalid or unsafe regex');
  }
  for (const k of TEXT_FIELDS) {
    if (o[k] === undefined || o[k] === '') continue;
    okText(o[k]) ? (out[k] = o[k]) : bad(k, 'must be a single short line');
  }
  if (o.copy_untracked !== undefined) {
    const all = asList(o.copy_untracked);
    // relative paths inside the checkout only: no absolute paths, no '..'
    out.copy_untracked = all.filter((f) => okText(f) && !path.isAbsolute(f) && !/^[a-zA-Z]:/.test(f) && !f.split(/[\\/]/).includes('..'));
    if (out.copy_untracked.length !== all.length) bad('copy_untracked', 'only relative paths inside the checkout');
  }
  if (o.single_command_shell !== undefined) out.single_command_shell = o.single_command_shell === true;
  return out;
}

// ---- presets ----
let presetCache = null;
function presets() {
  if (presetCache) return presetCache;
  presetCache = {};
  let files = [];
  try {
    files = fs.readdirSync(PRESET_DIR).filter((f) => f.endsWith('.json'));
  } catch (_) {
    files = [];
  }
  for (const f of files.sort()) {
    const raw = c.readJson(path.join(PRESET_DIR, f));
    const name = path.basename(f, '.json');
    if (!raw || !SAFE_NAME.test(name)) continue;
    presetCache[name] = { name, detect: asList(raw.detect), ...cleanProfile(raw, 'presets/' + f, []) };
  }
  return presetCache;
}

// File names at the checkout root and one level below (node_modules and dot folders skipped). Cheap enough per hook call.
function shallowFiles(top) {
  const out = [];
  const list = (d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return [];
    }
  };
  for (const e of list(top)) {
    if (e.isFile()) out.push(e.name);
    else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      for (const f of list(path.join(top, e.name))) if (f.isFile()) out.push(e.name + '/' + f.name);
    }
  }
  return out;
}

function detectPresets(top) {
  const files = shallowFiles(top);
  const hits = [];
  for (const p of Object.values(presets())) {
    const rules = p.detect.map((g) => c.globToRegex(g.includes('/') ? g : '**/' + g));
    if (rules.some((re) => files.some((f) => re.test(f)))) hits.push(p.name);
  }
  return hits;
}

// ---- repo identity ----
// repo name from the origin remote; fallback: folder name of the main checkout
function repoName(dir) {
  const url = c.git(dir, ['remote', 'get-url', 'origin']);
  if (url) {
    const last = url.replace(/[\\/]+$/, '').split(/[\\/:]/).pop().replace(/\.git$/i, '');
    if (last) return last;
  }
  const main = c.mainCheckout(dir);
  if (main) return path.basename(main);
  const info = c.repoInfo(dir);
  return info ? path.basename(info.toplevel) : '';
}

// host/owner/repo from the origin URL (https://host/owner/repo(.git), git@host:owner/repo(.git), ssh://git@host/owner/repo)
function ghRepoFromOrigin(dir) {
  const url = (c.git(dir, ['remote', 'get-url', 'origin']) || '').trim();
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  const v = m ? `${m[1]}/${m[2]}/${m[3]}` : '';
  return SAFE_GH.test(v) ? v : '';
}

// origin/HEAD (the remote's default branch), else 'main'
function defaultBranch(dir) {
  const ref = c.git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']) || '';
  const b = ref.replace(/^origin\//, '');
  return SAFE_BRANCH.test(b) ? b : 'main';
}

// The one research-root rule: explicit override (--root) > research_root option > <parent of main checkout>/<family>-research
// (family = checkout folder name up to the first '.'). A leftover ${...} placeholder counts as unset. '' outside a repo.
function researchRoot(dir, override) {
  const unset = (v) => !v || v === true || /\$\{[^}]*\}/.test(String(v)) || !String(v).trim();
  for (const v of [override, c.option('research_root')]) if (!unset(v)) return c.norm(String(v).trim());
  const main = c.mainCheckout(dir);
  return main ? c.norm(path.join(path.dirname(main), path.basename(main).split('.')[0] + '-research')) : '';
}

function overrides(dir) {
  const root = researchRoot(dir);
  return (root && c.readJson(path.join(root, 'dw-repos.json'))) || {};
}

function repoFile(dir) {
  const info = c.repoInfo(dir);
  return info ? c.readJson(path.join(info.toplevel, '.claude', 'dw.json')) : null;
}

// Effective profile of the repo containing dir (any checkout or worktree of it). Memoised: a hook process is short-lived.
const cache = new Map();
function profileFor(dir) {
  const key = c.norm(dir);
  if (!cache.has(key)) cache.set(key, buildProfile(dir));
  return cache.get(key);
}

function buildProfile(dir) {
  const name = repoName(dir);
  const info = c.repoInfo(dir);
  const warnings = [];
  const source = [];
  const fileRaw = repoFile(dir);
  const file = fileRaw ? cleanProfile(fileRaw, '.claude/dw.json', warnings) : {};
  if (fileRaw) source.push('.claude/dw.json');
  const ovAll = overrides(dir);
  const ov = own(ovAll, name) ? cleanProfile(ovAll[name], 'dw-repos.json', warnings) : {};
  if (own(ovAll, name)) source.push('dw-repos.json');

  const all = presets();
  const forced = file.stacks || ov.stacks;
  const stacks = forced ? forced.filter((s) => own(all, s)) : info ? detectPresets(info.toplevel) : [];
  if (forced) for (const s of forced) if (!own(all, s)) warnings.push(`stacks: no preset named '${s}'`);
  for (const s of stacks) source.push('preset:' + s);
  if (!source.length) source.push('fallback');
  const layers = [file, ov, ...stacks.map((s) => all[s])]; // highest priority first

  const first = (k) => {
    for (const l of layers) if (l && l[k] !== undefined && l[k] !== '') return l[k];
    return undefined;
  };
  const globs = [...FALLBACK.test_globs];
  const patterns = [FALLBACK.test_command_pattern];
  const copy = [];
  for (const l of layers) {
    for (const g of l.test_globs || []) if (!globs.includes(g)) globs.push(g);
    if (l.test_command_pattern && !patterns.includes(l.test_command_pattern)) patterns.push(l.test_command_pattern);
    for (const f of l.copy_untracked || []) if (!copy.includes(f)) copy.push(f);
  }

  const out = {
    repo: name,
    stacks,
    profile_source: source,
    base_branch: first('base_branch') || (info ? defaultBranch(info.toplevel) : 'main'),
    gh_repo: first('gh_repo') || (info ? ghRepoFromOrigin(info.toplevel) : ''),
    test_globs: globs,
    test_command_pattern: patterns.map((p) => '(?:' + p + ')').join('|'),
    copy_untracked: copy,
    single_command_shell: first('single_command_shell') === true,
    warnings,
  };
  for (const k of TEXT_FIELDS) out[k] = first(k) || '';
  return out;
}

// true for a repo that has its own profile (.claude/dw.json or a dw-repos.json entry)
function knownRepo(dir) {
  return Boolean(repoFile(dir)) || own(overrides(dir), repoName(dir));
}

// bound_repos entries are objects {path, repo, branch}. One normaliser for every reader.
function normalizeBound(item) {
  return ((item && item.bound_repos) || [])
    .filter((b) => b && typeof b === 'object' && b.path)
    .map((b) => ({ path: b.path, repo: b.repo || '', branch: b.branch || '' }));
}
const boundPaths = (item) => normalizeBound(item).map((b) => b.path);

// Checkouts that belong to the item bound to cwd: the primary one first, then every bound repo.
function itemCheckouts(cwd) {
  const active = c.activeItem(cwd);
  if (!active) return [];
  const primary = active.item.primary ? c.activeItem(active.item.primary) : null;
  const owner = primary || active;
  const out = [owner.info.toplevel];
  for (const p of [active.info.toplevel, ...boundPaths(owner.item)]) if (!out.some((o) => c.same(o, p))) out.push(p);
  return out;
}

// Union over the session's checkout and its bound repos: what counts as a test command / test file anywhere in the item.
function itemTestRules(cwd) {
  const dirs = itemCheckouts(cwd);
  if (!dirs.length) dirs.push(cwd);
  const patterns = [];
  const globs = [];
  for (const d of dirs) {
    const p = profileFor(d);
    if (p.test_command_pattern && !patterns.includes(p.test_command_pattern)) patterns.push(p.test_command_pattern);
    for (const g of p.test_globs) if (!globs.includes(g)) globs.push(g);
  }
  return { patterns, globs };
}

module.exports = {
  FALLBACK,
  validPattern,
  cleanProfile,
  presets,
  detectPresets,
  knownRepo,
  repoName,
  ghRepoFromOrigin,
  defaultBranch,
  researchRoot,
  profileFor,
  normalizeBound,
  boundPaths,
  itemCheckouts,
  itemTestRules,
};
