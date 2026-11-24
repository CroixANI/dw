# /dw:deliver — steps 1-3: design, worktree and plan

`S` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js"` (run from inside the worktree once it exists).

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
- First iteration: create `<item>/history.md` from the template with `## Iteration 1 — <date> — in progress` (scope, plan, PRs empty). Later iterations: see `references/step-0-iterations.md`.
- `S set-phase approved`. With a recorded approval it does not prompt; if plan mode was skipped, the hook asks the user to approve plan.md instead. Never move from `plan` to any later phase other than `approved` (the script refuses, the hook asks).
