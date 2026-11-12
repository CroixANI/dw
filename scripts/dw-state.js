#!/usr/bin/env node
'use strict';
// dw run-state helper. State lives in <git-dir>/dw/ of the item's worktree (per worktree, never committed):
//   item.json          {item_id, tracker, issue_url?, type, item_dir, worktree, branch, repo, created,
//                       bound_repos?: [{path, repo, branch}], primary?: <path>}   (bound_repos on the primary checkout; primary on a bound one)
//   tests-locked.json  {files: [repo-relative paths], hashes: {path: sha256}, locked_at}
//   plan-approval.json {at, plan_sha256}  written by hooks/plan-approved.js when the user approves ExitPlanMode
// Item ids: a GitHub issue number (42, #42 accepted) or a local item (local-3).
// Hand edits inside .git are blocked by guard-edit.js; shell writes to these files by gate-bash.js.
// gate-bash.js asks the user for: set-phase approved (unless plan-approval.json exists), any jump from a
// pre-approval phase, unlock-tests and clear.
//
// Usage. Where to run: item-path, next-local-id and profile anywhere in the repo; init and bind-repo in the item's checkout;
// find in any checkout of the repo; status, repos, verify-locks, release-locks from any checkout bound to the item;
// lock-tests in the checkout whose tests are locked (or --repo).
//   node dw-state.js init --id 42 --type bug --item-dir "<research_root>/42-slug" [--tracker github|local] [--issue-url <url>]
//   node dw-state.js item-path --id 42 --title "<title>" [--slug "<short description>"] [--root <dir>]
//   node dw-state.js next-local-id [--root <dir>]   (next free local-<n> in the research root)
//   node dw-state.js profile [--repo <checkout>]     (effective repo profile: stacks, test rules, commands; no item needed)
//   node dw-state.js status
//   node dw-state.js lock-tests [--repo <checkout>] <file> [<file> ...]   (--repo: lock in a bound repo; paths relative to it)
//   node dw-state.js unlock-tests --reason "<why the test is wrong>"
//   node dw-state.js verify-locks             (exit 1 + list when a locked test changed since it was locked)
//   node dw-state.js release-locks            (after the commit: locked tests committed unchanged -> lock removed)
//   node dw-state.js find [--id 42]           (searches all worktrees of this repo)
//   node dw-state.js set-phase <phase>        (updates plan.md frontmatter)
//   node dw-state.js bump-fix-cycles          (increments fix_cycles in plan.md, prints the new value)
//   node dw-state.js bind-repo <path>         (bind another repo's checkout to this item; idempotent)
//   node dw-state.js repos                    (primary + bound repos: branch, base branch, gh repo, profile)
//   node dw-state.js clear                    (forget the item for this worktree and unbind every bound repo)
const fs = require('fs');
const path = require('path');
const c = require('../hooks/lib/common');
const profiles = require('../hooks/lib/profiles');

const PHASES = ['intake', 'investigate', 'design', 'plan', 'approved', 'tests', 'implement', 'simplify', 'verify', 'review', 'commit', 'pr', 'sweep', 'done'];

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

function fail(msg) {
  process.stderr.write('dw-state: ' + msg + '\n');
  process.exit(1);
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function here(at) {
  const info = c.repoInfo(at || process.cwd());
  if (!info) fail('not inside a git work tree');
  const dir = c.stateDir(info.gitDir);
  return { info, dir };
}

const TYPES = ['bug', 'feature', 'task', 'epic'];

// --id value, normalised ("#42" -> "42"); fails on anything else
function idArg(required) {
  const raw = a.id;
  if (raw === undefined || raw === true) {
    if (required) fail('needs --id <issue number | local-<n>>');
    return '';
  }
  const id = c.normId(raw);
  if (!id) fail(`--id must be an issue number (42 or #42) or a local id (local-3), got '${raw}'`);
  return id;
}

// profile fields shown by `repos` and `profile`
function profileView(p) {
  return {
    stacks: p.stacks,
    profile_source: p.profile_source,
    base: p.base_branch,
    gh_repo: p.gh_repo,
    build_cmd: p.build_cmd,
    test_cmd: p.test_cmd,
    test_filter_hint: p.test_filter_hint,
    lint_cmd: p.lint_cmd,
    format_cmd: p.format_cmd,
    copy_untracked: p.copy_untracked,
    single_command_shell: p.single_command_shell,
    warnings: p.warnings,
  };
}

function planFile(item) {
  return path.join(item.item_dir, 'plan.md');
}

function editFrontmatter(file, fn) {
  if (!fs.existsSync(file)) fail('plan.md not found: ' + file);
  const text = fs.readFileSync(file, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) fail('plan.md has no YAML frontmatter');
  const fm = fn(m[1]);
  // function replacement: '$&', '$1' ... in the frontmatter must stay literal
  fs.writeFileSync(file, text.replace(m[0], () => '---\n' + fm + '\n---'), 'utf8');
}

function setKey(fm, key, value) {
  const re = new RegExp('^' + key + ':.*$', 'm');
  return re.test(fm) ? fm.replace(re, () => key + ': ' + value) : fm + '\n' + key + ': ' + value;
}

function appendLog(item, line) {
  if (item && fs.existsSync(planFile(item))) fs.appendFileSync(planFile(item), `\n- ${new Date().toISOString()} ${line}\n`);
}

function removeIfExists(p) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// bound_repos with the live branch and repo name of each checkout
function boundList(item) {
  return profiles.normalizeBound(item).map((b) => {
    const ti = c.repoInfo(b.path);
    return { path: b.path, repo: b.repo || (ti ? profiles.repoName(ti.toplevel) : ''), branch: ti ? ti.branch : b.branch };
  });
}

// Active items of every checkout that belongs to the item bound to cwd (primary first)
function itemActives(cwd) {
  const out = [];
  for (const d of profiles.itemCheckouts(cwd)) {
    const act = c.activeItem(d);
    if (act) out.push(act);
  }
  return out;
}

const a = args(process.argv.slice(2));
const cmd = a._[0];

switch (cmd) {
  case 'init': {
    const { info, dir } = here();
    const id = idArg(true);
    if (!a['item-dir'] || a['item-dir'] === true) fail('init needs --item-dir');
    const type = String(a.type && a.type !== true ? a.type : 'task').toLowerCase();
    if (!TYPES.includes(type)) fail('--type must be one of: ' + TYPES.join(', '));
    const tracker = a.tracker && a.tracker !== true ? String(a.tracker) : id.startsWith('local-') ? 'local' : 'github';
    if (!['github', 'local'].includes(tracker)) fail('--tracker must be github or local');
    if (tracker === 'local' && !id.startsWith('local-')) fail('a local item needs a local-<n> id (see next-local-id)');
    if (tracker === 'github' && id.startsWith('local-')) fail('a GitHub item needs the issue number as --id');
    if (!info.branch) fail('refusing to bind an item to a detached HEAD; create the item branch first');
    if (c.branchProtected(info.branch)) fail(`refusing to bind an item to protected branch '${info.branch}'`);
    // The item folder switches off the plan gate for everything under it and is auto-allowed for reads/writes: it must be a
    // folder inside the research root and must not contain a checkout.
    const wanted = c.real(String(a['item-dir']));
    const roots = [profiles.researchRoot(info.toplevel)].filter(Boolean).map(c.real);
    if (!roots.some((r) => c.isInside(wanted, r) && !c.same(wanted, r))) {
      fail(`--item-dir must be a folder inside the research root (${roots[0] || 'unknown'}), got ${wanted}`);
    }
    if (c.worktrees(info.toplevel).some((w) => c.isInside(c.real(w), wanted))) fail('--item-dir must not be or contain a checkout');
    const bound = c.readJson(path.join(dir, 'item.json'));
    if (bound && String(bound.item_id) !== id) {
      fail(`this checkout is already bound to ${c.itemRef(bound)}; use a separate worktree for ${c.itemRef({ item_id: id })} (or 'clear' the old item)`);
    }
    if (bound && bound.item_dir && !c.same(c.real(bound.item_dir), wanted)) {
      fail(`this checkout is already bound to item folder ${bound.item_dir}; refusing to point it elsewhere ('clear' first)`);
    }
    fs.mkdirSync(dir, { recursive: true });
    const item = {
      item_id: id,
      tracker,
      ...(a['issue-url'] && a['issue-url'] !== true ? { issue_url: String(a['issue-url']) } : {}),
      type,
      item_dir: c.norm(path.resolve(String(a['item-dir']))),
      worktree: info.toplevel,
      branch: info.branch,
      repo: profiles.repoName(info.toplevel),
      created: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'item.json'), JSON.stringify(item, null, 2));
    print(item);
    break;
  }
  case 'item-path': {
    // Compute (and create) <research_root>/<id>-<slug>. Root: --root, else <parent of main checkout>/<family>-research
    // (family = checkout folder name up to the first '.'). It must sit outside the main checkout: Claude Code blocks
    // edits to the main checkout from a worktree session.
    const id = idArg(true);
    const root = profiles.researchRoot(process.cwd(), a.root);
    if (!root) fail('not in a git repo and no --root given');
    // --slug is a short description written by the caller (preferred); else fall back to the cleaned title
    const given = a.slug && a.slug !== true ? String(a.slug) : '';
    const slugFull = (given || String(a.title && a.title !== true ? a.title : ''))
      .replace(new RegExp('^\\s*#?' + id + '[\\s:_-]*', 'i'), '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\x00-\x7f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    // short description: whole words only, about 40 characters
    let slug = '';
    for (const w of slugFull.split('-')) {
      if (slug && slug.length + 1 + w.length > 40) break;
      slug = slug ? slug + '-' + w : w;
    }
    // reuse an existing folder for this id even if the title changed
    let existing = null;
    try {
      existing = fs.readdirSync(root).find((d) => d === id || d.toLowerCase().startsWith(id + '-'));
    } catch (_) {
      /* root does not exist yet */
    }
    const dir = path.join(root, existing || [id, slug].filter(Boolean).join('-'));
    fs.mkdirSync(dir, { recursive: true });
    print({ item_dir: c.norm(dir), existed: Boolean(existing) });
    break;
  }
  case 'next-local-id': {
    const root = profiles.researchRoot(process.cwd(), a.root);
    if (!root) fail('not in a git repo and no --root given');
    let max = 0;
    try {
      for (const d of fs.readdirSync(root)) {
        const m = /^local-(\d+)(-|$)/i.exec(d);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    } catch (_) {
      /* no research root yet: local-1 */
    }
    print({ id: 'local-' + (max + 1), root });
    break;
  }
  case 'profile': {
    const at = a.repo && a.repo !== true ? path.resolve(String(a.repo)) : process.cwd();
    const info = c.repoInfo(at);
    if (!info) fail('not inside a git work tree: ' + at);
    const p = profiles.profileFor(info.toplevel);
    print({
      repo: p.repo,
      path: info.toplevel,
      has_repo_profile: fs.existsSync(path.join(info.toplevel, '.claude', 'dw.json')),
      ...profileView(p),
      test_globs: p.test_globs,
      test_command_pattern: p.test_command_pattern,
      presets_available: Object.keys(profiles.presets()),
    });
    break;
  }
  case 'status': {
    const active = c.activeItem(process.cwd());
    if (!active) {
      print({ active: false });
      break;
    }
    print({
      active: true,
      ...active.item,
      bound_repos: boundList(active.item),
      branch: active.info.branch,
      phase: c.planPhase(active.item.item_dir),
      locked_tests: active.locked,
    });
    break;
  }
  case 'lock-tests': {
    // --repo <checkout>: lock tests in a bound repo's own state (paths are relative to that checkout)
    const repoArg = a.repo && a.repo !== true ? path.resolve(String(a.repo)) : '';
    const { info, dir } = here(repoArg);
    const files = a._.slice(1).map((f) => path.relative(c.real(info.toplevel), c.real(path.resolve(repoArg || '.', f))).replace(/\\/g, '/'));
    if (!files.length) fail('lock-tests needs at least one test file');
    fs.mkdirSync(dir, { recursive: true });
    const prev = c.readJson(path.join(dir, 'tests-locked.json'));
    const all = Array.from(new Set([...((prev && prev.files) || []), ...files]));
    // keep the hash from the first lock: re-locking must not bless a modified file
    const hashes = { ...((prev && prev.hashes) || {}) };
    for (const f of all) {
      if (hashes[f]) continue;
      const h = c.fileHash(path.join(info.toplevel, f));
      if (!h) fail('cannot lock missing file ' + f + ' in ' + info.toplevel + ' (wrong repo? use --repo <checkout>)');
      hashes[f] = h;
    }
    fs.writeFileSync(
      path.join(dir, 'tests-locked.json'),
      JSON.stringify({ files: all, hashes, locked_at: new Date().toISOString() }, null, 2)
    );
    print({ locked: all });
    break;
  }
  case 'unlock-tests': {
    const { dir } = here();
    if (!a.reason || a.reason === true) fail('unlock-tests needs --reason "<why>"');
    const lockFile = path.join(dir, 'tests-locked.json');
    const prev = c.readJson(lockFile);
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    appendLog(c.readJson(path.join(dir, 'item.json')), `test lock removed (${((prev && prev.files) || []).join(', ')}): ${a.reason}`);
    print({ unlocked: (prev && prev.files) || [] });
    break;
  }
  case 'verify-locks': {
    // this checkout first, then the repos bound to the same item (their paths are shown absolute)
    const active = c.activeItem(process.cwd());
    const changed = c.changedLocks(active);
    const locked = [...((active && active.locked) || [])];
    for (const other of itemActives(process.cwd())) {
      if (active && c.same(other.info.toplevel, active.info.toplevel)) continue;
      locked.push(...other.locked.map((f) => other.info.toplevel + '/' + f));
      changed.push(...c.changedLocks(other).map((f) => other.info.toplevel + '/' + f));
    }
    print({ locked, changed });
    if (changed.length) process.exit(1);
    break;
  }
  case 'release-locks': {
    // The lock exists so the implementer makes the failing tests pass without touching them. Once those tests
    // are committed unchanged, history holds the proof; later test changes (PR review) show up in the diff.
    // covers this checkout and the repos bound to the same item; a bound repo whose tests are not committed yet keeps its lock
    const first = c.activeItem(process.cwd());
    if (!first) fail('no active dw item in this worktree');
    const phase = c.planPhase(first.item.item_dir);
    if (!['commit', 'pr', 'sweep', 'done'].includes(phase)) fail(`release-locks runs after the commit (phase is '${phase}')`);
    const released = [];
    const pending = [];
    for (const active of itemActives(process.cwd())) {
      if (!active.lock) continue;
      const own = c.same(active.info.toplevel, first.info.toplevel);
      const label = (f) => (own ? f : active.info.toplevel + '/' + f);
      const changed = c.changedLocks(active);
      if (changed.length) fail('locked tests changed since they were locked: ' + changed.map(label).join(', '));
      const dirty = c.git(active.info.toplevel, ['status', '--porcelain', '--', ...active.locked]);
      if (dirty === null || dirty !== '') {
        if (own) fail('locked tests are not committed yet: ' + (dirty || 'git status failed'));
        pending.push(...active.locked.map(label));
        continue;
      }
      removeIfExists(path.join(active.dir, 'tests-locked.json'));
      appendLog(active.item, `test lock released after commit (${active.locked.join(', ')})`);
      released.push(...active.locked.map(label));
    }
    print(pending.length ? { released, pending } : { released });
    break;
  }
  case 'find': {
    const info = c.repoInfo(process.cwd());
    if (!info) fail('not inside a git work tree');
    const want = idArg(false);
    const hits = [];
    for (const t of c.worktrees(process.cwd())) {
      const item = c.itemAt(t);
      if (item && (!want || String(item.item_id) === want)) {
        hits.push({ ...item, worktree: c.norm(t), phase: c.planPhase(item.item_dir), bound_repos: boundList(item) });
      }
    }
    print(hits);
    break;
  }
  case 'set-phase': {
    const phase = a._[1];
    if (!PHASES.includes(phase)) fail('phase must be one of: ' + PHASES.join(', '));
    const active = c.activeItem(process.cwd());
    if (!active) fail('no active dw item in this worktree');
    const current = c.planPhase(active.item.item_dir);
    if (c.isPreApproval(current) && !c.isPreApproval(phase) && phase !== 'approved') {
      fail(`plan.md is in phase '${current || 'unknown'}'; the next step after the plan is 'approved' (gate 1), not '${phase}'`);
    }
    editFrontmatter(planFile(active.item), (fm) => setKey(fm, 'phase', phase));
    if (phase === 'approved') removeIfExists(path.join(active.dir, 'plan-approval.json'));
    print({ phase });
    break;
  }
  case 'bump-fix-cycles': {
    const active = c.activeItem(process.cwd());
    if (!active) fail('no active dw item in this worktree');
    let n = 0;
    editFrontmatter(planFile(active.item), (fm) => {
      const m = /^fix_cycles:\s*(\d+)/m.exec(fm);
      n = (m ? parseInt(m[1], 10) : 0) + 1;
      return setKey(fm, 'fix_cycles', n);
    });
    print({ fix_cycles: n });
    break;
  }
  case 'bind-repo': {
    // Bind another checkout (worktree or main) to this item, so one session can edit both repos.
    const { info, dir } = here();
    const item = c.readJson(path.join(dir, 'item.json'));
    if (!item) fail('no active dw item in this checkout; run init first');
    if (!a._[1]) fail('bind-repo needs <path> of the other checkout');
    const target = c.repoInfo(path.resolve(a._[1]));
    if (!target) fail('not a git checkout: ' + a._[1]);
    if (c.same(target.toplevel, info.toplevel)) fail('that is this checkout already');
    if (!target.branch) fail('refusing to bind a detached HEAD in ' + target.toplevel + '; create the item branch there first');
    if (!profiles.knownRepo(target.toplevel) && !c.same(profiles.researchRoot(target.toplevel), profiles.researchRoot(info.toplevel))) {
      fail(`${target.toplevel} has no repo profile (.claude/dw.json or a dw-repos.json entry) and is not in this item's research family`);
    }
    if (c.branchProtected(target.branch)) {
      fail(`refusing to bind protected branch '${target.branch}' in ${target.toplevel}; create the item branch there first`);
    }
    const tDir = c.stateDir(target.gitDir);
    const tItem = c.readJson(path.join(tDir, 'item.json'));
    if (tItem && String(tItem.item_id) !== String(item.item_id)) {
      fail(`${target.toplevel} is already bound to ${c.itemRef(tItem)}; use a separate checkout for ${c.itemRef(item)}`);
    }
    fs.mkdirSync(tDir, { recursive: true });
    const bound = {
      item_id: item.item_id,
      tracker: item.tracker,
      ...(item.issue_url ? { issue_url: item.issue_url } : {}),
      type: item.type,
      item_dir: item.item_dir,
      worktree: target.toplevel,
      branch: target.branch,
      repo: profiles.repoName(target.toplevel),
      primary: item.primary || info.toplevel,
      created: (tItem && tItem.created) || new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tDir, 'item.json'), JSON.stringify(bound, null, 2));
    const list = profiles.normalizeBound(item).filter((b) => !c.same(b.path, target.toplevel));
    list.push({ path: target.toplevel, repo: bound.repo, branch: target.branch });
    fs.writeFileSync(path.join(dir, 'item.json'), JSON.stringify({ ...item, bound_repos: list }, null, 2));
    print(bound);
    break;
  }
  case 'repos': {
    // Primary checkout first, then every bound repo; works from any checkout of the item.
    const list = [];
    for (const act of itemActives(process.cwd())) {
      const p = profiles.profileFor(act.info.toplevel);
      list.push({
        role: act.item.primary ? 'bound' : 'primary',
        repo: p.repo,
        path: act.info.toplevel,
        branch: act.info.branch,
        locked_tests: act.locked,
        ...profileView(p),
      });
    }
    if (!list.length) fail('no active dw item in this checkout; run from a checkout bound with init or bind-repo');
    print(list);
    break;
  }
  case 'clear': {
    const { dir } = here();
    const item = c.readJson(path.join(dir, 'item.json'));
    const unbound = [];
    for (const p of profiles.boundPaths(item)) {
      const ti = c.repoInfo(p);
      if (!ti) continue;
      const td = c.stateDir(ti.gitDir);
      const bi = c.readJson(path.join(td, 'item.json'));
      if (!bi || String(bi.item_id) !== String(item.item_id)) continue; // no longer this item's
      for (const f of ['item.json', 'tests-locked.json', 'plan-approval.json']) removeIfExists(path.join(td, f));
      unbound.push(ti.toplevel);
    }
    for (const f of ['item.json', 'tests-locked.json', 'plan-approval.json']) removeIfExists(path.join(dir, f));
    print({ cleared: true, unbound });
    break;
  }
  default:
    fail('unknown command. Use: item-path | next-local-id | profile | init | status | lock-tests | unlock-tests | verify-locks | release-locks | find | set-phase | bump-fix-cycles | bind-repo | repos | clear');
}
