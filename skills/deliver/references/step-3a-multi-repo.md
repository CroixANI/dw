# /dw:deliver — step 3a: multi-repo items

`S` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js"` (run from inside the worktree once it exists).

**Multi-repo items (for example `api` + `web`).** Each repo has its own profile (base branch, gh repo, test files and commands; `S repos` prints them). The checkout where `S init` ran is the primary; the others are bound in step 3a, and then every later step (steps 4-11) runs **once per repo that has changes**, with that repo's `path`, `base` and profile from `S repos` (shell commands in a bound repo: `worktree` skill "Running commands in a bound repo"). `plan.md` (so the phase) and `spec.md` are shared; test locks and the plan-approval record are per checkout. plan.md `worktree`/`branch`/`base` describe the primary repo only.

## 3a. Bind the other repos (only when `repos:` lists more than one)
- Right after `S set-phase approved`, before 3b. For each repo in `repos:` other than the primary (`S repos` shows the primary):
  1. Find its main checkout: a sibling folder of the primary's main checkout (a main checkout, not a linked worktree) whose `git remote get-url origin` ends in that repo's name, case-insensitive; if none or ambiguous, ask once for the path.
  2. Ask the worktree-or-branch question for that repo (`worktree` skill, same `AskUserQuestion`, scoped to the repo; never reuse the first answer silently). Copy `branch` from plan.md frontmatter verbatim, so both repos carry the same branch name; if that branch already exists in the other repo, reuse it only when it has no unrelated commits, else ask. Mixed answers are fine (for example `api` worktree, `web` branch only).
  3. Create it with plain git (`worktree add -b` or `switch -c` from `origin/<that repo's base branch>`). If that repo's `copy_untracked` (from `S profile --repo "<checkout>"`) lists files and a new worktree was created, copy each from its main checkout per the `worktree` skill (never commit them).
  4. `S bind-repo "<checkout>"` (from the primary). It refuses protected branches and checkouts bound to another item.
  5. If the checkout cannot be created or bound, stop and tell the user: never edit that repo from the primary's worktree.
- Report `S repos` as one line per repo. Hooks now treat all bound checkouts as part of the item (plan gate, protected branches, locks, per-repo test files).
