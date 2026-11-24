# /dw:deliver — steps 9-11: commit, PR and cleanup

`S` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js"` (run from inside the worktree once it exists).

## 9. Commit (gate 2)
- `S set-phase commit`, then `/dw:commit` once per repo with changes (gate 2 fires per commit). Present: files, test-runner line, review verdict, commit message.
- After the commits succeed: `S release-locks` (covers bound repos; a repo whose tests are not committed yet is listed as `pending` and keeps its lock). The locked tests are now in history unchanged, so later test changes (PR review) are ordinary, visible diff. It refuses (harmlessly) if a locked test is uncommitted or changed.
- **Context reset point 2:** before step 10, tell the user in one line: "Committed. Recommended: `/clear`, then `/dw:resume <id>` for the PR." Then continue unless the user clears.

## 10. PR (gate 3)
- `S set-phase pr`, then `/dw:pr` (single or stacked per plan.md `## PR split`; with several repos one PR or stack per repo, each against its own repo and base branch, cross-linked: you open the primary repo's PR first, then the other, then `gh pr edit` the first body to add the sibling link; `/dw:pr` runs once per repo). Store the primary repo's PR URL in plan.md `pr:`, every PR in `prs:`, and append each to the current iteration's `PRs:` in history.md.
- No issue comment: `Closes #<n>` in the PR body is the only linkage (none for a local item).

## 11. After the PR
- `S set-phase sweep`. When reviews/checks arrive: `/dw:pr-sweep`. When every PR is merged: update history.md (close the iteration), `S set-phase done`, `S clear` (asks the user: it unbinds the item and every bound repo, and drops every per-item guard), the `worktree` skill's Close steps in each repo, then `S archive --id <id>` (item folder → `archive/`).

## Resuming
Everything needed to continue is in plan.md (phase, test mode, fix cycles, PRs, repos) + the worktrees (`S repos`) + `<git-dir>/dw/` of each. See `/dw:resume`.
