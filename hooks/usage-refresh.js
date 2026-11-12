#!/usr/bin/env node
'use strict';
// SessionEnd (also fires on /clear): refresh the usage stats of the dw item bound to this worktree.
// Spawns scripts/dw-usage.js detached and returns at once (a SessionEnd hook may be cut off quickly; the scan takes seconds).
// No item bound -> nothing to do. Opt out with plugin option usage_auto_refresh=false. Never blocks, never fails the session.
const path = require('path');
const { spawn } = require('child_process');
const c = require('./lib/common');

try {
  const input = c.readInput();
  const off = String(c.option('usage_auto_refresh') || 'true').toLowerCase() === 'false';
  const active = off ? null : c.activeItem(input.cwd || process.cwd());
  if (active && active.item.item_dir) {
    const script = path.join(__dirname, '..', 'scripts', 'dw-usage.js');
    const child = spawn(process.execPath, [script, 'refresh', '--id', String(active.item.item_id), '--item-dir', active.item.item_dir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  }
} catch (_) {
  /* never break session end */
}
process.exit(0);
