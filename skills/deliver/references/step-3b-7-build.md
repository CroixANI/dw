# /dw:deliver — steps 3b-7: estimate, tests, implement, simplify, verify

`S` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js"` (run from inside the worktree once it exists).

## 3b. Complexity estimate (cheap, once per iteration)
- Right after `S set-phase approved`: agent `complexity-estimator` with absolute `plan.md`, `spec.md` (+ `outcomes.md`, `history.md` if present) and the worktree path. It returns JSON only.
- Write it to `<item>/estimate.json` as `{"iteration": <N>, "estimated_at": "<ISO>", ...the JSON...}`. A new iteration first archives the old one: `cp <item>/estimate.json <item>/estimate-iter<N-1>.json` (never `mv`).
- **Not enough information:** when the JSON has `insufficient_info: true` or `confidence: low`, ask the user once with `AskUserQuestion` (header "Complexity") to pick the size: options XS / S / M / L (XL via "Other"), each with its one-line definition from the agent file, the estimator's guess first and marked "(Recommended)". Store the user's pick as `size` and add `"size_source": "user"` (otherwise `"size_source": "estimator"`). One question, no follow-ups.
- The estimate is never shown as a gate and never changes the plan. It exists so `/dw:usage` can compare it with the actual cost and flag items that were simple on paper but expensive in practice. If the agent fails or returns invalid JSON, skip it and continue; do not retry.

## Context reset point 1 (after 3b)
- Everything later steps need is now on disk (spec.md decisions, plan.md, history.md, estimate.json, run state). Tell the user in one line: "Plan approved and recorded. Recommended: `/clear`, then `/dw:resume <id>`; the run continues from plan.md with a fresh context." Then continue with step 4 unless the user clears; never wait for an answer.
- If the run breaks after a `/clear`, a decision was missing from spec.md or plan.md: write it there, not only in the chat.

## 4. Failing tests first — the red step (test_mode: test-first)
- `S set-phase tests`. Agent `test-author`: `mode: test-first`, `plan`, `worktree`, and that repo's `S repos` entry as `repo` (`build_cmd`, `test_cmd`, `test_filter_hint`); with several repos one call per repo that needs tests.
- Accept only if every test FAILs for the expected reason. Otherwise send it back once with the contract's concerns.
- `S lock-tests <test_files...>` (stores a hash per file). Tests of a bound repo: `S lock-tests --repo "<that checkout>" <paths relative to it>` (locks are per checkout). Optional: offer to commit the failing tests alone (`/dw:commit` — gate 2) so the proof predates the fix; the lock stays (release only runs from phase `commit` on).
- This is one of the two points where tests run. The next one is step 7.

## 5. Implement
- `S set-phase implement`. Agent `implementer`: `plan`, `spec`, `worktree`, locked test names, the repo's `build_cmd`. With several repos: one call per repo, each with only its own repo's `worktree` and plan section (only repos whose plan section lists files; the provider of a changed contract first, otherwise either order; parallel only when the plan shows no dependency between them).
- `status: partial|blocked` → decide with the user before continuing.
- `S verify-locks`. Non-zero → stop; show the user which locked tests changed.

## 6. Simplify (fresh context)
- `S set-phase simplify`. Agent `simplifier`: `plan`, `worktree`, `base` (per repo with changes, each repo's own `base`). Nothing else — no implementer history. Then `S verify-locks` (covers every bound repo).
- 6b code-first: agent `test-author` `mode: code-first`, with the same `repo` entry as in step 4, now (tests must pass; a failure caused by production code goes back to the implementer).

## 7. Verify — the pre-commit test run (once)
- `S set-phase verify`. Agent `test-runner`: `plan`, `item_dir`, `run` (`verify-<n>`: 1 for the first run, +1 per re-run) and `repos` = the `S repos` entries that have changes (`repo, path, base, build_cmd, test_cmd, test_filter_hint, lint_cmd, format_cmd`). It builds, tests and lint-checks each repo, writes the full contract to `<item>/runs/verify-<n>.md` and returns only the short status (result, counts per repo, `report:` path).
- FAIL: `S bump-fix-cycles`; if the result is > 2 → stop and escalate (read both `runs/verify-*.md` reports only now; your hypothesis, options). Else one implementer call per failing repo with `failures_file: <item>/runs/verify-<n>.md` and that repo's name; do not read or retell the failures yourself. Then test-runner again. One test-runner run bumps the counter at most once, however many repos failed.
- ERROR (build/infra) is not a fix cycle: report it to the user.
