#!/usr/bin/env node
'use strict';
// PreToolUse gate for GitHub MCP tools. hooks.json routes GitHub servers here (mcp__github__*, mcp__plugin_<x>_github__*);
// the server check below repeats that for safety (option github_mcp_servers).
// Rule: a known write verb -> ask; otherwise a known read verb -> allow; anything unrecognised -> ask.
// Issue / label / milestone / project tools are gate 4 (tracker write); everything else is gate 3 (code, PR, repo).
const c = require('./lib/common');

c.failSafe();
const input = c.readInput();
const name = String(input.tool_name || '');
const m = /^mcp__(.+?)__(.+)$/.exec(name);
if (!m) process.exit(0);
const server = m[1].toLowerCase();
const tool = m[2].toLowerCase();

// exact server name, or a plugin-scoped server ending in _<name> (no substring match)
const servers = c.listOption('github_mcp_servers').map((s) => s.toLowerCase());
if (!servers.some((s) => server === s || server.endsWith('_' + s))) process.exit(0);

// GitHub MCP tools are verb-first (get_issue, create_pull_request, request_copilot_review): judge the leading verb, so a
// read like get_pull_request_files is not mistaken for a write because a later word (request) is a verb too.
const tokens = tool.split(/[_\-]/);
const verb = tokens[0];
const READ = new Set(['get', 'list', 'search', 'query', 'read', 'show', 'download', 'me', 'fetch']);
const WRITE = new Set([
  'create', 'update', 'add', 'link', 'unlink', 'delete', 'remove', 'comment', 'reply', 'resolve',
  'set', 'close', 'reopen', 'assign', 'upload', 'push', 'merge', 'move', 'run', 'rerun', 'cancel',
  'edit', 'mark', 'publish', 'submit', 'request', 'dismiss', 'fork', 'transfer', 'lock', 'unlock',
  'reprioritize', 'write', 'dispatch', 'enable', 'disable',
]);
const isWrite = WRITE.has(verb);
const isRead = READ.has(verb);
const tracker = tokens.some((t) => /^(issue|issues|label|labels|milestone|milestones|project|projects|sub)$/.test(t));

if (isWrite || !isRead) {
  const gate = tracker ? 'gate 4 - tracker write' : 'gate 3 - GitHub write';
  const how = tracker
    ? 'GitHub issues are the source of truth; approve only if this issue change is intended.'
    : 'Approve only if this change on GitHub (PR, branch, repo, workflow) is intended.';
  c.decide('ask', `[dw ${gate}] ${m[2]} ${isWrite ? 'changes' : 'may change'} GitHub. ${how}`);
}
process.exit(0);
