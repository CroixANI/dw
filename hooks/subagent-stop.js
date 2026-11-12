#!/usr/bin/env node
'use strict';
// SubagentStop: make "locked" hold against shell writes the PreToolUse guards cannot see (scripts, generators, git).
// If a locked test no longer matches the hash taken at lock time, the subagent is sent back once to report it.
// The commit gate (gate-bash.js) independently denies `git commit` while any locked test differs.
const c = require('./lib/common');

const input = c.readInput();
if (input.stop_hook_active) process.exit(0); // already sent back once; never loop
const changed = c.changedLocks(c.activeItem(input.cwd || process.cwd()));
if (!changed.length) process.exit(0);

process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason:
      `[dw test lock] Locked test file(s) changed during your run: ${changed.join(', ')}. Locked tests must not change. ` +
      'Do not try to restore or edit them yourself. Finish by adding "LOCKED TEST CHANGED: <files>" to your output ' +
      'contract (concerns / plan_deviations) so the user can decide; the commit stays blocked until they are restored ' +
      'or the user runs /dw:unlock-tests.',
  }) + '\n'
);
process.exit(0);
