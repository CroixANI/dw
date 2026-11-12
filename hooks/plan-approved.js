#!/usr/bin/env node
'use strict';
// PostToolUse(ExitPlanMode): the user just approved the plan in plan mode. That approval IS gate 1, so record it
// in <git-dir>/dw/plan-approval.json; `dw-state.js set-phase approved` then does not ask a second time.
// PostToolUse only fires when the tool succeeded, i.e. the user approved. No bound item here -> nothing to record.
const fs = require('fs');
const path = require('path');
const c = require('./lib/common');

const input = c.readInput();
const active = c.activeItem(input.cwd || process.cwd());
if (!active) process.exit(0);

const plan = String((input.tool_input && input.tool_input.plan) || (input.tool_response && input.tool_response.plan) || '');
fs.mkdirSync(active.dir, { recursive: true });
fs.writeFileSync(
  path.join(active.dir, 'plan-approval.json'),
  JSON.stringify({ at: new Date().toISOString(), plan_sha256: c.planSha(plan) }, null, 2)
);
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `dw: plan approval for ${c.itemRef(active.item)} recorded (gate 1). Write plan.md as the template frontmatter ` +
        '(`phase: plan`) followed by exactly the approved plan text, then run `dw-state.js set-phase approved`. ' +
        'It does not ask again only if plan.md matches the approved plan (whitespace aside).',
    },
  }) + '\n'
);
process.exit(0);
