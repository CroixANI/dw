---
name: status
description: Show where the current dw work item stands - item, worktree, branch, plan.md phase, test mode, locked tests, fix cycles and PR. Use for "dw status", "where are we", or before deciding the next pipeline step.
---

# /dw:status

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" status` (in a worktree) — or, in the main checkout, `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" find` to list all bound worktrees.
2. With bound repos also run `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" repos` (role, repo, branch, base, locked tests per repo). Read only plan.md frontmatter (`test_mode`, `fix_cycles`, `pr`, `prs`, `repos`) and the headings plus `PRs:` lines of `history.md` (iteration number and its PRs).
3. Reply in ≤ 6 lines: `<ref> <type>` (`#42` or `local-3`) · phase · branch/worktree · test mode · locked tests · fix cycles · iteration N and PRs (one line per repo when several are bound: branch, base, PR), then the next step per `/dw:deliver`.
