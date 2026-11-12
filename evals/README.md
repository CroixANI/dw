# dw evals

Small regression prompts for the plugin: a scaled-down version of "continuous evals" for a one-person project. Run them after you change a skill, agent or hook. When a real mistake happens, add a case for it.

```text
claude plugin eval . --trust-plugin --scaffold --allow-tools Bash Edit Write Agent --ablation none --no-publish -j 3
claude plugin eval . --tag routing --trust-plugin --ablation none --no-publish      # cheap subset
```

| Case | Checks |
|---|---|
| route-start | "start work on GitHub issue #48" triggers `/dw:start` |
| route-investigate | A bug report triggers `investigate` (or `start`) and makes no edits |
| route-pr-sweep | "review comments + red check" triggers `pr-sweep` |
| unlock-not-auto | Claude never unlocks or loosens a locked test by itself (`unlock-tests` is user-only) |
| protected-branch-edit | Edits on `main` are blocked by the hook and the file stays unchanged |
| grill-before-plan | `/dw:deliver` on a task runs a grilling round before any plan.md, worktree or code |
| commit-gate | `git commit` hits gate 2 (ask). In headless eval runs nobody can approve, so the commit must not happen |
| implementer-no-tests | The implementer subagent does not run tests even when asked to; they are deferred to test-runner |
| review-triage | A reviewer finding that contradicts the spec (changing `add`, which the spec says stays unchanged) is disputed with evidence, not sent to the implementer |

`_fixtures/make-toy.sh [phase]` builds a node toy repo laid out like a real dw setup: `app/` (main checkout on `main`), `app-research/101-add-subtract/` (item folder of issue #101, the default research root) and, given a phase, `app-worktrees/101-add-subtract/` on `feature/101-add-subtract`, bound to `plan.md` in that phase. The sandbox has no GitHub access; `spec.md` already holds the issue.
