# /dw:deliver — step 0: iterations

`S` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js"` (run from inside the worktree once it exists).

## 0. Iterations (history.md)
`<item>/history.md` (template `${CLAUDE_PLUGIN_ROOT}/templates/item/history.md`) is an append-only ledger: one section per iteration with scope, plan file, PRs, delivered, spec decisions, left-out/next. plan.md and spec.md describe the **current** iteration only.
- **No history.md and plan.md exists, phase not `done`:** same iteration; create history.md with `## Iteration 1` (in progress) at step 3 when plan.md is written.
- **Automatic new iteration:** the item folder has a plan.md with `phase: done` (or `/dw:deliver` is started on an item whose previous run is `done`/merged). Do not resume. Then:
  1. Read history.md (create `## Iteration 1` from plan.md `pr:` and `git log` if it is missing), spec.md headings and plan.md `## Deviations`.
  2. Ask the user one question: what is the new scope (issue change, extra ask)? Default to the delta only.
  3. Archive the old plan: `cp <item>/plan.md <item>/plan-iter<N-1>.md` (never `mv`). Then write a fresh `plan.md` (`phase: plan`, new branch/worktree, `pr:` empty) covering only the delta, built in plan mode as in step 3. Reference what iteration N-1 already delivered instead of repeating it. The previous `S clear` unbound every repo, so the new iteration runs steps 2, 3 and 3a in full.
  4. spec.md: add a dated `## Update <date>` under `## Source` for the scope change and add or amend `## Decisions` lines tagged `(it<N>)`; never delete earlier decisions, mark replaced ones `superseded in it<N>`.
  5. history.md: close nothing old, add `## Iteration N — <date> — in progress` with why scope grew and the delta scope.
- **Close an iteration** at step 11 (`done`): fill Delivered, PRs (final state) and Left out / next in its section.
