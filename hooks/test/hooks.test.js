'use strict';
// Unit tests for dw hooks: feed sample PreToolUse JSON on stdin, assert allow / deny / ask.
// Run: node --test hooks/test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

// When run from a git hook (pre-commit), git exports GIT_DIR, GIT_INDEX_FILE ... which would redirect every
// git call in the fixture (and in the hooks under test) to the plugin's own repo. Start from a clean git env.
for (const k of Object.keys(process.env)) if (/^GIT_/.test(k)) delete process.env[k];

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = (n) => path.join(ROOT, 'hooks', n);
const STATE = path.join(ROOT, 'scripts', 'dw-state.js');

function run(hook, input, env = {}) {
  const r = spawnSync('node', [HOOK(hook)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.strictEqual(r.status, 0, 'hook exit code: ' + r.stderr);
  if (!r.stdout.trim()) return { decision: 'none', reason: '' };
  const o = JSON.parse(r.stdout);
  const h = o.hookSpecificOutput || {};
  return { decision: h.permissionDecision || 'none', reason: h.permissionDecisionReason || '', raw: h };
}

function g(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// ---------- fixture: main checkout on main + item worktree on a feature branch ----------
// .native expands Windows 8.3 short names (os.tmpdir() may be C:\Users\LONGNA~1\...), which git never reports
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-hooks-')));
const main = path.join(tmp, 'shop');
const wt = path.join(main, '.claude', 'worktrees', '123');
const research = path.join(tmp, 'shop-research');
const itemDir = path.join(research, '123-null-ref');
const otherWt = path.join(tmp, 'other-wt');

test.before(() => {
  fs.mkdirSync(main, { recursive: true });
  g(main, 'init', '-q', '-b', 'main');
  g(main, 'config', 'core.autocrlf', 'false'); // the machine's autocrlf=true would hand the CRLF tests a CRLF checkout
  g(main, 'config', 'user.email', 'dev@example.com');
  g(main, 'config', 'user.name', 'Dev');
  fs.writeFileSync(path.join(main, '.gitignore'), 'notes/\n.claude/worktrees/\n');
  fs.writeFileSync(path.join(main, 'Shop.sln'), '\n');
  fs.mkdirSync(path.join(main, 'Services', 'Foo', 'Shop.Foo.Tests'), { recursive: true });
  fs.mkdirSync(path.join(main, 'Services', 'Foo', 'Shop.Foo.Testing'), { recursive: true });
  fs.writeFileSync(path.join(main, 'Services', 'Foo', 'Engine.cs'), 'class A {}\n');
  fs.writeFileSync(path.join(main, 'Services', 'Foo', 'Shop.Foo.Tests', 'EngineTests.cs'), 'class T {}\n');
  fs.writeFileSync(path.join(main, 'Services', 'Foo', 'Shop.Foo.Testing', 'FakeEngine.cs'), 'class F {}\n');
  g(main, 'add', '.');
  g(main, 'commit', '-q', '-m', 'init');
  g(main, 'worktree', 'add', '-q', '-b', 'feature/123-null-ref', wt);
  g(main, 'worktree', 'add', '-q', '-b', 'feature/456-other', otherWt);
  fs.mkdirSync(itemDir, { recursive: true });
  fs.writeFileSync(
    path.join(itemDir, 'plan.md'),
    '---\nitem_id: 123\ntype: Bug\nphase: plan\ntest_mode: test-first\nfix_cycles: 0\n---\n# Plan: null ref\n'
  );
  execFileSync('node', [STATE, 'init', '--id', '123', '--type', 'bug', '--item-dir', itemDir], { cwd: wt });
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const edit = (cwd, file, agent) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  cwd,
  tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
  ...(agent ? { agent_id: 'x', agent_type: agent } : {}),
});
const bash = (command, agent, cwd = wt, tool = 'Bash') => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  cwd,
  tool_input: { command },
  ...(agent ? { agent_id: 'x', agent_type: agent } : {}),
});
const setPhase = (p) =>
  fs.writeFileSync(
    path.join(itemDir, 'plan.md'),
    fs.readFileSync(path.join(itemDir, 'plan.md'), 'utf8').replace(/^phase: .*$/m, 'phase: ' + p)
  );

// ---------- allow-item-dir ----------
test('allow-item-dir: reading the item folder from the worktree is allowed', () => {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: wt, tool_input: { file_path: path.join(itemDir, 'plan.md') } };
  assert.strictEqual(run('allow-item-dir.js', input).decision, 'allow');
});

test('allow-item-dir: code in the main checkout gets no opinion', () => {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: wt, tool_input: { file_path: path.join(main, 'Services/Foo/Engine.cs') } };
  assert.strictEqual(run('allow-item-dir.js', input).decision, 'none');
});

test('allow-item-dir: another item folder gets no opinion', () => {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Glob', cwd: wt, tool_input: { path: path.join(research, '999-x') } };
  assert.strictEqual(run('allow-item-dir.js', input).decision, 'none');
});

test('dw-state init: a checkout already bound to another item is refused', () => {
  const r = spawnSync('node', [STATE, 'init', '--id', '999', '--type', 'bug', '--item-dir', itemDir], { cwd: wt, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /already bound to #123/);
});

// ---------- guard-edit ----------
test('edit: tracked file on main is denied', () => {
  const r = run('guard-edit.js', edit(main, path.join(main, 'Services/Foo/Engine.cs')));
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /protected branch 'main'/);
  assert.match(r.reason, /\/dw:start/);
});

test('edit: git-ignored file on main is allowed', () => {
  const r = run('guard-edit.js', edit(main, path.join(main, 'notes', 'todo.md')));
  assert.strictEqual(r.decision, 'none');
});

test('edit: protected list comes from plugin option', () => {
  const r = run('guard-edit.js', edit(main, path.join(main, 'Services/Foo/Engine.cs')), {
    CLAUDE_PLUGIN_OPTION_PROTECTED_BRANCHES: 'release/*',
  });
  assert.strictEqual(r.decision, 'none');
});

test('edit: file outside any repo is allowed', () => {
  const r = run('guard-edit.js', edit(tmp, path.join(tmp, 'scratch.txt')));
  assert.strictEqual(r.decision, 'none');
});

test('edit: inside .git (dw state) is denied', () => {
  const gd = g(wt, 'rev-parse', '--absolute-git-dir');
  const r = run('guard-edit.js', edit(wt, path.join(gd, 'dw', 'tests-locked.json')));
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /inside \.git/);
});

test('edit: worktree code before plan approval is denied (gate 1)', () => {
  setPhase('plan');
  const r = run('guard-edit.js', edit(wt, path.join(wt, 'Services/Foo/Engine.cs')));
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /phase 'plan'/);
});

test('edit: item folder is writable in any phase', () => {
  setPhase('plan');
  const r = run('guard-edit.js', edit(wt, path.join(itemDir, 'plan.md')));
  assert.strictEqual(r.decision, 'none');
});

test('edit: worktree code after approval is allowed for implementer', () => {
  setPhase('implement');
  const r = run('guard-edit.js', edit(wt, path.join(wt, 'Services/Foo/Engine.cs'), 'dw:implementer'));
  assert.strictEqual(r.decision, 'none');
});

test('edit: other worktree is denied while an item is active', () => {
  setPhase('implement');
  const r = run('guard-edit.js', edit(wt, path.join(otherWt, 'Services/Foo/Engine.cs')));
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /outside this item's worktree/);
});

test('edit: main checkout tracked file from item session is denied', () => {
  setPhase('implement');
  const r = run('guard-edit.js', edit(wt, path.join(main, 'Services/Foo/Engine.cs')));
  assert.strictEqual(r.decision, 'deny');
});

test('edit: implementer may not touch tests', () => {
  setPhase('implement');
  const f = path.join(wt, 'Services/Foo/Shop.Foo.Tests/EngineTests.cs');
  const r = run('guard-edit.js', edit(wt, f, 'dw:implementer'));
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /test-author/);
});

test('edit: *.Testing fakes library is not a test file', () => {
  setPhase('implement');
  const f = path.join(wt, 'Services/Foo/Shop.Foo.Testing/FakeEngine.cs');
  assert.strictEqual(run('guard-edit.js', edit(wt, f, 'dw:implementer')).decision, 'none');
});

test('edit: simplifier may not touch tests (bare agent name too)', () => {
  setPhase('simplify');
  const f = path.join(wt, 'Services/Foo/Shop.Foo.Tests/EngineTests.cs');
  assert.strictEqual(run('guard-edit.js', edit(wt, f, 'simplifier')).decision, 'deny');
});

test('edit: test-author may edit tests but not production code', () => {
  setPhase('tests');
  const t = path.join(wt, 'Services/Foo/Shop.Foo.Tests/EngineTests.cs');
  assert.strictEqual(run('guard-edit.js', edit(wt, t, 'dw:test-author')).decision, 'none');
  const p = path.join(wt, 'Services/Foo/Engine.cs');
  assert.strictEqual(run('guard-edit.js', edit(wt, p, 'dw:test-author')).decision, 'deny');
});

test('edit: locked test is denied for everyone, incl. main session and test-author', () => {
  setPhase('implement');
  const t = path.join(wt, 'Services/Foo/Shop.Foo.Tests/EngineTests.cs');
  execFileSync('node', [STATE, 'lock-tests', t], { cwd: wt });
  try {
    assert.strictEqual(run('guard-edit.js', edit(wt, t)).decision, 'deny');
    const r = run('guard-edit.js', edit(wt, t, 'dw:test-author'));
    assert.strictEqual(r.decision, 'deny');
    assert.match(r.reason, /\/dw:unlock-tests/);
  } finally {
    execFileSync('node', [STATE, 'unlock-tests', '--reason', 'test cleanup'], { cwd: wt });
  }
  assert.match(fs.readFileSync(path.join(itemDir, 'plan.md'), 'utf8'), /test lock removed .*test cleanup/);
});

test('edit: NotebookEdit path is guarded too', () => {
  const r = run('guard-edit.js', {
    tool_name: 'NotebookEdit',
    cwd: main,
    tool_input: { notebook_path: path.join(main, 'Services/Foo/x.ipynb') },
  });
  assert.strictEqual(r.decision, 'deny');
});

// ---------- gate-bash ----------
const cases = [
  // [command, expected decision, reason regex, agent]
  ['git status', 'none'],
  ['git log --grep commit', 'none'],
  ['git diff main...HEAD --stat', 'none'],
  ['git commit -m "#123 Fix null ref"', 'ask', /gate 2/],
  ['git -c core.hooksPath=x commit --amend --no-edit', 'ask', /gate 2/],
  ['git add -A ; git commit -m "x; git push later"', 'ask', /gate 2/],
  ['git cherry-pick abc123', 'ask', /gate 2/],
  ['git cherry-pick --abort', 'none'],
  ['git push -u origin feature/123-x', 'ask', /gate 3/],
  ['git pull --ff-only', 'none'],
  ['gh pr create --repo github.com/acme/shop --base main --title "#123 x" --body-file pr-body.md', 'ask', /gate 3/],
  ['gh pr view 12 --json url,state --jq .url', 'none'],
  ['gh pr checks 12', 'none'],
  ['gh pr merge 12 --squash --auto', 'ask', /gate 3/],
  ['gh stack submit', 'ask', /gate 3/],
  ['gh stack view --json', 'none'],
  ['gh api repos/acme/shop/pulls/12/comments --jq ".[].body"', 'none'],
  ['gh api graphql -f query="query { viewer { login } }"', 'none'],
  ['gh api graphql -f query="mutation { resolveReviewThread(input:{threadId:\\"x\\"}) { thread { id } } }"', 'ask', /gate 3/],
  ['gh api --hostname github.com -X POST repos/acme/shop/actions/runs/1/rerun-failed-jobs', 'ask', /gate 3/],
  ['gh api repos/o/r/issues/1/labels -f labels[]=x', 'ask', /gate 4/],
  ['gh api repos/o/r/issues/1/sub_issues -X POST -F sub_issue_id=5', 'ask', /gate 4/],
  ['gh api repos/o/r/issues/1 --jq .body', 'none'],
  ['gh api repos/o/r/pulls/1/reviews -X POST -f event=COMMENT', 'ask', /gate 3/],
  ['gh api graphql -f query="mutation { addSubIssue(input:{issueId:\\"a\\", subIssueId:\\"b\\"}) { issue { id } } }"', 'ask', /gate 4/],
  ['gh label create ai-claude', 'ask', /gate 4/],
  ['gh issue view 42 --json title,body,labels', 'none'],
  ['gh issue list --label bug', 'none'],
  ['gh issue create --title "x" --body-file b.md', 'ask', /gate 4/],
  ['gh issue comment 42 --body "done"', 'ask', /gate 4/],
  ['gh issue edit 42 --add-label bug', 'ask', /gate 4/],
  ['gh issue close 42', 'ask', /gate 4/],
  ['gh project item-edit --id x --field-id y --text z', 'ask', /gate 4/],
  ['gh release create v1.0.0', 'ask', /gate 3/],
  ['curl -s -H "Authorization: Bearer x" https://api.github.com/repos/o/r/issues/1 -o a.json', 'none'],
  ['curl -X PATCH -d @b.json https://api.github.com/repos/o/r/issues/1', 'ask', /gate 4/],
  ['curl -XPOST https://api.github.com/repos/o/r/pulls', 'ask', /gate 3/],
  ['git reset --hard origin/main', 'ask', /discard/],
  ['git restore --staged file.cs', 'none'],
  ['git restore file.cs', 'ask', /discard/],
  ['git clean -fd', 'ask', /discard/],
  ['git stash drop', 'ask', /discard/],
  ['git branch -D feature/x', 'ask', /discard/],
  ['node "C:/x/scripts/dw-state.js" unlock-tests --reason "wrong expectation"', 'ask', /test lock/],
  ['node "C:/x/scripts/dw-state.js" set-phase approved', 'ask', /gate 1/],
  ['dotnet build Services/Foo/Foo.sln', 'none', null, 'dw:implementer'],
  ['dotnet test Services/Foo/Shop.Foo.Tests --filter "Category=Unit"', 'deny', /may not run tests/, 'dw:implementer'],
  ['dotnet.exe test x.csproj', 'deny', /may not run tests/, 'dw:simplifier'],
  ['dotnet test Services/Foo/Shop.Foo.Tests --filter "Category=Unit"', 'none', null, 'dw:test-runner'],
  ['dotnet test x.csproj', 'none', null, undefined],
  ['git commit -m x', 'ask', /gate 2/, 'some-other-agent'],
  // discard guard: more history-rewriting / work-discarding commands
  ['git pull', 'ask', /gate 2/],
  ['git pull origin main', 'ask', /gate 2/],
  ['git pull --rebase', 'ask', /discard/],
  ['git rebase origin/main', 'ask', /discard/],
  ['git rebase --continue', 'none'],
  ['git rebase --abort', 'none'],
  ['git worktree remove --force .claude/worktrees/123', 'ask', /discard/],
  ['git worktree remove -f x', 'ask', /discard/],
  ['git worktree list --porcelain', 'none'],
  ['git switch --discard-changes feature/x', 'ask', /discard/],
  ['git switch -f feature/x', 'ask', /discard/],
  ['git checkout -f feature/x', 'ask', /discard/],
  ['git switch feature/x', 'none'],
  // wrapped commands: look inside -c / -Command strings
  ['pwsh -NoProfile -Command "git push origin feature/x"', 'ask', /gate 3/],
  ["bash -c 'git commit -m x'", 'ask', /gate 2/],
  ['powershell.exe -NoProfile -c "& { git commit -m x }"', 'ask', /gate 2/],
  ['cmd /c "git push"', 'ask', /gate 3/],
  ['eval "git push origin x"', 'ask', /gate 3/],
  ['sh -c "echo hi"', 'none'],
  ['pwsh -NoProfile -File "C:/Views/shop/scripts/setup.ps1"', 'none'],
  ['pwsh -NoProfile -EncodedCommand ' + Buffer.from('git push origin x', 'utf16le').toString('base64'), 'ask', /gate 3/],
  ['bash -c "dotnet test x.csproj"', 'deny', /may not run tests/, 'dw:implementer'],
  // dw-state clear switches off every per-item guard
  ['node "C:/x/scripts/dw-state.js" clear', 'ask', /clear/],
  // stack-agnostic: the fallback knows common runners even without a preset
  ['npm test', 'deny', /may not run tests/, 'dw:implementer'],
  ['pnpm run test -- calc', 'deny', /may not run tests/, 'dw:implementer'],
  ['npx vitest run', 'deny', /may not run tests/, 'dw:simplifier'],
  ['node --test test/calc.test.js', 'deny', /may not run tests/, 'dw:implementer'],
  ['pytest -q tests/test_x.py', 'deny', /may not run tests/, 'dw:implementer'],
  ['python -m pytest', 'deny', /may not run tests/, 'dw:implementer'],
  ['cargo test', 'deny', /may not run tests/, 'dw:implementer'],
  ['go test ./...', 'deny', /may not run tests/, 'dw:implementer'],
  ['npm run build', 'none', null, 'dw:implementer'],
  ['cargo build', 'none', null, 'dw:implementer'],
];

for (const [cmd, want, re, agent] of cases) {
  test(`bash: ${want.padEnd(4)} ${agent ? '[' + agent + '] ' : ''}${cmd}`, () => {
    const r = run('gate-bash.js', bash(cmd, agent));
    assert.strictEqual(r.decision, want, r.reason);
    if (re) assert.match(r.reason, re);
  });
}

test('bash: deny beats ask when one command does both', () => {
  const r = run('gate-bash.js', bash('dotnet test x.csproj ; git commit -m y', 'dw:implementer'));
  assert.strictEqual(r.decision, 'deny');
});

test('powershell tool: Invoke-RestMethod PATCH to a GitHub issue asks (gate 4)', () => {
  const r = run(
    'gate-bash.js',
    bash('Invoke-RestMethod -Method Patch -Uri "https://api.github.com/repos/o/r/issues/1" -Body $b', undefined, wt, 'PowerShell')
  );
  assert.strictEqual(r.decision, 'ask');
  assert.match(r.reason, /gate 4/);
});

test('powershell tool: git commit asks', () => {
  assert.strictEqual(run('gate-bash.js', bash('git commit -m "x"', undefined, wt, 'PowerShell')).decision, 'ask');
});

test('bash: the implementer deny names the build command of the repo profile', () => {
  const r = run('gate-bash.js', bash('dotnet test x.csproj', 'dw:implementer'));
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /dotnet build/);
});

// ---------- gate-mcp ----------
const mcp = [
  // [tool, decision, gate]
  ['mcp__github__get_issue', 'none'],
  ['mcp__github__list_issues', 'none'],
  ['mcp__github__search_code', 'none'],
  ['mcp__github__get_pull_request_files', 'none'],
  ['mcp__github__get_me', 'none'],
  ['mcp__github__create_issue', 'ask', /gate 4/],
  ['mcp__github__update_issue', 'ask', /gate 4/],
  ['mcp__github__add_issue_comment', 'ask', /gate 4/],
  ['mcp__github__add_sub_issue', 'ask', /gate 4/],
  ['mcp__github__create_pull_request', 'ask', /gate 3/],
  ['mcp__github__merge_pull_request', 'ask', /gate 3/],
  ['mcp__github__push_files', 'ask', /gate 3/],
  ['mcp__github__request_copilot_review', 'ask', /gate 3/],
  ['mcp__github__get_pull_request_review_comments', 'none'],
  ['mcp__github__frobnicate_things', 'ask', /gate 3/],
  ['mcp__plugin_x_github__create_issue', 'ask', /gate 4/],
  ['mcp__memory__memory_write', 'none'],
  ['mcp__githubber__create_issue', 'none'],
  ['mcp__claude_ai_Figma__create_new_file', 'none'],
];
for (const [tool, want, re] of mcp) {
  test(`mcp: ${want.padEnd(4)} ${tool}`, () => {
    const r = run('gate-mcp.js', { hook_event_name: 'PreToolUse', tool_name: tool, cwd: wt, tool_input: {} });
    assert.strictEqual(r.decision, want, r.reason);
    if (re) assert.match(r.reason, re);
  });
}

// ---------- session-start ----------
test('session-start: worktree gets branch title and dw context', () => {
  setPhase('implement');
  const r = spawnSync('node', [HOOK('session-start.js')], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: wt, source: 'startup' }),
    encoding: 'utf8',
  });
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.strictEqual(o.sessionTitle, 'feature/123-null-ref');
  assert.match(o.additionalContext, /#123/);
  assert.match(o.additionalContext, /phase: implement/);
  assert.match(o.additionalContext, /\/dw:resume 123/);
});

// ---------- dw-state ----------
test('dw-state: shop.web checkout shares the shop-research root', () => {
  const ui = path.join(tmp, 'shop.web');
  fs.mkdirSync(ui, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: ui });
  const out = JSON.parse(
    execFileSync('node', [STATE, 'item-path', '--id', '4242', '--title', 'ui thing'], { cwd: ui, encoding: 'utf8' })
  );
  assert.ok(out.item_dir.endsWith('/shop-research/4242-ui-thing'), out.item_dir);
});

test('dw-state: find locates the item worktree from the main checkout', () => {
  const out = JSON.parse(execFileSync('node', [STATE, 'find', '--id', '123'], { cwd: main, encoding: 'utf8' }));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].item_id, '123');
});

test('dw-state: init refuses a protected branch', () => {
  const r = spawnSync('node', [STATE, 'init', '--id', '9', '--item-dir', itemDir], { cwd: main, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /protected branch/);
});

test('dw-state: set-phase and bump-fix-cycles edit plan.md frontmatter', () => {
  execFileSync('node', [STATE, 'set-phase', 'verify'], { cwd: wt });
  const n = JSON.parse(execFileSync('node', [STATE, 'bump-fix-cycles'], { cwd: wt, encoding: 'utf8' }));
  assert.strictEqual(n.fix_cycles, 1);
  const text = fs.readFileSync(path.join(itemDir, 'plan.md'), 'utf8');
  assert.match(text, /^phase: verify$/m);
  assert.match(text, /^fix_cycles: 1$/m);
});

test('edit: simplifier may only touch files already in the diff', () => {
  setPhase('simplify');
  const f = path.join(wt, 'Services/Foo/Engine.cs');
  assert.strictEqual(run('guard-edit.js', edit(wt, f, 'dw:simplifier')).decision, 'deny');
  fs.appendFileSync(f, '// changed by implementer\n');
  try {
    assert.strictEqual(run('guard-edit.js', edit(wt, f, 'dw:simplifier')).decision, 'none');
  } finally {
    g(wt, 'checkout', '--', 'Services/Foo/Engine.cs');
  }
});

test('dw-state: item-path builds <ID>-<slug> under <main>-research (outside the checkout) and reuses it', () => {
  const one = JSON.parse(
    execFileSync('node', [STATE, 'item-path', '--type', 'feature', '--id', '777', '--title', '#777 - Add Queue Overflow Handling!'], { cwd: wt, encoding: 'utf8' })
  );
  assert.ok(one.item_dir.endsWith('/shop-research/777-add-queue-overflow-handling'), one.item_dir);
  assert.ok(!require('../lib/common').isInside(one.item_dir, main), 'item folder must be outside the main checkout');
  const two = JSON.parse(
    execFileSync('node', [STATE, 'item-path', '--type', 'feature', '--id', '777', '--title', 'Renamed'], { cwd: main, encoding: 'utf8' })
  );
  assert.strictEqual(two.item_dir, one.item_dir);
  assert.strictEqual(two.existed, true);
  // --slug (short description from the caller) wins over the title and is sanitized
  const slugged = JSON.parse(
    execFileSync('node', [STATE, 'item-path', '--id', '779', '--title', '[api] A very long and noisy issue title that goes on', '--slug', 'Outbound KPI: direction POST!'], { cwd: main, encoding: 'utf8' })
  );
  assert.ok(slugged.item_dir.endsWith('/shop-research/779-outbound-kpi-direction-post'), slugged.item_dir);
  // '#42' is accepted as an id; local items count up per research root
  const hashed = JSON.parse(execFileSync('node', [STATE, 'item-path', '--id', '#780', '--title', 'Hash id'], { cwd: main, encoding: 'utf8' }));
  assert.ok(hashed.item_dir.endsWith('/shop-research/780-hash-id'), hashed.item_dir);
  const n1 = JSON.parse(execFileSync('node', [STATE, 'next-local-id'], { cwd: main, encoding: 'utf8' }));
  assert.strictEqual(n1.id, 'local-1');
  const loc = JSON.parse(execFileSync('node', [STATE, 'item-path', '--id', n1.id, '--title', 'Add dark mode'], { cwd: main, encoding: 'utf8' }));
  assert.ok(loc.item_dir.endsWith('/shop-research/local-1-add-dark-mode'), loc.item_dir);
  assert.strictEqual(JSON.parse(execFileSync('node', [STATE, 'next-local-id'], { cwd: main, encoding: 'utf8' })).id, 'local-2');
  // 'local-1' does not match 'local-10' and '78' does not match '780'
  const n78 = JSON.parse(execFileSync('node', [STATE, 'item-path', '--id', '78', '--title', 'Short'], { cwd: main, encoding: 'utf8' }));
  assert.strictEqual(n78.existed, false);
});

test('bash: shell writes to a locked test are denied, even from the main checkout', () => {
  const t = path.join(wt, 'Services/Foo/Shop.Foo.Tests/EngineTests.cs');
  execFileSync('node', [STATE, 'lock-tests', t], { cwd: wt });
  try {
    const heredoc = "cd .claude/worktrees/123 && cat > Services/Foo/Shop.Foo.Tests/EngineTests.cs <<'EOF'\nclass T {}\nEOF";
    let r = run('gate-bash.js', bash(heredoc, undefined, main));
    assert.strictEqual(r.decision, 'deny');
    assert.match(r.reason, /locked test/);
    r = run('gate-bash.js', bash("sed -i 's/x/y/' Services/Foo/Shop.Foo.Tests/EngineTests.cs", 'dw:test-author'));
    assert.strictEqual(r.decision, 'deny');
    r = run('gate-bash.js', bash('Set-Content -Path Services/Foo/Shop.Foo.Tests/EngineTests.cs -Value x', undefined, wt, 'PowerShell'));
    assert.strictEqual(r.decision, 'deny');
    // reading is fine
    assert.strictEqual(run('gate-bash.js', bash('cat Services/Foo/Shop.Foo.Tests/EngineTests.cs')).decision, 'none');
    assert.strictEqual(run('gate-bash.js', bash('git diff main -- Services/Foo/Shop.Foo.Tests/EngineTests.cs')).decision, 'none');
  } finally {
    execFileSync('node', [STATE, 'unlock-tests', '--reason', 'cleanup'], { cwd: wt });
  }
});

test('bash: implementer may not write test files via the shell', () => {
  const r = run('gate-bash.js', bash('cp /tmp/x.cs Services/Foo/Shop.Foo.Tests/NewTests.cs', 'dw:implementer'));
  assert.strictEqual(r.decision, 'deny');
  assert.strictEqual(run('gate-bash.js', bash('cp /tmp/x.cs Services/Foo/Engine2.cs', 'dw:implementer')).decision, 'none');
  assert.strictEqual(run('gate-bash.js', bash('dotnet build Services/Foo/Foo.csproj 2>&1', 'dw:implementer')).decision, 'none');
});

test('edit: locked test is denied even when the session cwd is the main checkout', () => {
  setPhase('implement');
  const t = path.join(wt, 'Services/Foo/Shop.Foo.Tests/EngineTests.cs');
  execFileSync('node', [STATE, 'lock-tests', t], { cwd: wt });
  try {
    const r = run('guard-edit.js', edit(main, t));
    assert.strictEqual(r.decision, 'deny');
    assert.match(r.reason, /locked failing test/);
  } finally {
    execFileSync('node', [STATE, 'unlock-tests', '--reason', 'cleanup'], { cwd: wt });
  }
});

test('edit: plan gate applies to worktree files edited from the main checkout session', () => {
  setPhase('plan');
  const r = run('guard-edit.js', edit(main, path.join(wt, 'Services/Foo/Engine.cs')));
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /phase 'plan'/);
});

test('bash: shell writes to dw state files are denied', () => {
  const gd = g(wt, 'rev-parse', '--absolute-git-dir');
  let r = run('gate-bash.js', bash(`echo '{"files":[]}' > ${gd}/dw/tests-locked.json`, undefined, main));
  assert.strictEqual(r.decision, 'deny');
  r = run('gate-bash.js', bash(`rm ${gd}/dw/item.json`));
  assert.strictEqual(r.decision, 'deny');
  assert.strictEqual(run('gate-bash.js', bash(`cat ${gd}/dw/tests-locked.json`)).decision, 'none');
});

test('edit: plan.md phase plan -> approved by Edit is denied (gate 1 bypass)', () => {
  setPhase('plan');
  const p = path.join(itemDir, 'plan.md');
  let r = run('guard-edit.js', { tool_name: 'Edit', cwd: wt, tool_input: { file_path: p, old_string: 'phase: plan', new_string: 'phase: approved' } });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /skips gate 1/);
  r = run('guard-edit.js', { tool_name: 'Edit', cwd: wt, tool_input: { file_path: p, old_string: '# Plan: null ref', new_string: '# Plan: null ref fix' } });
  assert.strictEqual(r.decision, 'none');
  setPhase('implement');
  r = run('guard-edit.js', { tool_name: 'Edit', cwd: wt, tool_input: { file_path: p, old_string: 'phase: implement', new_string: 'phase: verify' } });
  assert.strictEqual(r.decision, 'none');
});

test('session-start: main checkout lists bound items and the lock rule', () => {
  setPhase('implement');
  const r = spawnSync('node', [HOOK('session-start.js')], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: main }),
    encoding: 'utf8',
  });
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.match(o.additionalContext, /#123 \(implement\)/);
  assert.match(o.additionalContext, /never edit, overwrite or delete/);
});

// =====================================================================
// Review fixes (2026-10). Written first, run once red, then implemented.
// =====================================================================
const PLAN = path.join(itemDir, 'plan.md');
const ENGINE = path.join(wt, 'Services/Foo/Engine.cs');
const LOCKED_REL = 'Services/Foo/Shop.Foo.Tests/EngineTests.cs';
const LOCKED = path.join(wt, LOCKED_REL);
const stateRun = (args, cwd = wt) => spawnSync('node', [STATE, ...args], { cwd, encoding: 'utf8' });
const stateDirOf = (cwd) => path.join(g(cwd, 'rev-parse', '--absolute-git-dir'), 'dw');
const withPlan = (text, fn) => {
  const saved = fs.readFileSync(PLAN, 'utf8');
  try {
    if (text === null) fs.renameSync(PLAN, PLAN + '.bak');
    else fs.writeFileSync(PLAN, text);
    fn();
  } finally {
    if (text === null) fs.renameSync(PLAN + '.bak', PLAN);
    fs.writeFileSync(PLAN, saved);
  }
};
const lock = () => execFileSync('node', [STATE, 'lock-tests', LOCKED], { cwd: wt });
const unlock = () => stateRun(['unlock-tests', '--reason', 'cleanup']);

// ---------- gate 1: plan approval cannot be skipped ----------
test('gate 1: set-phase straight from plan to implement asks', () => {
  setPhase('plan');
  const r = run('gate-bash.js', bash('node "C:/x/scripts/dw-state.js" set-phase implement'));
  assert.strictEqual(r.decision, 'ask');
  assert.match(r.reason, /gate 1/);
});

test('gate 1: set-phase between post-approval phases does not ask', () => {
  setPhase('tests');
  assert.strictEqual(run('gate-bash.js', bash('node "C:/x/scripts/dw-state.js" set-phase implement')).decision, 'none');
});

test('gate 1: set-phase to a later phase with no readable current phase asks', () => {
  withPlan(null, () => {
    assert.strictEqual(run('gate-bash.js', bash('node "C:/x/scripts/dw-state.js" set-phase review')).decision, 'ask');
  });
});

test('dw-state: set-phase refuses to jump from a pre-approval phase past approved', () => {
  setPhase('plan');
  const r = stateRun(['set-phase', 'implement']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /approved/);
  assert.match(fs.readFileSync(PLAN, 'utf8'), /^phase: plan$/m);
});

test('dw-state: set-phase plan -> approved is allowed by the script (the hook asks)', () => {
  setPhase('plan');
  const r = stateRun(['set-phase', 'approved']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(PLAN, 'utf8'), /^phase: approved$/m);
  setPhase('implement');
});

test('gate 1: one approval - ExitPlanMode approval is recorded and set-phase approved then does not ask again', () => {
  setPhase('plan');
  fs.writeFileSync(PLAN, '---\nitem_id: 123\ntype: Bug\nphase: plan\ntest_mode: test-first\nfix_cycles: 0\n---\n# Plan: null ref\n');
  const post = spawnSync('node', [HOOK('plan-approved.js')], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', cwd: wt, tool_input: { plan: '# Plan: null ref' }, tool_response: {} }),
    encoding: 'utf8',
  });
  assert.strictEqual(post.status, 0, post.stderr);
  assert.ok(fs.existsSync(path.join(stateDirOf(wt), 'plan-approval.json')), 'approval recorded');
  assert.strictEqual(run('gate-bash.js', bash('node "C:/x/scripts/dw-state.js" set-phase approved')).decision, 'none');
  // the script consumes the record so a later re-approval asks again
  assert.strictEqual(stateRun(['set-phase', 'approved']).status, 0);
  assert.ok(!fs.existsSync(path.join(stateDirOf(wt), 'plan-approval.json')), 'record consumed');
  setPhase('plan');
  assert.strictEqual(run('gate-bash.js', bash('node "C:/x/scripts/dw-state.js" set-phase approved')).decision, 'ask');
  setPhase('implement');
});

test('gate 1: ExitPlanMode outside a bound worktree records nothing', () => {
  const post = spawnSync('node', [HOOK('plan-approved.js')], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', cwd: main, tool_input: { plan: 'x' } }),
    encoding: 'utf8',
  });
  assert.strictEqual(post.status, 0);
  assert.ok(!fs.existsSync(path.join(stateDirOf(main), 'plan-approval.json')));
});

test('bash: shell writes to the approval record are denied', () => {
  const r = run('gate-bash.js', bash(`echo {} > ${stateDirOf(wt)}/plan-approval.json`));
  assert.strictEqual(r.decision, 'deny');
});

test('bash: node -e writes to dw state are denied', () => {
  const r = run('gate-bash.js', bash(`node -e "require('fs').writeFileSync('${stateDirOf(wt)}/tests-locked.json','{}')"`));
  assert.strictEqual(r.decision, 'deny');
});

// ---------- plan gate fails closed ----------
test('edit: bound item with missing plan.md blocks code edits', () => {
  withPlan(null, () => {
    const r = run('guard-edit.js', edit(wt, ENGINE));
    assert.strictEqual(r.decision, 'deny');
    assert.match(r.reason, /plan\.md/);
  });
});

test('edit: bound item with plan.md lacking a phase blocks code edits', () => {
  withPlan('---\nitem_id: 123\n---\n# Plan\n', () => {
    assert.strictEqual(run('guard-edit.js', edit(wt, ENGINE)).decision, 'deny');
  });
});

test('edit: writing a fresh plan.md that already says approved is denied', () => {
  withPlan(null, () => {
    const r = run('guard-edit.js', { tool_name: 'Write', cwd: wt, tool_input: { file_path: PLAN, content: '---\nphase: approved\n---\n' } });
    assert.strictEqual(r.decision, 'deny');
    assert.match(r.reason, /gate 1/);
  });
});

test('edit: writing a fresh plan.md in phase plan is allowed', () => {
  withPlan(null, () => {
    const r = run('guard-edit.js', { tool_name: 'Write', cwd: wt, tool_input: { file_path: PLAN, content: '---\nphase: plan\n---\n' } });
    assert.strictEqual(r.decision, 'none');
  });
});

test('bash: deleting or rewriting plan.md from the shell asks', () => {
  assert.strictEqual(run('gate-bash.js', bash(`rm "${PLAN}"`)).decision, 'ask');
  assert.strictEqual(run('gate-bash.js', bash(`sed -i 's/phase: plan/phase: implement/' "${PLAN}"`)).decision, 'ask');
  assert.strictEqual(run('gate-bash.js', bash(`cat "${PLAN}"`)).decision, 'none');
});

// ---------- dw-state robustness ----------
test('dw-state: frontmatter edits keep $ patterns literally', () => {
  withPlan("---\nitem_id: 123\ntitle: costs $& and $1 more\nphase: implement\n---\n# Plan\n", () => {
    assert.strictEqual(stateRun(['set-phase', 'verify']).status, 0);
    const text = fs.readFileSync(PLAN, 'utf8');
    assert.match(text, /^title: costs \$& and \$1 more$/m);
    assert.match(text, /^phase: verify$/m);
    assert.strictEqual(text.match(/^item_id:/gm).length, 1, 'frontmatter not duplicated: ' + text);
  });
});

// ---------- test lock holds: hashes, commit gate, SubagentStop, release ----------
test('dw-state: lock-tests records a hash per file and verify-locks detects shell edits', () => {
  setPhase('implement');
  lock();
  const original = fs.readFileSync(LOCKED, 'utf8');
  try {
    const lockJson = JSON.parse(fs.readFileSync(path.join(stateDirOf(wt), 'tests-locked.json'), 'utf8'));
    assert.ok(lockJson.hashes && lockJson.hashes[LOCKED_REL], 'hash stored');
    assert.strictEqual(stateRun(['verify-locks']).status, 0);
    fs.writeFileSync(LOCKED, 'class T { /* weakened */ }\n');
    const r = stateRun(['verify-locks']);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /EngineTests\.cs/);
  } finally {
    fs.writeFileSync(LOCKED, original);
    unlock();
  }
});

test('gate 2: commit is denied while a locked test differs from its locked content', () => {
  setPhase('commit');
  lock();
  const original = fs.readFileSync(LOCKED, 'utf8');
  try {
    fs.writeFileSync(LOCKED, 'class T { }\n');
    let r = run('gate-bash.js', bash('git commit -m x'));
    assert.strictEqual(r.decision, 'deny');
    assert.match(r.reason, /locked test/i);
    fs.writeFileSync(LOCKED, original);
    r = run('gate-bash.js', bash('git commit -m x'));
    assert.strictEqual(r.decision, 'ask');
  } finally {
    fs.writeFileSync(LOCKED, original);
    unlock();
    setPhase('implement');
  }
});

test('subagent-stop: implementer that changed a locked test is told to report it (once)', () => {
  setPhase('implement');
  lock();
  const original = fs.readFileSync(LOCKED, 'utf8');
  const stop = (extra) =>
    spawnSync('node', [HOOK('subagent-stop.js')], {
      input: JSON.stringify({ hook_event_name: 'SubagentStop', cwd: wt, agent_type: 'dw:implementer', ...extra }),
      encoding: 'utf8',
    });
  try {
    assert.strictEqual(stop({}).stdout.trim(), '');
    fs.writeFileSync(LOCKED, 'class T { }\n');
    const o = JSON.parse(stop({}).stdout);
    assert.strictEqual(o.decision, 'block');
    assert.match(o.reason, /EngineTests\.cs/);
    assert.strictEqual(stop({ stop_hook_active: true }).stdout.trim(), '');
  } finally {
    fs.writeFileSync(LOCKED, original);
    unlock();
  }
});

test('dw-state: release-locks refuses before the commit phase', () => {
  setPhase('implement');
  lock();
  try {
    const r = stateRun(['release-locks']);
    assert.notStrictEqual(r.status, 0);
    assert.ok(fs.existsSync(path.join(stateDirOf(wt), 'tests-locked.json')));
  } finally {
    unlock();
  }
});

test('dw-state: release-locks refuses when a locked test has uncommitted changes', () => {
  setPhase('commit');
  lock();
  const original = fs.readFileSync(LOCKED, 'utf8');
  try {
    fs.writeFileSync(LOCKED, original + '// local\n');
    assert.notStrictEqual(stateRun(['release-locks']).status, 0);
  } finally {
    fs.writeFileSync(LOCKED, original);
    unlock();
    setPhase('implement');
  }
});

test('dw-state: release-locks after commit removes the lock and notes it in plan.md', () => {
  setPhase('commit');
  lock();
  try {
    const r = stateRun(['release-locks']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(stateDirOf(wt), 'tests-locked.json')));
    assert.match(fs.readFileSync(PLAN, 'utf8'), /test lock released after commit/);
    assert.strictEqual(run('gate-bash.js', bash('node "C:/x/scripts/dw-state.js" release-locks')).decision, 'none');
  } finally {
    unlock();
    setPhase('implement');
  }
});

// ---------- GitHub MCP matcher is narrow ----------
test('hooks.json: MCP gate matcher targets GitHub servers only', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const entry = hooks.PreToolUse.find((h) => h.hooks.some((x) => x.args && x.args.join(' ').includes('gate-mcp.js')));
  const re = new RegExp('^(?:' + entry.matcher + ')$');
  for (const t of ['mcp__github__create_issue', 'mcp__plugin_x_github__create_pull_request']) assert.ok(re.test(t), t);
  for (const t of ['mcp__claude_ai_Figma__create_new_file', 'mcp__memory__memory_write', 'mcp__gitlab__create_issue']) assert.ok(!re.test(t), t);
});

test('hooks.json: ExitPlanMode and SubagentStop hooks are registered', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.ok((hooks.PostToolUse || []).some((h) => h.matcher === 'ExitPlanMode'));
  assert.ok((hooks.SubagentStop || []).length > 0);
});

// ---------- plugin layout ----------
test('layout: no top-level bin/ (claude.ai plugin installs reject it)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'bin')));
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'dw-state.js')));
});

test('plugin.json: research_root is a directory option', () => {
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.strictEqual(pj.userConfig.research_root.type, 'directory');
});

// =====================================================================
// Review round 2. Written first, run once red, then implemented.
// =====================================================================
const approvalRecord = () => path.join(stateDirOf(wt), 'plan-approval.json');
const approve = (planText) =>
  spawnSync('node', [HOOK('plan-approved.js')], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', cwd: wt, tool_input: { plan: planText } }),
    encoding: 'utf8',
  });

// ---------- 1. mentioning dw-state.js no longer exempts the whole command ----------
test('r2: a dw-state.js comment does not exempt a forged approval', () => {
  const r = run('gate-bash.js', bash(`echo '{"at":"2099"}' > ${approvalRecord()} # dw-state.js`));
  assert.strictEqual(r.decision, 'deny');
});

test('r2: a real dw-state.js call in one segment does not exempt a write in another', () => {
  const r = run('gate-bash.js', bash(`node scripts/dw-state.js status; echo '{"at":"2099"}' > ${approvalRecord()}`));
  assert.strictEqual(r.decision, 'deny');
});

test('r2: plan.md phase jump next to a dw-state.js call asks', () => {
  setPhase('plan');
  const r = run('gate-bash.js', bash(`printf 'phase: approved' > "${PLAN}"; node scripts/dw-state.js status`));
  assert.strictEqual(r.decision, 'ask');
  assert.match(r.reason, /gate 1/);
  setPhase('implement');
});

test('r2: redirecting dw-state.js output into a state file is denied', () => {
  const r = run('gate-bash.js', bash(`node scripts/dw-state.js status > ${approvalRecord()}`));
  assert.strictEqual(r.decision, 'deny');
});

test('r2: a plain dw-state.js call is still not treated as a state write', () => {
  setPhase('implement');
  assert.strictEqual(run('gate-bash.js', bash('node "C:/x/scripts/dw-state.js" lock-tests Services/Foo/Shop.Foo.Tests/EngineTests.cs')).decision, 'none');
});

// ---------- 6. reading plan.md / state into another file is not a write ----------
test('r2: copying plan.md or state elsewhere does not ask; writing into them does', () => {
  assert.strictEqual(run('gate-bash.js', bash(`cat "${PLAN}" > /tmp/x.md`)).decision, 'none');
  assert.strictEqual(run('gate-bash.js', bash(`cp "${PLAN}" /tmp/x.md`)).decision, 'none');
  assert.strictEqual(run('gate-bash.js', bash(`cat ${stateDirOf(wt)}/item.json > /tmp/item.json`)).decision, 'none');
  assert.strictEqual(run('gate-bash.js', bash(`cp /tmp/x.md "${PLAN}"`)).decision, 'ask');
  assert.strictEqual(run('gate-bash.js', bash(`mv "${PLAN}" /tmp/x.md`)).decision, 'ask');
  assert.strictEqual(run('gate-bash.js', bash(`cat /tmp/x.md | tee "${PLAN}"`)).decision, 'ask');
  assert.strictEqual(run('gate-bash.js', bash(`bash -c "echo phase: approved > '${PLAN}'"`)).decision, 'ask');
});

// ---------- 2. line endings and BOM do not break the lock ----------
test('r2: LF->CRLF or an added BOM on a locked test is not a change', () => {
  setPhase('commit');
  lock();
  const original = fs.readFileSync(LOCKED, 'utf8');
  try {
    fs.writeFileSync(LOCKED, original.replace(/\n/g, '\r\n'));
    assert.strictEqual(stateRun(['verify-locks']).status, 0, 'CRLF only');
    assert.strictEqual(run('gate-bash.js', bash('git commit -m x')).decision, 'ask');
    fs.writeFileSync(LOCKED, '\uFEFF' + original);
    assert.strictEqual(stateRun(['verify-locks']).status, 0, 'BOM only');
    fs.writeFileSync(LOCKED, original.replace(/\n/g, '\r\n').replace('class T', 'class U'));
    assert.notStrictEqual(stateRun(['verify-locks']).status, 0, 'real change still detected');
  } finally {
    fs.writeFileSync(LOCKED, original);
    unlock();
    setPhase('implement');
  }
});

// ---------- 3. an unsubstituted ${user_config.research_root} means "unset" ----------
test('r2: item-path treats a literal ${user_config.research_root} as unset', () => {
  const out = JSON.parse(
    execFileSync('node', [STATE, 'item-path', '--type', 'bug', '--id', '888', '--title', 'x', '--root', '${user_config.research_root}'], { cwd: wt, encoding: 'utf8' })
  );
  assert.ok(out.item_dir.endsWith('/shop-research/888-x'), out.item_dir);
  assert.ok(!fs.existsSync(path.join(wt, '${user_config.research_root}')));
});

test('r2: plugin.json research_root keeps an empty default', () => {
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.strictEqual(pj.userConfig.research_root.default, '');
});

// ---------- 4. the approval is tied to plan.md's content ----------
test('r2: set-phase approved without a prompt only when plan.md matches the approved plan', () => {
  const fm = '---\nitem_id: 123\ntype: Bug\nphase: plan\ntest_mode: test-first\nfix_cycles: 0\n---\n';
  const saved = fs.readFileSync(PLAN, 'utf8');
  try {
    assert.strictEqual(approve('# Plan\n\n## Files that change\n- Engine.cs — null check\n').status, 0);
    fs.writeFileSync(PLAN, fm + '# Plan\r\n## Files that change\r\n-  Engine.cs — null check\r\n');
    assert.strictEqual(run('gate-bash.js', bash('node scripts/dw-state.js set-phase approved')).decision, 'none');
    fs.writeFileSync(PLAN, fm + '# Plan\n## Files that change\n- Engine.cs — rewrite the engine\n');
    const r = run('gate-bash.js', bash('node scripts/dw-state.js set-phase approved'));
    assert.strictEqual(r.decision, 'ask');
    assert.match(r.reason, /differs from the plan you approved/);
  } finally {
    fs.writeFileSync(PLAN, saved);
    try { fs.unlinkSync(approvalRecord()); } catch (_) {}
    setPhase('implement');
  }
});

// ---------- 5. documented limits ----------
test('r2: README names the wrappers the hook does not look inside', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /node -e/);
  assert.match(readme, /python3? -c/);
  assert.match(readme, /alias/);
});

// ---------- dw-usage: tokens per item id from transcripts ----------
test('dw-usage: item sums main + subagent usage by worktree id, dedupes streaming duplicates, writes usage.json', () => {
  const u = fs.mkdtempSync(path.join(tmp, 'usage-'));
  const projects = path.join(u, 'projects');
  const root = path.join(u, 'shop-research');
  fs.mkdirSync(path.join(root, '55555-demo-item'), { recursive: true });
  const wtp = path.join(projects, 'C--Views-shop-worktrees-55555-demo-item');
  const subs = path.join(wtp, 'sess1', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  const line = (id, cwd, tok, extra = {}) =>
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T10:00:00Z', cwd, gitBranch: 'main', requestId: 'r' + id, message: { id: 'm' + id, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: tok, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } }, ...extra });
  const wt55555 = String.raw`C:\Views\shop-worktrees\55555-demo-item`;
  fs.writeFileSync(
    path.join(wtp, 'sess1.jsonl'),
    [line(1, String.raw`C:\Views\shop`, 100), line(2, wt55555, 200), line(2, wt55555, 250), line(3, wt55555, 300)].join('\n') // m2 streamed twice
  );
  fs.writeFileSync(path.join(subs, 'agent-a.jsonl'), line(4, wt55555, 400, { isSidechain: true }));
  fs.writeFileSync(path.join(subs, 'agent-a.meta.json'), JSON.stringify({ agentType: 'dw:code-reviewer' }));
  const other = path.join(projects, 'C--Views-shop-worktrees-999-x');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 's2.jsonl'), line(9, String.raw`C:\Views\shop-worktrees\999-x`, 5000));
  const USAGE = path.join(ROOT, 'scripts', 'dw-usage.js');
  execFileSync('node', [USAGE, 'item', '--id', '55555', '--root', root, '--projects-dir', projects], { encoding: 'utf8' });
  const j = JSON.parse(fs.readFileSync(path.join(root, '55555-demo-item', 'usage.json'), 'utf8'));
  assert.strictEqual(j.total.calls, 4); // m1 (inferred from its session), m2 deduped, m3, subagent m4
  assert.strictEqual(j.total.output, 100 + 250 + 300 + 400);
  assert.strictEqual(j.by_phase['dw:code-reviewer'].calls, 1);
  assert.ok(fs.existsSync(path.join(root, '55555-demo-item', 'usage.md')));
  execFileSync('node', [USAGE, 'report', '--root', root, '--projects-dir', projects], { encoding: 'utf8' });
  assert.match(fs.readFileSync(path.join(root, 'usage-dashboard.html'), 'utf8'), /#55555/);
});

test('usage-refresh (SessionEnd): exits 0 silently with or without a bound item', () => {
  for (const cwd of [tmp, wt]) {
    const r = spawnSync('node', [HOOK('usage-refresh.js')], { input: JSON.stringify({ hook_event_name: 'SessionEnd', cwd, reason: 'clear' }), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_OPTION_USAGE_AUTO_REFRESH: 'false' } });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  }
});

test('hooks.json registers the SessionEnd usage hook', () => {
  const h = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(JSON.stringify(h.hooks.SessionEnd).includes('usage-refresh.js'));
});

test('dw-usage: estimate.json and item signals reach usage.json and the estimated-vs-actual table', () => {
  const u = fs.mkdtempSync(path.join(tmp, 'usage-est-'));
  const projects = path.join(u, 'projects');
  const root = path.join(u, 'shop-research');
  const item = path.join(root, '66666-est-item');
  fs.mkdirSync(item, { recursive: true });
  fs.mkdirSync(path.join(projects, 'p'), { recursive: true });
  const cwd = String.raw`C:\Views\shop-worktrees\66666-est-item`;
  const e = (i) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T10:0' + i + ':00Z', cwd, requestId: 'r' + i, message: { id: 'm' + i, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 1000000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  fs.writeFileSync(path.join(projects, 'p', 's1.jsonl'), [e(1), e(2)].join('\n'));
  fs.writeFileSync(path.join(item, 'estimate.json'), JSON.stringify({ size: 'XS', files_touched: 1, projects_touched: 1, ambiguity: ['scope-vague', 'design-left-open'], confidence: 'medium' }));
  fs.writeFileSync(path.join(item, 'history.md'), '## Iteration 1\n\n## Iteration 2\n');
  fs.writeFileSync(path.join(item, 'plan.md'), '---\nitem_id: 66666\nfix_cycles: 2\npr:\n---\n# Plan\n');
  const USAGE = path.join(ROOT, 'scripts', 'dw-usage.js');
  execFileSync('node', [USAGE, 'refresh', '--id', '66666', '--item-dir', item, '--projects-dir', projects], { encoding: 'utf8' });
  const j = JSON.parse(fs.readFileSync(path.join(item, 'usage.json'), 'utf8'));
  assert.strictEqual(j.estimate.size, 'XS');
  assert.strictEqual(j.signals.iterations, 2);
  assert.strictEqual(j.signals.fix_cycles, 2);
  const html = fs.readFileSync(path.join(root, 'usage-dashboard.html'), 'utf8');
  assert.match(html, /Estimated vs actual/);
  assert.match(html, /over x/); // $30 actual vs XS default top $3
  assert.match(html, /2 iterations|scope grew: 2 iterations/);
});

test('complexity-estimator agent: read-only, haiku, asks caller to resolve insufficient info', () => {
  const t = fs.readFileSync(path.join(ROOT, 'agents', 'complexity-estimator.md'), 'utf8');
  assert.match(t, /^model: haiku/m);
  assert.match(t, /^tools: Read, Grep, Glob$/m);
  assert.match(t, /insufficient_info/);
});

// ---------- multi-repo binding (dw-state bind-repo) ----------
test('multi-repo: bind-repo, guard, status, clear', () => {
  const mr = fs.mkdtempSync(path.join(tmp, 'multi-'));
  const mkRepo = (name) => {
    const r = path.join(mr, name);
    fs.mkdirSync(r, { recursive: true });
    g(r, 'init', '-q', '-b', 'main');
    g(r, 'config', 'user.email', 'dev@example.com');
    g(r, 'config', 'user.name', 'Dev');
    fs.writeFileSync(path.join(r, 'a.ts'), 'x\n');
    g(r, 'add', '.');
    g(r, 'commit', '-q', '-m', 'init');
    return r;
  };
  const be = mkRepo('shop');
  const ui = mkRepo('shop.web');
  const beWt = path.join(mr, 'be-wt');
  const uiWt = path.join(mr, 'ui-wt');
  const uiOther = path.join(mr, 'ui-other');
  const uiUnbound = path.join(mr, 'ui-unbound');
  g(be, 'worktree', 'add', '-q', '-b', 'feature/777-x', beWt);
  g(ui, 'worktree', 'add', '-q', '-b', 'feature/777-x', uiWt);
  g(ui, 'worktree', 'add', '-q', '-b', 'feature/888-y', uiOther);
  g(ui, 'worktree', 'add', '-q', '-b', 'feature/999-z', uiUnbound);
  const item = path.join(mr, 'shop-research', '777-x');
  fs.mkdirSync(item, { recursive: true });
  const planFile = path.join(item, 'plan.md');
  const setP = (p) => fs.writeFileSync(planFile, `---\nitem_id: 777\nphase: ${p}\n---\n# Plan\n`);
  setP('implement');
  const st = (args, cwd) => spawnSync('node', [STATE, ...args], { cwd, encoding: 'utf8' });
  assert.strictEqual(st(['init', '--id', '777', '--type', 'task', '--item-dir', item], beWt).status, 0);
  assert.strictEqual(st(['init', '--id', '888', '--type', 'task', '--item-dir', item], uiOther).status, 0);

  // (c) unbound other repo is still denied
  const file = (root) => path.join(root, 'a.ts');
  let r = run('guard-edit.js', edit(beWt, file(uiWt)));
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /outside this item's worktree/);

  // (f) refusals: protected branch, other item; idempotent
  r = st(['bind-repo', ui], beWt);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /protected branch 'main'/);
  r = st(['bind-repo', uiOther], beWt);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /already bound to #888/);
  assert.strictEqual(st(['bind-repo', uiWt], beWt).status, 0);
  assert.strictEqual(st(['bind-repo', uiWt], beWt).status, 0);
  const bound = JSON.parse(fs.readFileSync(path.join(stateDirOf(uiWt), 'item.json'), 'utf8'));
  assert.strictEqual(bound.item_id, '777');
  assert.strictEqual(bound.branch, 'feature/777-x');
  assert.ok(g(uiWt, 'rev-parse', '--show-toplevel').toLowerCase().endsWith('ui-wt'));

  // (a) bound repo, same item: allowed
  assert.strictEqual(run('guard-edit.js', edit(beWt, file(uiWt))).decision, 'none');
  // (b) repo bound to a different item: denied
  assert.strictEqual(run('guard-edit.js', edit(beWt, file(uiOther))).decision, 'deny');
  // (c) still-unbound repo: denied
  assert.strictEqual(run('guard-edit.js', edit(beWt, file(uiUnbound))).decision, 'deny');
  // (d) protected branch in the bound repo's main checkout: denied
  assert.strictEqual(run('guard-edit.js', edit(beWt, file(ui))).decision, 'deny');
  // (e) plan gate applies in the bound repo through the shared plan.md
  setP('plan');
  r = run('guard-edit.js', edit(beWt, file(uiWt)));
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /phase 'plan'/);
  setP('implement');

  // (h) status lists bound repos; session-start announces them
  const status = JSON.parse(st(['status'], beWt).stdout);
  assert.strictEqual(status.bound_repos.length, 1);
  assert.ok(status.bound_repos[0].path.toLowerCase().endsWith('ui-wt'));
  assert.strictEqual(status.bound_repos[0].branch, 'feature/777-x');
  // the bound checkout knows its primary, and `repos` lists both from either side
  const boundItem = JSON.parse(fs.readFileSync(path.join(stateDirOf(uiWt), 'item.json'), 'utf8'));
  assert.ok(boundItem.primary.toLowerCase().endsWith('be-wt'));
  for (const from of [beWt, uiWt]) {
    const repos = JSON.parse(st(['repos'], from).stdout);
    assert.deepStrictEqual(repos.map((x) => x.role), ['primary', 'bound']);
    assert.ok(repos[0].path.toLowerCase().endsWith('be-wt'));
  }
  const ss = run('session-start.js', { hook_event_name: 'SessionStart', cwd: beWt });
  assert.match(ss.raw.additionalContext, /Also bound \(same item\): .*ui-wt/i);

  // (g) clear unbinds every bound checkout; the other item's checkout stays bound
  const cl = JSON.parse(st(['clear'], beWt).stdout);
  assert.strictEqual(cl.unbound.length, 1);
  assert.ok(!fs.existsSync(path.join(stateDirOf(uiWt), 'item.json')));
  assert.ok(!fs.existsSync(path.join(stateDirOf(beWt), 'item.json')));
  assert.ok(fs.existsSync(path.join(stateDirOf(uiOther), 'item.json')));
});

// ---------- per-repo profiles (api + web in one item) ----------
test('profiles: presets by detection, repo file over override over preset over fallback; locks span repos', () => {
  const profiles = require(path.join(ROOT, 'hooks', 'lib', 'profiles.js'));
  const mr = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'prof-')));
  const mkRepo = (name, origin, files) => {
    const r = path.join(mr, name);
    fs.mkdirSync(path.join(r, 'src'), { recursive: true });
    g(r, 'init', '-q', '-b', 'main');
    g(r, 'config', 'user.email', 'dev@example.com');
    g(r, 'config', 'user.name', 'Dev');
    if (origin) g(r, 'remote', 'add', 'origin', origin);
    fs.writeFileSync(path.join(r, 'src', 'a.ts'), 'x\n');
    for (const [f, text] of Object.entries(files || {})) fs.writeFileSync(path.join(r, f), text);
    g(r, 'add', '.');
    g(r, 'commit', '-q', '-m', 'init');
    return r;
  };
  const be = mkRepo('shop', 'https://github.com/acme/shop.git', { 'Shop.sln': '\n' });
  const ui = mkRepo('shop.web', 'git@github.com:acme/shop.web.git', { 'package.json': '{}\n' });
  const beWt = path.join(mr, 'be-wt');
  const uiWt = path.join(mr, 'ui-wt');
  g(be, 'worktree', 'add', '-q', '-b', 'feature/55-x', beWt);
  g(ui, 'worktree', 'add', '-q', '-b', 'feature/55-x', uiWt);
  const item = path.join(mr, 'shop-research', '55-x');
  fs.mkdirSync(item, { recursive: true });
  const setP = (p) => fs.writeFileSync(path.join(item, 'plan.md'), `---\nitem_id: 55\nphase: ${p}\n---\n# Plan\n`);
  setP('implement');
  const st = (args, cwd) => spawnSync('node', [STATE, ...args], { cwd, encoding: 'utf8' });

  // detection by origin remote (worktrees included) and by preset files
  const be1 = profiles.profileFor(beWt);
  const ui1 = profiles.profileFor(uiWt);
  assert.strictEqual(be1.repo, 'shop');
  assert.strictEqual(ui1.repo, 'shop.web');
  assert.deepStrictEqual(be1.stacks, ['dotnet']);
  assert.deepStrictEqual(ui1.stacks, ['node']);
  assert.strictEqual(be1.gh_repo, 'github.com/acme/shop');
  assert.strictEqual(ui1.gh_repo, 'github.com/acme/shop.web', 'ssh origin parsed');
  assert.strictEqual(ui1.base_branch, 'main', 'no origin/HEAD: main');
  assert.match(be1.build_cmd, /dotnet build/);
  assert.ok(be1.test_globs.some((x) => /UnitTests/.test(x)), 'dotnet preset globs');
  assert.ok(!ui1.test_globs.some((x) => /UnitTests/.test(x)), 'dotnet globs do not leak into the node repo');
  assert.ok(ui1.test_globs.includes('**/*.spec.*'));
  // unknown stack: generic fallback only
  const other = mkRepo('Other', 'https://x/y/Other.git');
  const o1 = profiles.profileFor(other);
  assert.deepStrictEqual(o1.stacks, []);
  assert.deepStrictEqual(o1.profile_source, ['fallback']);
  assert.deepStrictEqual(o1.test_globs, profiles.FALLBACK.test_globs);
  assert.ok(new RegExp(o1.test_command_pattern, 'i').test('pytest -q'));
  assert.strictEqual(o1.build_cmd, '');
  // only object entries are bound repos
  assert.deepStrictEqual(profiles.boundPaths({ bound_repos: ['C:/a', { path: 'C:/b', repo: 'X' }] }), ['C:/b']);
  // research-root override over the preset, the repo's own .claude/dw.json over both
  fs.writeFileSync(path.join(mr, 'shop-research', 'dw-repos.json'), JSON.stringify({ 'shop.web': { base_branch: 'trunk', build_cmd: 'npm run build:web', lint_cmd: 'npm run lint' } }));
  fs.mkdirSync(path.join(uiWt, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(uiWt, '.claude', 'dw.json'), JSON.stringify({ base_branch: 'next', test_globs: ['src/**/*.check.ts'], copy_untracked: ['.env.local', '../secret'] }));
  // profileFor is memoised per process (hooks are short-lived): reload the module to see the new files
  const fresh = (delete require.cache[require.resolve(path.join(ROOT, 'hooks', 'lib', 'profiles.js'))], require(path.join(ROOT, 'hooks', 'lib', 'profiles.js')));
  const ui2 = fresh.profileFor(uiWt);
  assert.strictEqual(ui2.base_branch, 'next', '.claude/dw.json wins');
  assert.strictEqual(ui2.build_cmd, 'npm run build:web', 'override fills what the repo file leaves out');
  assert.strictEqual(ui2.lint_cmd, 'npm run lint');
  assert.match(ui2.test_cmd, /test/, 'preset fills the rest');
  assert.deepStrictEqual(ui2.profile_source, ['.claude/dw.json', 'dw-repos.json', 'preset:node']);
  assert.ok(ui2.test_globs.includes('src/**/*.check.ts') && ui2.test_globs.includes('**/*.spec.*'), 'globs are unioned');
  assert.deepStrictEqual(ui2.copy_untracked, ['.env.local'], 'paths leaving the checkout are dropped');
  assert.ok(ui2.warnings.some((w) => /copy_untracked/.test(w)));
  assert.strictEqual(fresh.profileFor(beWt).base_branch, 'main');
  // dw-state profile works without an item
  const pv = JSON.parse(st(['profile'], uiWt).stdout);
  assert.strictEqual(pv.has_repo_profile, true);
  assert.deepStrictEqual(pv.presets_available.sort(), ['dotnet', 'node']);
  assert.strictEqual(JSON.parse(st(['profile'], other).stdout).has_repo_profile, false);

  assert.strictEqual(st(['init', '--id', '55', '--type', 'task', '--item-dir', item], beWt).status, 0);
  const implBash = (cmd) => run('gate-bash.js', bash(cmd, 'implementer', beWt));
  assert.strictEqual(implBash('yarn ng test shared').decision, 'deny', 'common runners are denied everywhere (fallback)');
  assert.strictEqual(implBash('mycheck run').decision, 'none', 'a repo-specific runner is no concern before its repo is bound');
  fs.writeFileSync(path.join(uiWt, '.claude', 'dw.json'), JSON.stringify({ base_branch: 'next', test_globs: ['src/**/*.check.ts'], test_command_pattern: '\\bmycheck\\b' }));
  assert.strictEqual(st(['bind-repo', uiWt], beWt).status, 0);
  assert.strictEqual(implBash('mycheck run').decision, 'deny', 'bound repo adds its own test command');
  assert.match(implBash('npx vitest run').reason, /may not run tests/);
  assert.strictEqual(implBash('dotnet test x.csproj').decision, 'deny');
  assert.strictEqual(implBash('npm run lint').decision, 'none');

  // edit guard: each repo's own test globs; the dotnet globs do not leak into the node repo, the repo file's globs not into the api repo
  const e = (f) => run('guard-edit.js', edit(beWt, f, 'implementer'));
  assert.strictEqual(e(path.join(uiWt, 'src', 'a.spec.ts')).decision, 'deny');
  assert.strictEqual(e(path.join(uiWt, 'src', 'a.check.ts')).decision, 'deny');
  assert.strictEqual(e(path.join(uiWt, 'src', 'Foo.UnitTests', 'b.ts')).decision, 'none');
  assert.strictEqual(e(path.join(beWt, 'src', 'a.check.ts')).decision, 'none');
  assert.strictEqual(e(path.join(beWt, 'src', 'Foo.UnitTests', 'b.cs')).decision, 'deny');
  // simplifier's "only files in the diff" check uses the repo's own base branch (web: next, which does not exist -> falls back)
  assert.strictEqual(run('guard-edit.js', edit(beWt, path.join(uiWt, 'src', 'a.ts'), 'simplifier')).decision, 'deny');

  // locks in the bound repo: set from the primary with --repo, seen by verify-locks, shell writes and release-locks
  fs.writeFileSync(path.join(uiWt, 'src', 'a.spec.ts'), 'it("x", () => {});\n');
  let r = st(['lock-tests', '--repo', uiWt, 'src/a.spec.ts'], beWt);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(stateDirOf(uiWt), 'tests-locked.json'), 'utf8')).files, ['src/a.spec.ts']);
  assert.ok(!fs.existsSync(path.join(stateDirOf(beWt), 'tests-locked.json')), 'BE state untouched');
  r = st(['verify-locks'], beWt);
  assert.strictEqual(r.status, 0);
  assert.ok(JSON.parse(r.stdout).locked[0].toLowerCase().endsWith('ui-wt/src/a.spec.ts'));
  assert.strictEqual(run('gate-bash.js', bash('echo x > src/a.spec.ts', undefined, beWt)).decision, 'deny', 'locked FE spec via shell from the BE session');
  assert.strictEqual(run('guard-edit.js', edit(beWt, path.join(uiWt, 'src', 'a.spec.ts'))).decision, 'deny');
  fs.writeFileSync(path.join(uiWt, 'src', 'a.spec.ts'), 'changed\n');
  assert.strictEqual(st(['verify-locks'], beWt).status, 1);
  fs.writeFileSync(path.join(uiWt, 'src', 'a.spec.ts'), 'it("x", () => {});\n');
  assert.strictEqual(st(['verify-locks'], beWt).status, 0);
  setP('commit');
  r = st(['release-locks'], beWt);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).pending.length, 1, 'uncommitted FE spec keeps its lock');
  assert.ok(fs.existsSync(path.join(stateDirOf(uiWt), 'tests-locked.json')));
  g(uiWt, 'add', '.');
  g(uiWt, 'commit', '-q', '-m', 'spec');
  r = st(['release-locks'], beWt);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).released.length, 1);
  assert.ok(!fs.existsSync(path.join(stateDirOf(uiWt), 'tests-locked.json')));
});

test('multi-repo docs: agents, pipeline and pr skill know about several repos; example profiles parse', () => {
  const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
  assert.match(rd('agents', 'test-runner.md'), /^repos:$/m);
  assert.match(rd('agents', 'test-runner.md'), /test_cmd/);
  assert.match(rd('agents', 'test-author.md'), /test_filter_hint/);
  assert.match(rd('skills', 'deliver', 'references', 'pipeline.md'), /## 3a\. Bind the other repos/);
  assert.match(rd('skills', 'pr', 'SKILL.md'), /dw-state\.js" repos/);
  assert.match(rd('templates', 'item', 'plan.md'), /^repos: /m);
  const ex = JSON.parse(rd('templates', 'repo', 'dw-repos.example.json'));
  assert.ok(Object.keys(ex).some((k) => !k.startsWith('_')));
  const repoFile = JSON.parse(rd('templates', 'repo', 'dw.example.json'));
  const warnings = [];
  require(path.join(ROOT, 'hooks', 'lib', 'profiles.js')).cleanProfile(repoFile, 'dw.example.json', warnings);
  assert.deepStrictEqual(warnings, [], 'the example .claude/dw.json is valid');
  for (const f of ['node.json', 'dotnet.json']) {
    const w = [];
    const pr = JSON.parse(rd('presets', f));
    require(path.join(ROOT, 'hooks', 'lib', 'profiles.js')).cleanProfile(pr, f, w);
    assert.deepStrictEqual(w, [], f);
    assert.ok(pr.detect.length && pr.test_cmd && pr.test_command_pattern, f);
  }
  const v = (f) => JSON.parse(rd('.claude-plugin', f));
  assert.strictEqual(v('plugin.json').version, v('marketplace.json').plugins[0].version);
  assert.strictEqual(v('plugin.json').license, 'MIT');
});

// ---------- hardening: gate bypasses found by the 0.11 security review ----------
test('hardening: dw-state without .js, .git/dw deletes, dw-repos.json writes, bad regex option', () => {
  const dec = (cmd, agent) => run('gate-bash.js', bash(cmd, agent)).decision;
  assert.strictEqual(dec('node scripts/dw-state set-phase approved'), 'ask', 'set-phase without .js still asks');
  assert.strictEqual(dec('node scripts/dw-state unlock-tests --reason x'), 'ask');
  assert.strictEqual(dec('node scripts/dw-state clear'), 'ask');
  for (const cmd of ['rm -r .git/dw', 'rm .git/dw/*', 'mv .git/dw /tmp/x', 'cd .git/dw', 'Remove-Item -Recurse .git/dw']) {
    assert.strictEqual(dec(cmd), 'deny', cmd);
  }
  assert.strictEqual(dec('cp .git/dw/item.json /tmp/x'), 'none', 'copying out of the state dir is a read');
  assert.strictEqual(dec('echo {} > ../shop-research/dw-repos.json'), 'ask');
  // an invalid override of the test pattern must not crash the hook into a fail-open exit 1
  const r = run('gate-bash.js', bash('git push origin x'), { CLAUDE_PLUGIN_OPTION_TEST_COMMAND_PATTERN: '(' });
  assert.strictEqual(r.decision, 'ask');
  // an unexpected internal error becomes an ask, not an exit-1 pass-through
  const crash = spawnSync('node', ['-e', `const c=require(${JSON.stringify(path.join(ROOT, 'hooks', 'lib', 'common.js'))});c.failSafe();throw new Error('boom')`], { encoding: 'utf8' });
  assert.strictEqual(crash.status, 0);
  assert.strictEqual(JSON.parse(crash.stdout).hookSpecificOutput.permissionDecision, 'ask');
  // editing dw-repos.json or a repo's .claude/dw.json through the Edit tool asks too
  const rr = run('guard-edit.js', edit(wt, path.join(tmp, 'shop-research', 'dw-repos.json')));
  assert.strictEqual(rr.decision, 'ask');
  assert.strictEqual(run('guard-edit.js', edit(wt, path.join(wt, '.claude', 'dw.json'))).decision, 'ask');
  assert.strictEqual(dec('echo {} > .claude/dw.json'), 'ask');
});

test('hardening: init validates ids and item folder; bind-repo limits; override cannot weaken test protection', () => {
  const profiles = require(path.join(ROOT, 'hooks', 'lib', 'profiles.js'));
  const mr = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'hard-')));
  const mkRepo = (name, origin) => {
    const r = path.join(mr, name);
    fs.mkdirSync(r, { recursive: true });
    g(r, 'init', '-q', '-b', 'main');
    g(r, 'config', 'user.email', 'dev@example.com');
    g(r, 'config', 'user.name', 'Dev');
    if (origin) g(r, 'remote', 'add', 'origin', origin);
    fs.writeFileSync(path.join(r, 'a.txt'), 'x\n');
    g(r, 'add', '.');
    g(r, 'commit', '-q', '-m', 'init');
    return r;
  };
  const be = mkRepo('shop', 'https://h/o/shop.git');
  const beWt = path.join(mr, 'be-wt');
  g(be, 'worktree', 'add', '-q', '-b', 'feature/66-x', beWt);
  const item = path.join(mr, 'shop-research', '66-x');
  fs.mkdirSync(item, { recursive: true });
  const st = (args, cwd) => spawnSync('node', [STATE, ...args], { cwd, encoding: 'utf8' });
  const init = (id, dir) => st(['init', '--id', id, '--type', 'task', '--item-dir', dir], beWt);

  assert.notStrictEqual(init('abc', item).status, 0, 'non-numeric id');
  assert.match(init('local-x', item).stderr, /--id must be/);
  assert.match(st(['init', '--id', '66', '--type', 'story', '--item-dir', item], beWt).stderr, /--type must be/);
  assert.match(st(['init', '--id', '66', '--tracker', 'local', '--item-dir', item], beWt).stderr, /local item needs a local-<n> id/);
  assert.match(init('66', os.homedir()).stderr, /inside the research root/);
  assert.match(init('66', path.join(mr, 'shop-research')).stderr, /inside the research root/, 'the root itself is not an item folder');
  assert.match(init('66', beWt).stderr, /inside the research root/);
  assert.strictEqual(init('66', item).status, 0);
  assert.match(init('66', path.join(mr, 'shop-research', 'other')).stderr, /refusing to point it elsewhere/);
  assert.strictEqual(init('66', item).status, 0, 're-init with the same folder is fine');
  assert.notStrictEqual(st(['item-path', '--id', '../../x', '--title', 't'], beWt).status, 0);

  // bind-repo: detached HEAD and unknown repos outside the research family are refused
  const stray = mkRepo('Stray', 'https://h/o/Stray.git');
  const strayWt = path.join(mr, 'stray-wt');
  g(stray, 'worktree', 'add', '-q', '-b', 'feature/66-x', strayWt);
  fs.mkdirSync(path.join(mr, 'Stray-research'), { recursive: true });
  assert.match(st(['bind-repo', strayWt], beWt).stderr, /has no repo profile/);
  const det = path.join(mr, 'det-wt');
  g(be, 'worktree', 'add', '-q', '--detach', det);
  assert.match(st(['bind-repo', det], beWt).stderr, /detached HEAD/);
  const detEdit = run('guard-edit.js', edit(det, path.join(det, 'a.txt')));
  assert.strictEqual(detEdit.decision, 'ask', 'edit in a detached checkout asks');

  // override validation: only additions to test protection, bad values ignored and reported
  fs.writeFileSync(
    path.join(mr, 'shop-research', 'dw-repos.json'),
    JSON.stringify({ shop: { test_globs: ['!**', 'extra/**/*.t'], test_command_pattern: '(a+)+$', base_branch: '--evil', gh_repo: 'x y' } })
  );
  const fresh = (delete require.cache[require.resolve(path.join(ROOT, 'hooks', 'lib', 'profiles.js'))], require(path.join(ROOT, 'hooks', 'lib', 'profiles.js')));
  const p = fresh.profileFor(beWt);
  assert.strictEqual(p.base_branch, 'main');
  assert.ok(!p.test_globs.includes('!**'));
  assert.ok(p.test_globs.includes('**/tests/**'), 'fallback is kept');
  assert.match(p.test_command_pattern, /dotnet/);
  assert.ok(!/\(a\+\)\+/.test(p.test_command_pattern), 'unsafe regex dropped');
  assert.ok(p.warnings.length >= 3);
  // an empty list is ignored, a valid addition is unioned
  fs.writeFileSync(path.join(mr, 'shop-research', 'dw-repos.json'), JSON.stringify({ shop: { test_globs: [], test_command_pattern: 'mytest' } }));
  const f2 = (delete require.cache[require.resolve(path.join(ROOT, 'hooks', 'lib', 'profiles.js'))], require(path.join(ROOT, 'hooks', 'lib', 'profiles.js')));
  const p2 = f2.profileFor(beWt);
  assert.ok(p2.test_globs.length > 0);
  assert.ok(new RegExp(p2.test_command_pattern, 'i').test('mytest run') && new RegExp(p2.test_command_pattern, 'i').test('dotnet test x'), p2.test_command_pattern);
});

test('docs: bound-repo shell rule has one home and the skills point to it; pipeline uses path, not worktree, for S repos', () => {
  const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
  assert.match(rd('skills', 'worktree', 'SKILL.md'), /## Running commands in a bound repo/);
  for (const f of [['skills', 'commit', 'SKILL.md'], ['skills', 'pr', 'SKILL.md'], ['skills', 'pr-sweep', 'SKILL.md'], ['skills', 'resume', 'SKILL.md']]) {
    assert.match(rd(...f), /Running commands in a bound repo/, f.join('/'));
  }
  assert.match(rd('skills', 'deliver', 'references', 'pipeline.md'), /that repo's `path`, `base`/);
  assert.match(rd('skills', 'deliver', 'references', 'pipeline.md'), /not in `repos:` needs a plan\.md edit and a new gate-1 approval/);
});

// ---------- real paths: a short 8.3 name, junction or symlink must not change a decision ----------
test('real paths: short-name path to an ignored file, an item file and lock-tests behave like the long path', (t) => {
  if (process.platform !== 'win32') return t.skip('8.3 short names are Windows only');
  const short = (p) => spawnSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();
  const ignored = path.join(research, 'real-path-check.md');
  fs.writeFileSync(ignored, 'x\n');
  const sIgnored = short(ignored);
  if (!sIgnored || sIgnored.toLowerCase() === ignored.toLowerCase()) return t.skip('no 8.3 alias on this volume');
  // git-ignored Research file on main: allowed by long and short spelling alike
  assert.strictEqual(run('guard-edit.js', edit(main, ignored)).decision, 'none');
  assert.strictEqual(run('guard-edit.js', edit(main, sIgnored)).decision, 'none', 'short spelling of an ignored file');
  // a tracked production file in the main checkout stays denied through the short spelling
  const tracked = path.join(main, 'Services', 'Foo', 'Engine.cs');
  assert.strictEqual(run('guard-edit.js', edit(main, short(tracked))).decision, 'deny');

  // lock-tests with a short path records the repo-relative name, not ../../..
  const mr = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'short-')));
  const repo = path.join(mr, 'shop');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'dev@example.com');
  g(repo, 'config', 'user.name', 'Dev');
  fs.writeFileSync(path.join(repo, 'src', 'a.spec.ts'), 'x\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'init');
  const wtr = path.join(mr, 'wt');
  g(repo, 'worktree', 'add', '-q', '-b', 'feature/77-x', wtr);
  const item = path.join(mr, 'shop-research', '77-x');
  fs.mkdirSync(item, { recursive: true });
  fs.writeFileSync(path.join(item, 'plan.md'), '---\nitem_id: 77\nphase: implement\n---\n# Plan\n');
  const st = (args, cwd) => spawnSync('node', [STATE, ...args], { cwd, encoding: 'utf8' });
  assert.strictEqual(st(['init', '--id', '77', '--type', 'task', '--item-dir', short(item)], wtr).status, 0, 'short item folder accepted');
  const sSpec = short(path.join(wtr, 'src', 'a.spec.ts'));
  const r = st(['lock-tests', sSpec], wtr);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout).locked, ['src/a.spec.ts']);
  // the item folder through its short name is still "inside the item folder" for the guard (plan.md stays editable there)
  assert.notStrictEqual(run('guard-edit.js', edit(wtr, short(path.join(item, 'plan.md')))).decision, 'deny');
});

// ---------- dw-usage v2: config, areas, stages, thresholds, claims, folder items, sticky attribution ----------
test('dw-usage v2: areas and stages come from usage-config.json; thresholds fire and merge with usage-config.local.json', () => {
  const usage = require(path.join(ROOT, 'scripts', 'dw-usage.js'));
  const u = fs.mkdtempSync(path.join(tmp, 'usage-v2-cfg-'));
  const cfg = usage.loadConfig(u);

  // generic area rules from usage-config.json
  assert.deepStrictEqual(usage.areaOf('src/auth/login.ts', cfg._areas), { area: 'src', module: 'src/auth', kind: 'prod' });
  assert.deepStrictEqual(usage.areaOf('src/auth/login.spec.ts', cfg._areas), { area: 'src', module: 'src/auth', kind: 'test' });
  assert.deepStrictEqual(usage.areaOf('src/index.ts', cfg._areas), { area: 'src', module: 'src', kind: 'prod' });
  assert.deepStrictEqual(usage.areaOf('/repo/.claude/dw.json', cfg._areas), { ignored: true });
  assert.strictEqual(usage.areaOf('README.md', cfg._areas), null);

  // stage mapping
  assert.strictEqual(cfg._stageOf('main'), 'conversation');
  assert.strictEqual(cfg._stageOf('main:dw:commit'), 'ceremony');
  assert.strictEqual(cfg._stageOf('dw:implementer'), 'implement');
  assert.strictEqual(cfg._stageOf('dw:test-author'), 'test');
  assert.strictEqual(cfg._stageOf('dw:code-reviewer'), 'review');
  assert.strictEqual(cfg._stageOf('dw:pr-sweep'), 'pr feedback');
  assert.strictEqual(cfg._stageOf('dw:researcher'), 'understand');
  assert.strictEqual(cfg._stageOf('general-purpose'), 'other');

  // activeMin: sums gaps <= gapMin and ignores longer breaks
  assert.strictEqual(
    usage.activeMin(['2026-11-04T10:00:00Z', '2026-11-04T10:05:00Z', '2026-11-04T10:45:00Z', '2026-11-04T10:55:00Z'], 15),
    15
  );

  // thresholds fire on metrics
  const item = {
    total: { usd: 10 },
    by_stage: { ceremony: { usd: 3 }, conversation: { usd: 4 } },
    by_phase: { 'dw:implementer': { usd: 1, calls: 2 }, 'dw:test-author': { usd: 3, calls: 4 }, Explore: { usd: 0.5, calls: 4 } },
    main: { heavy_usd: 6 },
    context: { peak_tokens: 190000, compactions: { auto: 2, manual: 0 } },
    prompts: 20,
    final: true,
    usd_after_merge: 2,
  };
  const m = usage.metricsOf(item, cfg, { low: 1, high: 5 });
  const flags = usage.flagsOf(m, cfg);
  for (const k of ['ceremony_share', 'conversation_share', 'heavy_context_share', 'peak_context_tokens', 'test_to_impl_ratio', 'explore_calls', 'over_estimate', 'after_merge_share', 'user_prompts', 'compactions']) {
    assert.ok(flags.includes(k), 'expected threshold to fire: ' + k);
  }

  // local override merges thresholds per rule and replaces other top-level keys
  fs.writeFileSync(
    path.join(u, 'usage-config.local.json'),
    JSON.stringify({ active_gap_min: 30, thresholds: { ceremony_share: { max: 0.5 }, user_prompts: { max: 25 } } })
  );
  const merged = usage.loadConfig(u);
  assert.strictEqual(merged.active_gap_min, 30);
  assert.strictEqual(merged.thresholds.ceremony_share.max, 0.5);
  assert.strictEqual(merged.thresholds.ceremony_share.format, 'pct', 'rule metadata preserved on merge');
  assert.strictEqual(merged.thresholds.compactions.max, 1, 'other rules preserved on merge');
  const flagsAfter = usage.flagsOf(m, merged);
  assert.ok(!flagsAfter.includes('ceremony_share'));
  assert.ok(!flagsAfter.includes('user_prompts'));
  assert.ok(flagsAfter.includes('compactions'));
});

test('dw-usage v2: edited files, prompts, <synthetic> $0, --session claims and folder items without an id reach usage.json, dashboard and usage-help.html', () => {
  const u = fs.mkdtempSync(path.join(tmp, 'usage-v2-e2e-'));
  const projects = path.join(u, 'projects');
  const root = path.join(u, 'app-research');
  const item42 = path.join(root, '42-login-fix');
  const folderItem = path.join(root, 'adhoc-notes');
  fs.mkdirSync(item42, { recursive: true });
  fs.mkdirSync(folderItem, { recursive: true });
  const projDir = path.join(projects, 'app');
  fs.mkdirSync(projDir, { recursive: true });

  const wt42 = '/repos/app-worktrees/42-login-fix';
  const mainCwd = '/repos/app';
  const asst = (id, cwd, extra = {}) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: extra.ts || '2026-11-04T10:00:00Z',
      cwd,
      gitBranch: extra.branch || 'main',
      requestId: 'r' + id,
      attributionSkill: extra.skill,
      message: {
        id: 'm' + id,
        model: extra.model || 'claude-sonnet-5-5',
        content: extra.content || [],
        usage: { input_tokens: 100, output_tokens: extra.out || 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
  const usr = (id, cwd, content, extra = {}) =>
    JSON.stringify({
      type: 'user',
      uuid: 'u' + id,
      timestamp: extra.ts || '2026-11-04T10:00:00Z',
      cwd,
      message: { role: 'user', content },
      ...extra,
    });

  // Session s1: worktree 42 with streaming chunks editing two files, <synthetic> call, real prompts and noise prompts
  fs.writeFileSync(
    path.join(projDir, 's1.jsonl'),
    [
      usr(1, wt42, 'Fix login bug'),
      usr(2, wt42, '<task-notification>subagent done</task-notification>'),
      usr(3, wt42, 'meta prompt', { isMeta: true }),
      usr(4, wt42, [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      usr(5, wt42, [{ type: 'text', text: 'Also add a spec' }]),
      asst(1, wt42, {
        ts: '2026-11-04T10:01:00Z',
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/auth/login.ts' } }],
      }),
      // streaming duplicate for m1/r1 adding a second edited file
      asst(1, wt42, {
        ts: '2026-11-04T10:01:05Z',
        out: 1500,
        content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'src/auth/login.spec.ts' } }],
      }),
      asst(2, wt42, { ts: '2026-11-04T10:02:00Z', model: '<synthetic>', out: 500000 }),
    ].join('\n')
  );

  // Session s-claim: main checkout (no id in cwd/branch), claimed for item 42 via --session
  fs.writeFileSync(
    path.join(projDir, 's-claim.jsonl'),
    [usr(10, mainCwd, 'Discuss design'), asst(10, mainCwd, { ts: '2026-11-04T10:05:00Z', out: 2000 })].join('\n')
  );

  // Session s-folder: main checkout, claimed for folder item without an id
  fs.writeFileSync(
    path.join(projDir, 's-folder.jsonl'),
    [usr(20, mainCwd, 'Investigate metrics'), asst(20, mainCwd, { ts: '2026-11-04T10:10:00Z', out: 3000 })].join('\n')
  );

  const USAGE = path.join(ROOT, 'scripts', 'dw-usage.js');
  // Item 42 with explicit --session claim
  const r42 = JSON.parse(
    execFileSync('node', [USAGE, 'item', '--id', '42', '--root', root, '--projects-dir', projects, '--session', 's-claim'], { encoding: 'utf8' })
  );
  assert.ok(Array.isArray(r42.signals));
  const j42 = JSON.parse(fs.readFileSync(path.join(item42, 'usage.json'), 'utf8'));
  assert.strictEqual(j42.item_id, '42');
  assert.strictEqual(j42.prompts, 3); // 2 real prompts in s1 + 1 in s-claim (noise ignored)
  assert.strictEqual(j42.sessions, 2);
  assert.deepStrictEqual(j42.scope, { sessions: ['s-claim'] });
  assert.strictEqual(j42.by_model['<synthetic>'].usd, 0);
  assert.deepStrictEqual(j42.unknown_models, []);
  assert.ok(j42.edited_files.includes('src/auth/login.ts') && j42.edited_files.includes('src/auth/login.spec.ts'));
  assert.deepStrictEqual(j42.areas, [
    { area: 'src', module: 'src/auth', kind: 'prod', files: 1 },
    { area: 'src', module: 'src/auth', kind: 'test', files: 1 },
  ]);

  // Folder item without --session fails before scope is stored
  const failFolder = spawnSync('node', [USAGE, 'item', '--item-dir', folderItem, '--projects-dir', projects], { encoding: 'utf8' });
  assert.notStrictEqual(failFolder.status, 0);
  assert.match(failFolder.stderr, /--session/);

  // Folder item with --session succeeds and remembers scope on subsequent refresh (including relative --item-dir .)
  execFileSync('node', [USAGE, 'item', '--item-dir', '.', '--session', 's-folder', '--projects-dir', projects], { cwd: folderItem, encoding: 'utf8' });
  const jf = JSON.parse(fs.readFileSync(path.join(folderItem, 'usage.json'), 'utf8'));
  assert.strictEqual(jf.item_id, null);
  assert.strictEqual(jf.status, 'folder');
  assert.strictEqual(jf.label, 'adhoc-notes');
  assert.strictEqual(jf.title, 'adhoc notes');
  assert.deepStrictEqual(jf.scope, { sessions: ['s-folder'] });
  execFileSync('node', [USAGE, 'item', '--item-dir', '.', '--projects-dir', projects], { cwd: folderItem, encoding: 'utf8' });

  // Report builds both usage-dashboard.html and usage-help.html
  const rep = JSON.parse(execFileSync('node', [USAGE, 'report', '--root', root, '--projects-dir', projects], { encoding: 'utf8' }));
  assert.strictEqual(rep.items, 2);
  assert.strictEqual(rep.coverage, 1);
  const dash = fs.readFileSync(path.join(root, 'usage-dashboard.html'), 'utf8');
  const help = fs.readFileSync(path.join(root, 'usage-help.html'), 'utf8');
  assert.match(dash, /#42/);
  assert.match(dash, /adhoc-notes/);
  assert.match(dash, /usage-help\.html/);
  assert.match(help, /How to read the usage stats/);
  assert.match(help, /Item id but no usage\.json/);
});

test('dw-usage v2: sticky skill attribution keeps last main-session skill across untagged turns and tool results until next user prompt; subagents never inherit', () => {
  const u = fs.mkdtempSync(path.join(tmp, 'usage-v2-sticky-'));
  const projects = path.join(u, 'projects');
  const root = path.join(u, 'app-research');
  const itemDir = path.join(root, 'local-1-sticky');
  fs.mkdirSync(itemDir, { recursive: true });
  const projDir = path.join(projects, 'app');
  const subDir = path.join(projDir, 'sess-sticky', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });

  const wtDir = '/repos/app-worktrees/local-1-sticky';
  const asst = (id, extra = {}) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: extra.ts || '2026-11-04T11:00:00Z',
      cwd: wtDir,
      requestId: 'r' + id,
      ...(extra.skill ? { attributionSkill: extra.skill } : {}),
      message: {
        id: 'm' + id,
        model: 'claude-sonnet-5-5',
        usage: { input_tokens: 100, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
  const usr = (id, content, extra = {}) =>
    JSON.stringify({
      type: 'user',
      uuid: 'u' + id,
      timestamp: '2026-11-04T11:00:00Z',
      cwd: wtDir,
      message: { role: 'user', content },
      ...extra,
    });

  fs.writeFileSync(
    path.join(projDir, 'sess-sticky.jsonl'),
    [
      usr(1, '/dw:deliver local-1'),
      asst(1, { skill: 'dw:deliver' }), // tagged -> main:dw:deliver (implement)
      usr(2, [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]), // tool result: must NOT reset sticky
      usr(3, '<task-notification>agent done</task-notification>'), // task notification: must NOT reset sticky
      asst(2), // untagged -> inherits dw:deliver (implement)
      usr(4, 'Quick follow-up question'), // real user prompt -> resets sticky
      asst(3), // untagged -> main (conversation)
    ].join('\n')
  );

  // Subagent: tagged first call + untagged second call, neither should ever inherit sticky skill
  fs.writeFileSync(
    path.join(subDir, 'agent-1.jsonl'),
    [asst(10, { skill: 'dw:deliver' }), asst(11)].join('\n')
  );
  fs.writeFileSync(path.join(subDir, 'agent-1.meta.json'), JSON.stringify({ agentType: 'dw:researcher' }));

  const USAGE = path.join(ROOT, 'scripts', 'dw-usage.js');
  execFileSync('node', [USAGE, 'item', '--id', 'local-1', '--root', root, '--projects-dir', projects], { encoding: 'utf8' });
  const j = JSON.parse(fs.readFileSync(path.join(itemDir, 'usage.json'), 'utf8'));

  assert.strictEqual(j.item_id, 'local-1');
  assert.strictEqual(j.by_phase['main:dw:deliver'].calls, 2, 'tagged + untagged after tool result/notification');
  assert.strictEqual(j.by_phase['main'].calls, 1, 'turn after real user prompt resets to conversation');
  assert.strictEqual(j.by_phase['dw:researcher'].calls, 2, 'subagent calls stay under agent type');
  assert.strictEqual(j.by_stage.implement.calls, 2);
  assert.strictEqual(j.by_stage.conversation.calls, 1);
  assert.strictEqual(j.by_stage.understand.calls, 2);
});
