---
name: resume
description: Resume a dw work item in a new session - finds the item's worktree and plan.md, enters the worktree and continues the pipeline from the recorded phase. Use for "resume <id>", "continue <id>", or when the SessionStart context says this worktree has an active dw item.
argument-hint: <id>
---

# /dw:resume $ARGUMENTS

1. **Locate.** `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" find --id <id>` (works from the main checkout or any worktree; `<id>` is `42` or `local-3`).
   - One hit → use it. None → look for `<research_root>/<id>-*/plan.md`; if plan.md exists but no worktree, continue at the worktree step of `/dw:deliver`; if only `<research_root>/archive/<id>-*` exists, the item was cleaned up: tell the user to move that folder back to `<research_root>/` to resume it (never move it yourself); if nothing exists, run `/dw:start <id>`.
2. **Enter.** If the item is in a linked worktree and the session is not already there: `EnterWorktree` with `path: <worktree>`, and print ``/rename <branch>`` once (you cannot rename the session yourself). If the item is on a branch in a main checkout (branch only), do not call `EnterWorktree` and skip the rename hint; work in that checkout.
2b. **Other repos.** `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" repos` lists the primary and every bound repo. For each bound repo check the path exists and has the item branch checked out. If a checkout is missing or on the wrong branch, say so and offer to redo `/dw:deliver` step 3a for it (never edit it unbound). Shell in a bound repo: `worktree` skill "Running commands in a bound repo".
3. **Re-load minimal context** (do not re-read everything): `history.md` (if present: current iteration section and its PRs, plus the previous iteration's Left out / next), plan.md frontmatter + `## Order of work` + `## Deviations`; spec.md headings only; `git status --short` and `git log --oneline <base>..HEAD` (one command each, per repo when several are bound, using that repo's `base`).
4. **Report** in ≤ 5 lines: item, phase, test mode, locked tests (`dw-state.js status`), fix cycles, PR(s), per repo branch + dirty/ahead counts, and the next step.
5. **Continue** by invoking `dw:deliver` via the Skill tool (its row-0 resume check is skipped when called from here) from that phase (its table maps phase → next step). Re-run the phase's subagent rather than trusting half-finished work: e.g. phase `verify` → run test-runner again.

Phase `sweep` → `/dw:pr-sweep`. Phase `done` → offer the `worktree` skill's Close: `clear`, worktree removal, then `dw-state.js archive`; if the user wants more changes on the item, that is a new iteration (`dw:deliver`, pipeline §0).
