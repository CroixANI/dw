# Item folder

`<research_root>/<id>-<slug>/` (lowercase slug of ≤ ~40 chars, whole words, e.g. `42-dark-mode-toggle`, `local-3-retry-on-timeout`; no item type in the name, so folders sort and search by id) — default `<parent of main checkout>/<family>-research/` (family = checkout folder name up to the first `.`, so `app` and `app.web` share `<parent>/app-research/`). It must stay outside the main checkout: Claude Code refuses Edit/Write on main-checkout paths from a worktree session.
Local working copies only: for a GitHub item the issue is the source of truth; every file names the item ref (`#42` or `local-3`).
It lives outside the worktree, so it survives worktree removal and is shared by all sessions for the item.
Cleanup (`worktree` skill, Close) moves it to `<research_root>/archive/<id>-<slug>/` with `dw-state.js archive`. To resume, the user moves it back to `<research_root>/`; until then `item-path` refuses the id (it never creates a second folder). Archived items stay on the usage dashboard.
One artifact per stage, all lowercase file names, following the AI-Native SDLC chain (intent → spec → plan): the issue snapshot and the design decisions share `spec.md`.

| File | Stage | Written by | Read by |
|---|---|---|---|
| `spec.md` — `## Source` | intake | `/dw:start` (append-only `## Update <date>`) | everything after |
| `spec.md` — `## Decisions` | design | `/dw:grill` (`status: draft → agreed`) | plan, implementer, code-reviewer |
| `outcomes.md` | investigate / scope / split | investigate, scope, split | user, grill, deliver |
| `split-draft.md` | split | split | user approval |
| `plan.md` | plan → done | deliver (frontmatter = run state) | every subagent, `/dw:resume`, hooks (phase) |
| `history.md` | every iteration | deliver / pr (append-only; one section per iteration) | deliver step 0, `/dw:resume`, `/dw:status` |
| `plan-iter<N>.md` | iteration N closed | deliver (copy of the old plan when iteration N+1 starts) | humans, researcher |
| `estimate.json` | after plan approval | deliver (complexity-estimator) | `/dw:usage` |
| `runs/verify-<n>.md` | verify | test-runner | implementer, user |
| `documents/` | investigate | downloaded attachments, extracted archives, `log-analysis.md` | investigate |

Bugs, features and epics have a `spec.md` with only `## Source`; their findings live in `outcomes.md`. Decisions stay empty unless `/dw:grill` runs.

`plan.md` frontmatter keys: `item_id, tracker, type, phase, worktree, branch, base, test_mode, fix_cycles, pr, repos, prs` (`worktree`/`branch`/`base`/`pr` are the primary repo's; the others come from `dw-state.js repos` and `prs`).
Phases: `intake → investigate → design → plan → approved → tests → implement → simplify → verify → review → commit → pr → sweep → done`.
Change the phase only with `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" set-phase <phase>` (gate 1: the approval at `ExitPlanMode` is recorded by a hook; without it, moving to `approved` asks the user. Jumping from a pre-approval phase straight to a later one is refused).
A bound worktree whose plan.md is missing or has no `phase:` counts as not approved: code edits stay blocked.

Per-worktree machine state (`item.json`, `tests-locked.json` with a hash per locked file, `plan-approval.json`) lives in `<git-dir>/dw/`, invisible to `git status`.
