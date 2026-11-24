# /dw:deliver — step details

`S` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js"` (run from inside the worktree once it exists).

**Multi-repo items (for example `api` + `web`).** Each repo has its own profile (base branch, gh repo, test files and commands; `S repos` prints them). The checkout where `S init` ran is the primary; the others are bound in step 3a, and then every step below runs **once per repo that has changes**, with that repo's `path`, `base` and profile from `S repos` (shell commands in a bound repo: `worktree` skill "Running commands in a bound repo"). `plan.md` (so the phase) and `spec.md` are shared; test locks and the plan-approval record are per checkout. plan.md `worktree`/`branch`/`base` describe the primary repo only.

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

## 1. Design
- Task/feature: run the `/dw:grill` method on `spec.md` `## Source` (+ `outcomes.md` for a scoped feature). Mandatory for tasks/features; ends with `spec.md` `status: agreed`.
- Bug: the chosen fix option from `outcomes.md` is the design. Grill only if the option involves a real design decision (offer, don't force).

## 2. Worktree or branch (ask)
- Follow the `worktree` skill: first ask the user *worktree + branch* or *branch only* (every item, no answer carried over), then create it (branch name from `${user_config.branch_template}`; prefix `fix` for bugs, else `feature`). Then `S init --id <id> --type <type> --tracker <github|local> [--issue-url <url>] --item-dir "<item>"` inside the checkout.
- `<item>` stays in the research root (outside the main checkout, e.g. `<parent>/app-research/`); from a worktree it is accessed by absolute path (see `worktree`).
- The checkout is bound before the plan so plan mode can run in it and the approval can be recorded against the item. Until `phase: approved`, the edit guard blocks code edits there (no plan.md = not approved).

## 3. Plan (plan mode) — gate 1, one approval
- Enter plan mode (`EnterPlanMode`, or ask the user to press Shift+Tab). Build the plan from `spec.md` (or the bug option): files that change, order of work, risks (what could break, riskiest step, rejected options), proof (exact test commands from the repo profile's `test_cmd` / `test_filter_hint` + new tests), test mode with reason, PR split.
- Bar: an engineer who never saw the conversation could implement it from the plan alone.
- `## Repos` is mandatory: one line per repo the item edits (`api: ...`, `web: ...`) and `repos: [..]` in the frontmatter. Decide it before `ExitPlanMode` from the spec and one researcher lookup (you run it), never guess; one repo is the normal case. A repo that turns up later and is not in `repos:` needs a plan.md edit and a new gate-1 approval before any edit there. Files and Proof are grouped per repo, each with that repo's own commands.
- Present it with `ExitPlanMode`. **That approval is gate 1.** The `plan-approved` hook records it in `<git-dir>/dw/plan-approval.json`.
- Write `<item>/plan.md`: the template's frontmatter (`phase: plan`, `worktree`/`branch`/`base` filled) followed by **exactly the plan text you approved** (draft it in plan mode in the template's body structure). The hook compares the two (whitespace aside); any difference makes `set-phase approved` ask again.
- First iteration: create `<item>/history.md` from the template with `## Iteration 1 — <date> — in progress` (scope, plan, PRs empty). Later iterations: see §0.
- `S set-phase approved`. With a recorded approval it does not prompt; if plan mode was skipped, the hook asks the user to approve plan.md instead. Never move from `plan` to any later phase other than `approved` (the script refuses, the hook asks).

## 3a. Bind the other repos (only when `repos:` lists more than one)
- Right after `S set-phase approved`, before 3b. For each repo in `repos:` other than the primary (`S repos` shows the primary):
  1. Find its main checkout: a sibling folder of the primary's main checkout (a main checkout, not a linked worktree) whose `git remote get-url origin` ends in that repo's name, case-insensitive; if none or ambiguous, ask once for the path.
  2. Ask the worktree-or-branch question for that repo (`worktree` skill, same `AskUserQuestion`, scoped to the repo; never reuse the first answer silently). Copy `branch` from plan.md frontmatter verbatim, so both repos carry the same branch name; if that branch already exists in the other repo, reuse it only when it has no unrelated commits, else ask. Mixed answers are fine (for example `api` worktree, `web` branch only).
  3. Create it with plain git (`worktree add -b` or `switch -c` from `origin/<that repo's base branch>`). If that repo's `copy_untracked` (from `S profile --repo "<checkout>"`) lists files and a new worktree was created, copy each from its main checkout per the `worktree` skill (never commit them).
  4. `S bind-repo "<checkout>"` (from the primary). It refuses protected branches and checkouts bound to another item.
  5. If the checkout cannot be created or bound, stop and tell the user: never edit that repo from the primary's worktree.
- Report `S repos` as one line per repo. Hooks now treat all bound checkouts as part of the item (plan gate, protected branches, locks, per-repo test files).

## 3b. Complexity estimate (cheap, once per iteration)
- Right after `S set-phase approved`: agent `complexity-estimator` with absolute `plan.md`, `spec.md` (+ `outcomes.md`, `history.md` if present) and the worktree path. It returns JSON only.
- Write it to `<item>/estimate.json` as `{"iteration": <N>, "estimated_at": "<ISO>", ...the JSON...}`. A new iteration first archives the old one: `cp <item>/estimate.json <item>/estimate-iter<N-1>.json` (never `mv`).
- **Not enough information:** when the JSON has `insufficient_info: true` or `confidence: low`, ask the user once with `AskUserQuestion` (header "Complexity") to pick the size: options XS / S / M / L (XL via "Other"), each with its one-line definition from the agent file, the estimator's guess first and marked "(Recommended)". Store the user's pick as `size` and add `"size_source": "user"` (otherwise `"size_source": "estimator"`). One question, no follow-ups.
- The estimate is never shown as a gate and never changes the plan. It exists so `/dw:usage` can compare it with the actual cost and flag items that were simple on paper but expensive in practice. If the agent fails or returns invalid JSON, skip it and continue; do not retry.

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
- `S set-phase verify`. Agent `test-runner`: `plan` and `repos` = the `S repos` entries that have changes (`repo, path, base, build_cmd, test_cmd, test_filter_hint, lint_cmd, format_cmd`). It builds, tests and lint-checks each repo and returns one block per repo; the overall result is the worst one.
- FAIL: `S bump-fix-cycles`; if the result is > 2 → stop and escalate (both contracts, your hypothesis, options). Else one implementer call per failing repo with only that repo's `failures` lines, then test-runner again. One test-runner run bumps the counter at most once, however many repos failed.
- ERROR (build/infra) is not a fix cycle: report it to the user.

## 8. Review (fresh context)
- `S set-phase review`. Agent `code-reviewer`: `plan`, `spec`, `worktree`, `base`; one call per repo with changes (it reads that repo's own `REVIEW.md`). Merge the findings into one ledger with a repo prefix (`R1 [web]`).
- **Triage every Important finding yourself before any fix.** The reviewer is a fresh model: it can be wrong or over-reach, and each cheap-looking fix grows the diff. Read the cited `path:line` (one `researcher` call if you need more) and record one outcome per R id in a ledger (id, outcome, evidence), kept in your context and passed on:
  - `fix` — a real defect in the intended case.
  - `disagree` — false positive or misread; evidence is `path:line`, a test or output.
  - `decline` — out of scope, a rare case, extra compatibility or small perf cost (a Nit in REVIEW.md terms); name the follow-up, one line.
  - Never `disagree`/`decline` on your own a finding tagged Security, or one about a topic listed under `## Never dismiss` in the repo's `REVIEW.md` (typical: authorization scope, persisted or wire formats, public API contracts, migrations). Show the user both sides in 2-3 lines and let them decide. Do not agree with a finding just to end the loop.
- **Smallest fix.** Run `git diff --shortstat <base>` first. Implementer gets only the `fix` ids, plus: delete or narrow code before adding a guard/helper/option, fix the case that happened, add no test the plan's Proof does not need. Run `git diff --shortstat <base>` again; if the diff grew, cut first.
- Then test-runner with `only:` the reviewer's `affected tests` → code-reviewer `rereview: true` with the previous findings **and the ledger** (it marks each old id `resolved` or `still open: <reason>`). Max one re-review. A disagreement still open after that, and any remaining Important finding, goes to the user with both sides. If the re-review reports no Important finding, stop.
- Nits: show the list; fix only those the user picks. Declined items are listed as follow-ups in the report, not fixed.

## 9. Commit (gate 2)
- `S set-phase commit`, then `/dw:commit` once per repo with changes (gate 2 fires per commit). Present: files, test-runner line, review verdict, commit message.
- After the commits succeed: `S release-locks` (covers bound repos; a repo whose tests are not committed yet is listed as `pending` and keeps its lock). The locked tests are now in history unchanged, so later test changes (PR review) are ordinary, visible diff. It refuses (harmlessly) if a locked test is uncommitted or changed.

## 10. PR (gate 3)
- `S set-phase pr`, then `/dw:pr` (single or stacked per plan.md `## PR split`; with several repos one PR or stack per repo, each against its own repo and base branch, cross-linked: you open the primary repo's PR first, then the other, then `gh pr edit` the first body to add the sibling link; `/dw:pr` runs once per repo). Store the primary repo's PR URL in plan.md `pr:`, every PR in `prs:`, and append each to the current iteration's `PRs:` in history.md.
- No issue comment: `Closes #<n>` in the PR body is the only linkage (none for a local item).

## 11. After the PR
- `S set-phase sweep`. When reviews/checks arrive: `/dw:pr-sweep`. When every PR is merged: update history.md (close the iteration), `S set-phase done`, `S clear` (asks the user: it unbinds the item and every bound repo, and drops every per-item guard), the `worktree` skill's Close steps in each repo, then `S archive --id <id>` (item folder → `archive/`).

## Resuming
Everything needed to continue is in plan.md (phase, test mode, fix cycles, PRs, repos) + the worktrees (`S repos`) + `<git-dir>/dw/` of each. See `/dw:resume`.
