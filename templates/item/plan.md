---
item_id: {{ID}}                # 42 (GitHub issue) | local-3 (local item)
tracker: {{github|local}}
type: {{TYPE}}                 # bug | feature | task | epic
phase: plan                    # intake|investigate|design|plan|approved|tests|implement|simplify|verify|review|commit|pr|sweep|done
worktree: {{WORKTREE_PATH}}        # primary repo's checkout (branch and base too); other repos: dw-state.js repos
branch: {{BRANCH}}
base: {{BASE_BRANCH}}
test_mode: {{test-first|code-first}}
fix_cycles: 0
pr: {{PR_URL or empty}}        # primary repo's PR
repos: [{{api}}]               # repos this item edits (origin repo names), e.g. [api, web]; more than one => deliver binds the others after approval
prs: []                        # one entry per PR: "<repo>#<n> <url>"
---
# Plan: {{TITLE}} (from spec.md {{DATE}} | from outcomes.md option {{X}})

Test mode: **{{test-first|code-first}}** — {{why: bug repro / acceptance criteria concretely testable / not testable up-front}}

## Repos
- {{api: what changes here | web: what changes here | api only}}

## Files that change
<!-- with more than one repo prefix each path with its repo: `web:src/settings/...` -->
- `{{path}}` — {{what}}

## Order of work
1. ...

## Risks
- {{what could break, riskiest step, options rejected and why}}

## Proof
- Tests that prove it (test-runner runs these once at the end), one block per repo:
  - {{repo}}: `{{test_cmd from the repo profile, narrowed with test_filter_hint}}`
  - Lint/format: `{{lint_cmd}}`, `{{format_cmd}}` (check mode, changed files)
  - New/locked tests: {{test id — criterion}}
- Build: `{{build_cmd from the repo profile}}` (or "n/a")

## PR split
- {{single PR per repo | stack: layer 1 ..., layer 2 ...}}

## Deviations
<!-- When implementation departs from the plan, record it here (date — what — why). -->

## Log
<!-- dw-state appends test-lock changes here. -->
