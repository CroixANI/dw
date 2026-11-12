#!/usr/bin/env node
'use strict';
// SessionStart:
//  1. Port of name-session-from-worktree-branch.sh: in a linked worktree, title the session with the branch.
//     (Ported to node so Windows never picks up WSL's bash.exe instead of Git Bash.)
//  2. If the worktree has an active dw item, tell Claude where the run stands so /dw:resume is one step.
const path = require('path');
const c = require('./lib/common');
const profiles = require('./lib/profiles');

const input = c.readInput();
const cwd = input.cwd || process.cwd();
const out = { hookEventName: 'SessionStart' };

const gitDir = c.git(cwd, ['rev-parse', '--absolute-git-dir']);
const common = c.git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
const branch = c.git(cwd, ['branch', '--show-current']);
if (gitDir && common && !c.same(gitDir, common) && branch) out.sessionTitle = branch;

const active = c.activeItem(cwd);
if (active) {
  const it = active.item;
  const phase = c.planPhase(it.item_dir) || 'unknown';
  out.additionalContext =
    `dw: this worktree belongs to ${it.type || 'item'} ${c.itemRef(it)}. ` +
    `Item folder: ${it.item_dir}. plan.md phase: ${phase}. ` +
    `Locked test files: ${active.locked.length}. ` +
    (profiles.boundPaths(it).length
      ? `Also bound (same item): ${profiles.normalizeBound(it).map((b) => (b.branch ? `${b.path} (${b.branch})` : b.path)).join(', ')}. `
      : '') +
    (it.primary ? `Primary checkout of this item: ${it.primary}. ` : '') +
    `If the user wants to continue this item, run /dw:resume ${it.item_id}.`;
}

// In the main checkout: list items bound to other worktrees of this repo (so resume and the rules are known).
if (!active) {
  const items = [];
  for (const wt of c.worktrees(cwd)) {
    const it = c.itemAt(wt);
    if (it) items.push(`${c.itemRef(it)} (${c.planPhase(it.item_dir) || '?'}) in ${c.norm(wt)}`);
  }
  if (items.length) out.additionalContext = 'dw items in this repo: ' + items.join('; ') + '. Continue one with /dw:resume <id>.';
}
if (out.additionalContext) {
  out.additionalContext +=
    ' dw rules: locked tests and the files in <git-dir>/dw/ are controlled by the user; never edit, overwrite or delete them ' +
    'by any means (Edit, shell, scripts). Only the user lifts a lock, with /dw:unlock-tests <reason>.';
}

if (out.sessionTitle || out.additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }) + '\n');
}
process.exit(0);
