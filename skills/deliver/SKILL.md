---
name: deliver
description: Deliver a GitHub issue or local item (task, feature or bug fix) end-to-end - design grilling, plan.md in plan mode (approval gate), worktree, failing tests first when appropriate, implementer, simplifier, one test run, fresh code review, then gated commit and PR. Use for "deliver <id>", "implement option X" after a bug investigation, or when /dw:start routes a task.
argument-hint: <id> [option X]
---

# /dw:deliver $ARGUMENTS

You are the orchestrator. Hold only: the item, `spec.md`/`plan.md`, decisions, and subagent **contracts**. Never read whole diffs, raw logs or full test output — subagents do. Pass them paths, not contents.
`S` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js"`. Full step details: `references/pipeline.md`. Run state exists only after step 2 (`S init`); do not call `S set-phase` before that.

**Repo-instruction precedence.** Invoking `/dw:deliver` (or `/dw:start` routing here) does *not* choose a worktree: step 2 always asks "worktree + branch or branch only". If the user picks a worktree, that is the explicit request, even when the repo's `CLAUDE.md` says to create worktrees only on request. The command is also the explicit request for dw's own commit/PR flow (`/dw:commit`, `/dw:pr`) instead of any other commit or PR helper the repo documents. Outside a dw item the repo rules apply unchanged.

| # | Phase (`S set-phase`) | Who | Reads → writes |
|---|---|---|---|
| 0 | — | you | read `<item>/history.md` if it exists. Item folder has plan.md with `phase: done` → **new iteration** (pipeline.md §0, automatic, no resume). Else `S find --id <id>`: if a worktree exists → `/dw:resume <id>` instead (skip this check when you were invoked by `/dw:resume`: it already entered the item) |
| 1 | (no state yet) design — task/feature; bug only if a real design choice | `/dw:grill` + researcher | `spec.md` Source (+ `outcomes.md`) → `spec.md` decisions (`status: agreed`) |
| 2 | — | you | **ask**: worktree + branch, or branch only (`worktree` skill) → create → `S init ...` (no plan.md yet, so the edit guard blocks code edits) |
| 3 | `plan` → `approved` | you, **plan mode**; `ExitPlanMode` = **gate 1** | spec.md → plan → `plan.md` from `${CLAUDE_PLUGIN_ROOT}/templates/item/plan.md` (`phase: plan`) → `S set-phase approved` |
| 3a | — | you | only when plan.md `repos:` lists more than one: find, create (ask worktree or branch per repo) and `S bind-repo` the other repos; details in pipeline.md §3a |
| 3b | — | complexity-estimator (haiku, read-only) | approved plan.md + spec.md → `<item>/estimate.json` (size, drivers, ambiguity; if the estimator lacks information you pick the size via one question); right after `S set-phase approved`, before any code. Used only by `/dw:usage` |
| 4 | `tests` (test-first only) | test-author — **red step** | plan.md → failing tests → `S lock-tests <files>` |
| 5 | `implement` | implementer (build only) | plan.md (+locked tests) → diff → `S verify-locks` |
| 6 | `simplify` | simplifier (fresh) | diff + plan.md → smaller diff → `S verify-locks` |
| 6b | (code-first only) | test-author `code-first` | plan.md + diff → tests |
| 7 | `verify` | test-runner — **the pre-commit run** | plan.md Proof → PASS/FAIL contract |
| 8 | `review` | code-reviewer (fresh) | diff + plan/spec + REVIEW.md → findings |
| 9 | `commit` | `/dw:commit` — **gate 2**, then `S release-locks` | → commit |
| 10 | `pr` | `/dw:pr` — **gate 3** | → PR |
| 11 | `sweep` → `done` | `/dw:pr-sweep`, then `S clear` (asks), the `worktree` skill's Close steps, then `S archive --id <id>` (item folder → `archive/`) | |

## Rules that matter most
- **Test mode** (record in plan.md with a one-line reason): bug → `test-first` (failing repro test). Task/feature → `test-first` when acceptance criteria are concretely testable, else `code-first`. If unclear, ask the user one question.
- **Tests run at two points only.** (a) The red step: test-author runs its new tests once to prove they FAIL for the expected reason (test-first) or pass (code-first). (b) Before the commit: test-runner runs the plan's Proof once (step 7), and once per fix batch. Implementer and simplifier only build; hooks deny test commands (the repo profile's `test_command_pattern`) for them. Re-running suites after every edit costs context and invites "make it green" edits; the two bookends are the check.
- **Locks hold.** After every implementer/simplifier contract run `S verify-locks`. Non-zero exit (or a contract line `LOCKED TEST CHANGED`) → stop and show the user; gate 2 also refuses to commit until the locked tests are restored or the user unlocks them.
- **Fix loop:** test-runner FAIL → `S bump-fix-cycles` → implementer with the failure lines (tests stay locked) → test-runner. Stop after **2** cycles and escalate to the user with both contracts.
- **Review loop:** triage each Important finding yourself first (`fix` / `disagree` with evidence / `decline` as a follow-up; Security findings and anything under `## Never dismiss` in the repo's `REVIEW.md` are never dismissed without the user). Only `fix` ids go to the implementer, smallest fix, diff size checked before and after → test-runner with `only:` the affected tests → code-reviewer `rereview: true` once, with the ledger. Nits and declined items: list them for the user, don't auto-fix. Details: `references/pipeline.md` §8.
- **Repo profile:** `S repos` lists primary + bound repos with base branch, gh repo, stacks and the profile commands (`build_cmd`, `test_cmd`, `test_filter_hint`, `lint_cmd`, `format_cmd`, `copy_untracked`, `single_command_shell`). Hand subagents their repo's entry; never assume a stack.
- **Several repos:** run implementer, simplifier, test-author and code-reviewer once per repo with changes and hand each only its own repo's path, base and profile; test-runner takes all repos; commit and PR are per repo. Never edit a repo that is not bound.
- **Plan drift:** when an implementer contract reports `plan_deviations`, update plan.md `## Deviations` (and Files/Order) before moving on.
- **Gates** are hook-enforced; when a prompt appears, give the user the one-line context they need to decide (what, why, evidence). Plan approval happens **once**, at `ExitPlanMode`; a hook records it, so `S set-phase approved` asks again only if plan mode was skipped or plan.md differs from the approved plan text.
- **Subagent paths are absolute.** Always pass `item_dir` (outside the worktree when one is used) plus `plan`/`spec` as absolute paths. Subagents read the item folder in place; never copy it into the worktree.
- **Shell shape:** when the repo profile has `single_command_shell: true`, keep every Bash command single (no `&&`, `||`, pipes, redirects, `git -C`) and pass that rule to subagents.

Report after each phase in ≤ 3 lines (phase done, key result, next). Do not paste contracts verbatim unless asked.
