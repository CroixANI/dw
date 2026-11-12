#!/usr/bin/env node
'use strict';
// PreToolUse gate for Bash | PowerShell.
//   G2 commit, G3 push/PR/GitHub code writes, G4 issue (tracker) writes -> "ask" (a human approves)
//   gate 1: set-phase approved / any jump past the plan   -> "ask" (once: skipped if ExitPlanMode approval was recorded)
//   destructive discards, test unlock, dw state clear     -> "ask"
//   commit while a locked test changed                    -> "deny"
//   test runs by implementer/simplifier                   -> "deny" (no tests during coding)
// Wrapped commands (bash -c, pwsh -Command / -EncodedCommand, cmd /c, eval) are unwrapped and classified too.
// Never rewrites the command.
const c = require('./lib/common');
const sh = require('./lib/shell');
const profiles = require('./lib/profiles');

c.failSafe();
const input = c.readInput();
const cmd = String((input.tool_input && input.tool_input.command) || '');
if (!cmd.trim()) process.exit(0);
const agent = c.agentName(input);

const findings = [];
const seen = new Set();
const ask = (gate, what, how) => {
  const key = gate + what;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({ decision: 'ask', reason: `[dw ${gate}] ${what} needs your approval. ${how}` });
};
const deny = (why) => findings.push({ decision: 'deny', reason: '[dw guard] ' + why });

const GH_HOST = /(github\.com|\/api\/v3\/|api\.github)/i;
// GitHub REST / GraphQL targets that change issues (the tracker): gate 4 instead of gate 3
const TRACKER_ENDPOINT = /(^|\/)(issues|labels|milestones)(\/|$|\?)|sub_issues/i;
const TRACKER_MUTATION = /\b(create|update|delete|close|reopen|add|remove|transfer|pin|unpin|lock|unlock)(Issue|Issues|Label|Labels|SubIssue|ProjectV2\w*|Comment)\w*/;
const WRITE_METHOD = /^(post|put|patch|delete)$/i;

const G2 = 'gate 2 - commit';
const G3 = 'gate 3 - push/PR';
const G4 = 'gate 4 - tracker write';
const GD = 'discard guard';
const GU = 'test lock';
const HOW2 = 'Approve only after reviewing the staged diff and the test-runner result.';
const HOW3 = 'Approve only if the commit(s) and PR text are what you want published.';
const HOW4 = 'GitHub issues are the source of truth; approve only if this issue change is intended.';

function classifyGit(t) {
  const sub = sh.subcommands(t, new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']), 2);
  const s = sub[0];
  if (!s) return;
  if (s === 'commit') {
    ask(G2, '`git commit`', HOW2);
    const changed = c.changedLocks(c.activeItem(cwd));
    if (changed.length) {
      deny(
        `Locked test(s) changed since they were locked: ${changed.join(', ')}. Restore them (the user can, or ` +
          '/dw:unlock-tests with a reason) before committing; the fix belongs in production code.'
      );
    }
  }
  if (s === 'pull') {
    if (sh.hasFlag(t, ['--rebase', '-r'])) ask(GD, '`git pull --rebase`', 'It rewrites local commits.');
    else if (!sh.hasFlag(t, ['--ff-only'])) ask(G2, '`git pull` (may create a merge commit)', HOW2 + ' Prefer `git pull --ff-only`.');
  }
  if (s === 'rebase' && !sh.hasFlag(t, ['--abort', '--quit', '--continue', '--skip', '--show-current-patch'])) {
    ask(GD, '`git rebase`', 'It rewrites commits; a bad rebase can lose work.');
  }
  if (s === 'worktree' && sub[1] === 'remove' && sh.hasFlag(t, ['--force', '-f'])) {
    ask(GD, '`git worktree remove --force`', 'It deletes the worktree including uncommitted changes.');
  }
  if ((s === 'switch' || s === 'checkout') && sh.hasFlag(t, ['--discard-changes', '--force', '-f'])) {
    ask(GD, '`git ' + s + ' --force`', 'It discards working-tree changes.');
  }
  if (s === 'cherry-pick' || s === 'revert') {
    if (!sh.hasFlag(t, ['--abort', '--quit', '--skip'])) ask(G2, '`git ' + s + '` (creates commits)', HOW2);
  }
  if (s === 'merge' && !sh.hasFlag(t, ['--abort', '--quit', '--ff-only'])) ask(G2, '`git merge`', HOW2);
  if (s === 'push') ask(G3, '`git push`', HOW3);
  // destructive discards (the old settings.local.json auto-allowed `git restore *`)
  if (s === 'reset' && sh.hasFlag(t, ['--hard', '--merge', '--keep'])) ask(GD, '`git reset --hard`', 'It discards uncommitted work.');
  if (s === 'clean' && t.some((w) => /^-[a-zA-Z]*f/.test(w) || w === '--force')) ask(GD, '`git clean -f`', 'It deletes untracked files.');
  if (s === 'restore' && !sh.hasFlag(t, ['--staged', '-S']) ) ask(GD, '`git restore`', 'It discards working-tree changes.');
  if (s === 'checkout' && (t.includes('--') || t.includes('.'))) ask(GD, '`git checkout -- <path>`', 'It discards working-tree changes.');
  if (s === 'stash' && (sub[1] === 'drop' || sub[1] === 'clear')) ask(GD, '`git stash ' + sub[1] + '`', 'It deletes stashed work.');
  if (s === 'branch' && t.some((w) => w === '-D' || (w === '--delete' && t.includes('--force')))) ask(GD, '`git branch -D`', 'It deletes a branch that may hold unmerged work.');
}

function classifyGh(t, raw) {
  const sub = sh.subcommands(t, new Set(['-R', '--repo', '--hostname']), 2);
  const [a, b] = sub;
  // gate 4: the tracker (issues, labels, project items)
  const trackerWrites = {
    issue: ['create', 'edit', 'comment', 'close', 'reopen', 'delete', 'transfer', 'lock', 'unlock', 'pin', 'unpin', 'develop'],
    label: ['create', 'edit', 'delete', 'clone'],
    project: ['item-add', 'item-archive', 'item-create', 'item-delete', 'item-edit', 'field-create', 'field-delete', 'create', 'edit', 'delete', 'close', 'copy', 'link', 'unlink'],
  };
  // gate 3: code and everything else published on GitHub
  const codeWrites = {
    pr: ['create', 'edit', 'merge', 'comment', 'review', 'close', 'reopen', 'ready', 'lock', 'unlock'],
    stack: ['submit', 'push', 'sync'],
    release: ['create', 'edit', 'delete', 'upload'],
    repo: ['create', 'edit', 'delete', 'rename', 'archive', 'fork'],
    workflow: ['run', 'enable', 'disable'],
    run: ['rerun', 'cancel', 'delete'],
    secret: ['set', 'delete'],
    variable: ['set', 'delete'],
  };
  if (a && trackerWrites[a] && trackerWrites[a].includes(b)) {
    ask(G4, '`gh ' + a + ' ' + b + '`', HOW4);
    return;
  }
  if (a && codeWrites[a] && codeWrites[a].includes(b)) {
    ask(G3, '`gh ' + a + ' ' + b + '`', HOW3);
    return;
  }
  if (a === 'api') {
    const method = sh.flagValue(t, ['-X', '--method']);
    const endpoint = sub[1] || '';
    const hasFields = sh.hasFlag(t, ['-f', '-F', '--field', '--raw-field', '--input']);
    const mutation = endpoint === 'graphql' && /\bmutation\b/.test(raw);
    let write = false;
    if (method) write = WRITE_METHOD.test(method);
    else if (endpoint === 'graphql') write = mutation;
    else write = hasFields; // gh api defaults to POST when fields are given
    if (mutation) write = true;
    if (!write) return;
    const what = '`gh api` write (' + (method || (endpoint === 'graphql' ? 'graphql mutation' : 'POST')) + ')';
    const tracker = endpoint === 'graphql' ? TRACKER_MUTATION.test(raw) : TRACKER_ENDPOINT.test(endpoint);
    if (tracker) ask(G4, what, HOW4);
    else ask(G3, what, HOW3);
  }
}

function classifyHttp(t, raw) {
  const prog = t[0];
  let method = null;
  let hasBody = false;
  if (prog === 'curl') {
    method = sh.flagValue(t, ['-X', '--request']);
    hasBody = sh.hasFlag(t, ['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '-F', '--form', '-T', '--upload-file']);
  } else {
    method = sh.flagValue(t, ['-Method', '-method']);
    if (!method) {
      const i = t.findIndex((w) => /^-method$/i.test(w));
      if (i >= 0) method = t[i + 1];
    }
  }
  const write = method ? WRITE_METHOD.test(method) : hasBody;
  if (!write) return;
  if (!GH_HOST.test(raw)) return;
  const url = (raw.match(/https?:\/\/\S+/) || [''])[0].replace(/["']+$/, '');
  if (TRACKER_ENDPOINT.test(url.replace(/^https?:\/\/[^/]+/, ''))) ask(G4, prog + ' ' + (method || 'POST') + ' to GitHub issues', HOW4);
  else ask(G3, prog + ' ' + (method || 'POST') + ' to GitHub', HOW3);
}

// ---- Bash/PowerShell writes to test files (the Edit guard cannot see these) ----
// e.g. `cat > Tests/x.cs <<EOF`, `sed -i`, `cp`, `Set-Content`. Found by an eval: a model tried exactly this.
const WRITE_CMD = /(^|[^0-9&])>{1,2}\s*[^&\s]|\btee\b|\b(writeFileSync|appendFileSync|unlinkSync|rmSync|renameSync|copyFileSync|writeFile|appendFile|unlink)\s*\(|\bopen\([^)]*,\s*['"][wa]|\bsed\s+(-\w*\s+)*-i|\bperl\s+-\w*i|\b(cp|mv|rm|truncate|dd|install|ln)\s|\bgit\s+(checkout|restore|apply|stash\s+pop)\b|\b(set-content|add-content|out-file|remove-item|move-item|copy-item|new-item)\b|\[io\.file\]::write/i;

function lockedTestsEverywhere(cwd) {
  // locks of every worktree of this repo (the command may `cd` into a worktree from the main checkout)
  const out = [];
  const trees = c.worktrees(cwd);
  // checkouts of other repos bound to the same item (dw-state bind-repo) hold locks too
  trees.push(...profiles.itemCheckouts(cwd));
  for (const wt of trees) {
    const gd = c.git(wt, ['rev-parse', '--absolute-git-dir']);
    const lock = gd && c.readJson(require('path').join(c.stateDir(gd), 'tests-locked.json'));
    if (lock && lock.files) out.push(...lock.files);
  }
  return out;
}

const cwd = input.cwd || process.cwd();
// test commands / test files of this repo and of every repo bound to the same item
const rules = profiles.itemTestRules(cwd);
const buildCmd = profiles.profileFor(cwd).build_cmd;
const testRe = new RegExp(rules.patterns.map((p) => '(?:' + p + ')').join('|'), 'i'); // patterns are validated in profiles.js

if (WRITE_CMD.test(cmd)) {
  const norm = cmd.replace(/\\/g, '/');
  // dw state and plan.md are checked per segment by what the segment writes to (see checkProtectedWrites)
  for (const f of lockedTestsEverywhere(cwd)) {
    if (norm.includes(f) || norm.includes(require('path').basename(f))) {
      deny(
        `This shell command looks like it writes to the locked test ${f}. Locked tests change only after the user runs ` +
          '/dw:unlock-tests with a reason; make the test pass by changing production code instead.'
      );
      break;
    }
  }
  if (agent === 'implementer' || agent === 'simplifier') {
    const globs = rules.globs;
    const paths = (norm.match(/[\w.\-/]+\.[A-Za-z0-9]+/g) || []).filter((p) => p.includes('/'));
    const hit = paths.find((p) => c.matchesGlobs(p.replace(/^\.\//, ''), globs) || c.matchesGlobs('x/' + p.replace(/^\.\//, ''), globs));
    if (hit) deny(`${agent} may not write test files via the shell (${hit}). Tests belong to test-author.`);
  }
}

// ---- writes to dw state / plan.md, judged per segment by the write TARGET ----
// Reading (`cat plan.md > /tmp/x`, `cp plan.md /tmp/x`) is fine; mentioning dw-state.js elsewhere exempts nothing.
const STATE_FILE = /(^|\/)dw\/[\w.-]+\.json$|(^|\/)(tests-locked|plan-approval)\.json$/i;
const STATE_ANY = /dw\/[\w.-]+\.json|(tests-locked|plan-approval)\.json/i;
const PLAN_FILE = /(^|\/)plan\.md$/i;
const PLAN_ANY = /plan\.md/i;
const SCRIPT_WRITE = /\b(writeFileSync|appendFileSync|unlinkSync|rmSync|renameSync|copyFileSync|writeFile|appendFile|unlink)\s*\(|\bopen\([^)]*,\s*['"][wa]|\[io\.file\]::write/i;
const WRITES_ALL_ARGS = new Set([
  'rm', 'unlink', 'truncate', 'tee', 'shred', 'touch', 'ln', 'mv', 'set-content', 'add-content', 'out-file',
  'remove-item', 'new-item', 'clear-content', 'move-item', 'rename-item', 'sc', 'ac', 'ri', 'del', 'erase', 'move', 'ren',
]);
const WRITES_LAST_ARG = new Set(['cp', 'install', 'copy-item', 'copy', 'cpi', 'xcopy']);

const unquote = (x) => String(x).replace(/^["']+|["']+$/g, '').replace(/\\/g, '/');

function writeTargets(seg, t) {
  const out = [];
  // > file, >> file, 1> file (not 2>&1, not =>)
  const re = /(?:^|[^0-9&<>=])\d?>{1,2}(?!&)\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g;
  let m;
  while ((m = re.exec(seg))) out.push(unquote(m[1]));
  const prog = t[0];
  const args = t.slice(1).filter((a) => !a.startsWith('-')).map(unquote);
  if (WRITES_ALL_ARGS.has(prog)) out.push(...args);
  if (WRITES_LAST_ARG.has(prog) && args.length) out.push(args[args.length - 1]);
  if (prog === 'sed' && t.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) out.push(...args);
  if (prog === 'perl' && t.some((a) => /^-\w*i/.test(a))) out.push(...args);
  if (prog === 'dd') t.filter((a) => a.startsWith('of=')).forEach((a) => out.push(unquote(a.slice(3))));
  return out;
}

// the per-checkout state directory: deleting or moving it unbinds the item and switches off every guard
const DW_DIR = /(^|[\s\\/'"=])\.git[\\/]+dw([\\/'"\s]|$)/i;
const REPO_PROFILES = /dw-repos\.json|\.claude[\\/]+dw\.json/i;

function checkProtectedWrites(seg, t) {
  const targets = writeTargets(seg, t);
  if (targets.some((f) => DW_DIR.test(f)) || (/^(cd|pushd|set-location|sl)$/.test(t[0]) && DW_DIR.test(seg))) {
    deny(
      'The dw state directory (<git-dir>/dw) may not be deleted, moved, cleared or entered from the shell: that would unbind the item ' +
        'and switch off the plan gate and test locks. Use dw-state.js (clear asks you) instead.'
    );
  }
  if (targets.some((f) => REPO_PROFILES.test(f)) || (SCRIPT_WRITE.test(seg) && REPO_PROFILES.test(seg))) {
    ask(
      'repo profiles',
      'Changing a dw repo profile (dw-repos.json or .claude/dw.json) from the shell',
      'It sets test files, test commands and base branches for every item; approve only if you intended that.'
    );
  }
  const scripted = SCRIPT_WRITE.test(seg); // node -e / python -c / pwsh .NET writes: any mention counts
  if (targets.some((f) => STATE_FILE.test(f)) || (scripted && STATE_ANY.test(seg))) {
    deny(
      'dw run state (<git-dir>/dw/item.json, tests-locked.json, plan-approval.json) is changed only by dw-state.js ' +
        'and the dw hooks; the test lock only through /dw:unlock-tests, which the user runs. Do not edit, overwrite or delete these files.'
    );
  }
  if (targets.some((f) => PLAN_FILE.test(f)) || (scripted && PLAN_ANY.test(seg))) {
    ask(
      'gate 1 - plan',
      'Changing or deleting plan.md from the shell',
      'plan.md carries the approved phase; edit it with Edit/Write (guarded) or dw-state.js instead.'
    );
  }
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd']);

// Inner command of `bash -c '...'`, `pwsh -Command ...`, `pwsh -EncodedCommand <b64>`, `cmd /c ...`, `eval ...`.
function unwrap(t) {
  if (t[0] === 'eval') return t.slice(1).join(' ');
  if (!SHELLS.has(t[0])) return null;
  for (let i = 1; i < t.length; i++) {
    const w = t[i].toLowerCase();
    if (/^-(encodedcommand|enc|ec|e)$/.test(w) && t[0] !== 'bash' && t[0] !== 'sh' && i + 1 < t.length) {
      try {
        return Buffer.from(t[i + 1], 'base64').toString('utf16le');
      } catch (_) {
        return null;
      }
    }
    if (w === '-c' || w === '-command' || w === '/c' || w === '/k' || /^-[a-z]*c$/.test(w)) return t.slice(i + 1).join(' ');
    if (w === '-file' || w === '-f') return null; // a script file: its content is not visible here
  }
  return null;
}

const SET_PHASE = /dw-state(?:\.js)?["']?\s+set-phase\s+["']?([a-z_-]+)/i;

function gate1(target) {
  const active = c.activeItem(cwd);
  if (target === 'approved') {
    const rec = active && c.readJson(require('path').join(active.dir, 'plan-approval.json'));
    if (rec && rec.at && (!active.item.created || rec.at >= active.item.created)) {
      let text = '';
      try {
        text = require('fs').readFileSync(require('path').join(active.item.item_dir, 'plan.md'), 'utf8');
      } catch (_) {
        text = '';
      }
      if (rec.plan_sha256 && c.planSha(text) === rec.plan_sha256) return; // approved once, in plan mode, same plan
      ask(
        'gate 1 - plan',
        'Marking plan.md approved: plan.md differs from the plan you approved in plan mode',
        'Approve only if you have read the current plan.md and accept it; code edits are blocked until then.'
      );
      return;
    }
    ask('gate 1 - plan', 'Marking plan.md approved', 'Approve only if you have read and accept plan.md; code edits are blocked until then.');
    return;
  }
  if (c.isPreApproval(target)) return;
  const current = active ? c.planPhase(active.item.item_dir) : null;
  if (c.isPreApproval(current)) {
    ask(
      'gate 1 - plan',
      `Moving plan.md from '${current || 'unknown'}' to '${target}' (skips plan approval)`,
      'The step after the plan is `set-phase approved`; approve only if you accept plan.md.'
    );
  }
}

function classify(command, depth) {
  for (const seg of sh.splitSegments(command)) {
    const t = sh.normalizeTokens(sh.tokenize(seg));
    if (!t.length) continue;
    const prog = t[0];

    const inner = depth < 3 ? unwrap(t) : null;
    if (inner) classify(inner, depth + 1);
    checkProtectedWrites(seg, t);

    if (prog === 'git') classifyGit(t);
    else if (prog === 'gh') classifyGh(t, seg);
    else if (prog === 'curl' || /^(invoke-restmethod|invoke-webrequest|irm|iwr)$/.test(prog)) classifyHttp(t, seg);

    const sp = SET_PHASE.exec(seg);
    if (sp) gate1(sp[1].toLowerCase());
    if (/dw-state(?:\.js)?["']?\s+unlock-tests/.test(seg)) {
      ask(GU, 'Unlocking the failing tests', 'Approve only if the test itself is wrong; the reason is recorded in plan.md.');
    }
    if (/dw-state(?:\.js)?["']?\s+clear\b/.test(seg)) {
      ask('dw state', '`dw-state.js clear`', 'It unbinds the item and drops the test lock, switching off every per-item guard. Approve only when the item is done.');
    }
    if ((agent === 'implementer' || agent === 'simplifier') && testRe.test(seg)) {
      deny(
        `${agent} may not run tests ("${seg.slice(0, 80)}"). Tests run at two points only: test-author proves new ` +
          'tests fail (test-first), and test-runner runs them once before the commit. Check compilation with ' +
          (buildCmd ? '`' + buildCmd + '`' : "the repo's build command") + ' and report back.'
      );
    }
  }
}

classify(cmd, 0);

c.emit(findings);
