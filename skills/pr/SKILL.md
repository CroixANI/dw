---
name: pr
description: 'Push the dw item''s branch and open or update its GitHub pull request (or a gh stack of PRs) - "<Area>: summary" title, "Closes #<n>" header and Why/What body with an optional mermaid diagram. Push and PR are gated by hooks. Use for "create PR", "open PR", "submit stack", or the PR step of /dw:deliver.'
argument-hint: "[--draft] [--stack]"
---

# /dw:pr $ARGUMENTS

Repo and base per checkout: `gh_repo` and `base` from `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" repos` (derived from `origin`, so github.com and GitHub Enterprise both work). **With several bound repos run steps 1-5 once per repo that has commits** (from that repo's checkout, its own `--repo` and base), then cross-link the PRs (step 4): open the primary repo's PR first, then the other, then `gh pr edit` the first body (the orchestrator sequences this). Shell in a bound repo: `worktree` skill "Running commands in a bound repo". Run `gh` from the **Bash** tool, so any repo hook that reacts to `gh` output sees it.

1. **Inspect** (one command each): `git status --short`, `git branch --show-current`, `git log --oneline origin/<base>..HEAD`, `gh pr list --repo <gh_repo> --head <branch> --json number,url,state --jq ".[]"`. If plan.md `## PR split` says stack, or `--stack` is given → follow `references/stacked.md` instead of steps 2–4.
2. **Body** from `${CLAUDE_PLUGIN_ROOT}/templates/git/pr-body.md`, written to the scratchpad (not the repo). Match the style of recent merged PRs in the repo if there are any (`gh pr list --state merged --limit 3`).
   - **Sources:** `spec.md` (`## Source`: issue URL, parent, links; `## Decisions`: motivation), `plan.md` (scope, Proof, `## Deviations`), `git diff origin/<base>...HEAD --stat` plus a skim of the diff for concrete names. If the parent or design links are missing from spec.md, ask the `researcher` agent for one read-only lookup. Never invent links.
   - **Header line:** `Closes #<n>` for a GitHub item (GitHub links and closes the issue on merge; use `Refs #<n>` when this PR is only one of several for the issue), then parent issue and design-note links (drop segments that do not exist). Local item: no issue line.
   - **Why** (before What): one short paragraph - problem today, risk or invariant, why now. Not bullets.
   - **What:** bullets that lead with a bold component and are concrete (identifiers, flag/config names, ordering, failure behaviour). Add `Not changed:` when a reviewer might wonder, and a `Tests:` bullet naming the test files/classes and their level. Describe the final state of the branch, not the history of the work. Length scales with the change: a small fix is a short Why plus 2-3 bullets. No files-changed list, no separate test-plan checklist.
   - **Mermaid diagram** at the end of What, no caption, only if the change has a routing/decision (flag, switch, per-type branch), several stores/services/components interacting, a changed sequence/lifecycle, or a state machine. Skip it for refactors, renames, test-only, config-only and single-function fixes. `flowchart LR` (or `sequenceDiagram` / `stateDiagram-v2`), at most ~10 nodes, only components that exist in the diff. Quote every label (`A["text"]`), use `<br/>` for line breaks, no parentheses/brackets/colons outside quotes. If `mmdc` is installed, parse-check it.
   - **Footer:** `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
   - On a body edit, regenerate the whole body from the same sources instead of patching it.
3. **Gate 3.** Show title + body summary + whether a diagram is included + commit list (≤ 8 lines). Then:
   - `git push -u origin <branch>`
   - new: `gh pr create --repo <gh_repo> --base <base> --head <branch> --title "<Area>: <summary>" --body-file <tmp> [--draft]`
   - existing: `gh pr edit <n> --repo <gh_repo> --body-file <tmp>` only if the description must change.
   Then `gh pr view <n> --repo <gh_repo> --json url,number --jq .url`.
4. Save the PR URL: the primary repo's in plan.md `pr:`, every PR as `<repo>#<n> <url>` in `prs:`, each (repo/layer, state) added to the current iteration in `<item>/history.md`. With a second repo, put the sibling PR in the body header (`Also: <repo>#<n>`) and back-fill the first PR once the second exists (`gh pr edit <n> --repo <gh_repo> --body-file <tmp>`, regenerated from the sources). `Closes #<n>` is the only issue linkage — do **not** post a comment on the issue.
5. **Output:** PR URL, base/head, draft or not, stack position if any. Ask before enabling auto-merge (`gh pr merge --squash --auto`, gated).
