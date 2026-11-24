#!/usr/bin/env node
'use strict';
// PreToolUse guard for Edit | Write | MultiEdit | NotebookEdit.
// The "never edit outside the item's worktree / on a protected branch" rules, enforced instead of written in prose.
const path = require('path');
const c = require('./lib/common');
const profiles = require('./lib/profiles');

c.failSafe();
const input = c.readInput();
const ti = input.tool_input || {};
const target = ti.file_path || ti.notebook_path || ti.path;
if (!target) process.exit(0);

const cwd = input.cwd || process.cwd();
// real path: a short 8.3 name, junction or symlink must not make a file look like it is outside (or inside) a checkout
const abs = c.real(c.resolveFrom(cwd, target));
const agent = c.agentName(input);
const findings = [];
const deny = (reason) => findings.push({ decision: 'deny', reason: '[dw guard] ' + reason });

// 0. Repo profiles (dw-repos.json, <repo>/.claude/dw.json) decide test files, test commands and base branches: the user approves each change.
if (/(^|\/)dw-repos\.json$/i.test(abs) || /(^|\/)\.claude\/dw\.json$/i.test(abs)) {
  findings.push({
    decision: 'ask',
    reason: '[dw guard] ' + path.basename(abs) + ' sets test files, test commands and base branches for the repo. Approve only if you intended that change.',
  });
  c.emit(findings);
}

// 1. Never hand-edit anything inside a .git directory (dw state lives there: item.json, tests-locked.json).
if (/(^|\/)\.git(\/|$)/.test(abs)) {
  deny(
    `Edits inside .git are blocked (${abs}). dw state is changed only through ` +
      '`node <plugin>/scripts/dw-state.js` (see /dw:status), and the test lock only through /dw:unlock-tests.'
  );
  c.emit(findings);
}

// 1a. test-runner has Write only for its report in <item>/runs/; it never edits code, tests or anything else.
if (agent === 'test-runner') {
  const own = c.activeItem(cwd);
  const runsDir = own && own.item.item_dir ? path.join(c.real(own.item.item_dir), 'runs') : '';
  if (!runsDir || !c.isInside(abs, runsDir) || c.same(abs, runsDir)) {
    deny(`test-runner writes only its report under <item>/runs/ (${runsDir || 'no bound item'}); ${abs} is outside. It never fixes anything.`);
    c.emit(findings);
  }
}

// Files changed on this branch vs the base branch, plus uncommitted/untracked changes.
function inDiff(worktree, rel) {
  const base = profiles.profileFor(worktree).base_branch;
  const changed = new Set();
  const mb =
    c.git(worktree, ['merge-base', 'HEAD', 'origin/' + base]) || c.git(worktree, ['merge-base', 'HEAD', base]);
  const add = (out) => (out || '').split(/\r?\n/).forEach((f) => f && changed.add(f));
  if (mb) add(c.git(worktree, ['diff', '--name-only', mb, 'HEAD']));
  add(c.git(worktree, ['diff', '--name-only', 'HEAD']));
  add(c.git(worktree, ['ls-files', '--others', '--exclude-standard']));
  for (const f of changed) if (c.same(f, rel)) return true;
  return false;
}

const fileDir = c.existingDir(abs);
const fileRepo = fileDir ? c.repoInfo(fileDir) : null;
const ignoredInRepo = () => (fileRepo ? c.isIgnored(fileRepo.toplevel, abs) : false);

// 2. Protected branches (main, master, develop, release/* by default) - in ANY repo, except git-ignored files.
if (fileRepo && c.branchProtected(fileRepo.branch) && !ignoredInRepo()) {
  deny(
    `${abs} is on protected branch '${fileRepo.branch}'. Code changes happen on a work-item branch (own worktree, or branch only). ` +
      'Run /dw:start <issue | description> (or /dw:resume <id>); it asks which you want, then edit there. ' +
      'Git-ignored files are not affected.'
  );
  c.emit(findings);
}

// 2a. Detached HEAD is neither protected nor an item branch (it can sit on the base branch): ask instead of silently allowing.
if (fileRepo && !fileRepo.branch && !ignoredInRepo() && !(fileDir && c.activeItem(fileDir))) {
  findings.push({
    decision: 'ask',
    reason: `[dw guard] ${abs} is in a repo with a detached HEAD (no branch), so the protected-branch rule cannot judge it. ` +
      'Approve only if you are resolving a rebase/cherry-pick; otherwise create the item branch first.',
  });
  c.emit(findings);
}

// 2b. plan.md: moving the phase from pre-approval to approved+ is gate 1 and goes through dw-state.js (which asks).
if (/(^|\/)plan\.md$/i.test(abs)) {
  const fs = require('fs');
  let current = '';
  try {
    current = fs.readFileSync(abs, 'utf8');
  } catch (_) {
    current = '';
  }
  const phaseOf = (text) => {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
    const m = fm && /^phase:\s*["']?([A-Za-z_-]+)/m.exec(fm[1]);
    return m ? m[1].toLowerCase() : null;
  };
  let next = current;
  if (typeof ti.content === 'string') next = ti.content;
  else if (typeof ti.old_string === 'string') next = current.split(ti.old_string).join(ti.new_string || '');
  const before = phaseOf(current);
  const after = phaseOf(next);
  // a missing file or missing phase counts as "not approved" (a fresh plan.md must start at phase: plan)
  if (c.isPreApproval(before) && !c.isPreApproval(after)) {
    deny(
      `Changing plan.md phase from '${before || 'none'}' to '${after}' by editing the file skips gate 1. ` +
        'Run `node <plugin>/scripts/dw-state.js set-phase approved` — it asks the user to approve the plan.'
    );
    c.emit(findings);
  }
}

// 3a. Session bound to an item (cwd in its worktree): never edit another work tree.
const activeCwd = c.activeItem(cwd);
if (activeCwd) {
  const cwdItemDir = activeCwd.item.item_dir ? c.real(activeCwd.item.item_dir) : '';
  const cwdTree = activeCwd.info.toplevel;
  if (cwdItemDir && c.isInside(abs, cwdItemDir)) process.exit(0);
  // a checkout bound to the same item (dw-state.js bind-repo) belongs to it; rules 2 and 3b still apply there
  const fileItem = fileRepo && fileDir ? c.activeItem(fileDir) : null;
  const sameItem = fileItem && String(fileItem.item.item_id) === String(activeCwd.item.item_id);
  if (fileRepo && !c.same(fileRepo.toplevel, cwdTree) && !sameItem && !ignoredInRepo()) {
    deny(
      `${abs} is outside this item's worktree (${cwdTree}). Each dw item edits only its own worktree, ` +
        'so parallel sessions never collide. Switch with /dw:resume <id> or open a new session for the other item. ' +
        'To edit a second repo for this same item, bind it first: node <plugin>/scripts/dw-state.js bind-repo <path>.'
    );
  }
}

// 3b. File inside an item's worktree (whatever the session cwd is): plan gate, test lock, test ownership.
const active = fileRepo && fileDir ? c.activeItem(fileDir) : null;
if (active && c.same(active.info.toplevel, fileRepo.toplevel)) {
  const itemDir = active.item.item_dir ? c.real(active.item.item_dir) : '';
  const worktree = active.info.toplevel;
  const rel = path.relative(worktree, abs).replace(/\\/g, '/');
  const phase = c.planPhase(itemDir);
  const inItemDir = itemDir && c.isInside(abs, itemDir);

  // fail closed: an item is bound to this worktree, so no readable phase means "not approved"
  if (!inItemDir && c.isPreApproval(phase)) {
    deny(
      phase
        ? `plan.md for ${c.itemRef(active.item)} is in phase '${phase}'. Code edits start only after you approve the plan ` +
            '(gate 1). Finish /dw:grill and the plan, approve it, and /dw:deliver moves the phase to approved.'
        : `${c.itemRef(active.item)} is bound to this worktree but ${itemDir || '<item folder>'}/plan.md is missing or has no ` +
            '`phase:` in its frontmatter, so plan approval (gate 1) cannot be confirmed. Write plan.md from the template ' +
            '(phase: plan) and get it approved before editing code.'
    );
  }

  const locked = active.locked.some((f) => c.same(f, rel));
  if (locked) {
    deny(
      `${rel} is a locked failing test (test-first mode). Make it pass by changing production code, not the test. ` +
        'If the test itself is wrong, stop and ask the user to run /dw:unlock-tests with a reason.'
    );
  }

  const isTest = c.matchesGlobs(rel, profiles.profileFor(worktree).test_globs);
  if (isTest && (agent === 'implementer' || agent === 'simplifier')) {
    deny(
      `${agent} may not edit test files (${rel}). Tests belong to test-author. ` +
        'Report the needed test change in your summary instead.'
    );
  }
  if (agent === 'simplifier' && !inDiff(worktree, rel)) {
    deny(
      `simplifier may only reshape files already in this item's diff; ${rel} is not changed on this branch. ` +
        'Leave unrelated files alone (no out-of-scope refactoring).'
    );
  }
  if (!isTest && agent === 'test-author') {
    deny(
      `test-author edits test files only; ${rel} is production code. ` +
        'Describe the production change needed in your summary for the implementer.'
    );
  }
}

c.emit(findings);
