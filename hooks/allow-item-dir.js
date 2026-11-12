#!/usr/bin/env node
'use strict';
// PreToolUse for Read | Grep | Glob | Edit | Write | NotebookEdit.
// The item folder (<repo family>-research/..., outside the main checkout) lies outside an item worktree. Claude Code
// treats paths outside the session's directories as needing permission, which blocks subagents (they cannot prompt).
// Pre-approve exactly the bound item's folder so everyone reads the single copy in place.
// Only an "allow": deny/ask from guard-edit.js and the permission rules still win.
const c = require('./lib/common');

const input = c.readInput();
const ti = input.tool_input || {};
const target = ti.file_path || ti.notebook_path || ti.path;
if (!target) process.exit(0);

const cwd = input.cwd || process.cwd();
const active = c.activeItem(cwd);
const itemDir = active && c.norm(active.item.item_dir || '');
if (!itemDir) process.exit(0);

if (c.isInside(c.resolveFrom(cwd, target), itemDir)) {
  c.decide('allow', `[dw] item folder of ${c.itemRef(active.item)}: ${itemDir}`);
}
process.exit(0);
