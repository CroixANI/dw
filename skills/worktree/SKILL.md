---
name: worktree
description: How to set up isolation for a dw item before any code edit - ask the user for worktree + branch or branch only, then create it with plain git (branch from branch_template, folder under worktree_root, copy_untracked files), bind it, and close it after the merge. Use whenever the dw workflow is about to start editing code for an item, or the user asks to open/switch/close an item worktree.
user-invocable: false
---

# Worktree conventions

One item = one branch per repo it edits (usually one repo), each in its own worktree or the main checkout (the user picks, every time). A worktree is
the boundary between parallel sessions; the dw edit-guard hook refuses edits outside the item's bound checkouts and on
protected branches (`${user_config.protected_branches}`).

**Precedence over a repo's worktree rule.** If the repo's `CLAUDE.md` says "worktrees only on request", a dw command the user ran
does *not* by itself choose a worktree: ask (next section). Only when the user answers "worktree + branch" is that the explicit request, so create the worktree here. Outside a dw item, follow the repo rule.

`S` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js"`. Repo settings (base branch, `copy_untracked`, `single_command_shell`): `S profile` (before `init`) or `S repos` (after).

## Names (computed, never guessed)
- Branch: `${user_config.branch_template}` (default `{prefix}/{id}-{slug}`)
  - `prefix`: `fix` when the item is a bug (or a task whose parent issue is a bug), else `feature`.
  - `id`: the issue number or `local-<n>`.
  - `slug`: kebab-case title, max 40 chars, whole words; no leading id.
  - Example: `fix/42-null-ref-on-save`, `feature/local-3-dark-mode`.
- Worktree folder: `<worktree root>/<id>-<slug>`, where the worktree root is `${user_config.worktree_root}`, or, when empty, `<parent of main checkout>/<repo>-worktrees`. Outside the main checkout, so the repo's `git status` stays clean.

## Ask first - every time, never remembered
Before the first code edit for an item, one `AskUserQuestion` with two questions:
1. **Isolation**: `Worktree + branch` (own folder, parallel-safe; pick it when other work is open in the main checkout) or `Branch only` (new branch in the current checkout; no extra folder, one active item per checkout).
2. **Names**: the computed branch (+ worktree folder when a worktree was chosen); "Other" overrides.
Do not pick a mode yourself and do not reuse an earlier answer for another item.

## Create or reuse - Worktree + branch
Run from the main checkout, one git command per Bash call:
1. `git fetch origin <base>` (`base` from `S profile`).
2. Branch exists already (`git branch --list <branch>`)? → `git worktree add "<path>" <branch>` and report its state. Otherwise `git worktree add -b <branch> "<path>" origin/<base>`.
   If `git worktree list` already shows a worktree for that branch, reuse it: tell the user if it is dirty or has unpushed commits before continuing.
3. Copy each file from the profile's `copy_untracked` (for example `.env.local`) that exists in the main checkout: `cp "<main checkout>/<file>" "<path>/<file>"`, one call per file. These hold local settings or credentials: never commit them (they must be git-ignored).
4. `EnterWorktree` with `path: <path>` (not `name:`).
5. Bind the item: `S init --id <id> --type <type> --tracker <github|local> [--issue-url <url>] --item-dir "<item folder>"`.
6. Print, without blocking: ``Rename this session for /resume: `/rename <branch>` `` — you cannot rename it yourself. (On later sessions started inside the worktree, the SessionStart hook titles it automatically.)

If the session is already inside another item's worktree, do not create a second one: tell the user to start a new session.
If `git worktree add` fails, stop and show the error; never silently fall back to editing the main checkout.

## Create or reuse - Branch only
Run in the main checkout, one git command per Bash call:
1. `git status --short` - must be clean; otherwise stop and tell the user (never stash or discard for them).
2. `git fetch origin <base>`.
3. `git switch -c <branch> origin/<base>`. If the branch already exists locally: `git switch <branch>` and report its state.
4. `S init ...` as above (item.json then lives in the shared `.git/dw/`; `init` refuses when another item is already bound to this checkout - use a worktree for the second item).
5. No `EnterWorktree`: the cwd is already the checkout. Skip the `/rename` hint (SessionStart only titles linked worktrees).

## Multi-repo item (for example `api` + `web` in one session)
One item can edit several repos from one session. Each checkout is still bound to at most one item. `/dw:deliver` does the steps below itself after plan approval when plan.md `repos:` lists more than one (pipeline §3a); do them by hand only for ad-hoc use.
1. Start the item in the first checkout as above (worktree or branch only; `S init`).
2. Ask the isolation question for the second repo too, then create its item branch with the **same branch name** as the first (`git worktree add -b <branch> <path> origin/<that repo's base branch>`, or "Branch only"). Copy that repo's `copy_untracked` files (`S profile --repo "<its main checkout>"`).
3. From the first checkout: `S bind-repo "<second checkout path>"`. It refuses protected branches and checkouts bound to another item, and is idempotent.
4. Both checkouts share the item folder and `plan.md`, so the plan gate, test locks and protected-branch rules apply in each. Test files, test commands, base branch and gh repo come from each repo's own profile (`.claude/dw.json`, `<research_root>/dw-repos.json`, detected presets, generic fallback). `S repos` shows them, `status` lists bound repos, `clear` unbinds all of them.

## Running commands in a bound repo
Subagents start in the primary checkout, so give them the repo path. Run a command in another checkout with `git -C "<path>" ...` or a `cd "<path>"` in its own Bash call (the working directory carries to the next call), then `cd` back to the primary when done. When the repo profile has `single_command_shell: true`, only the two-call `cd` form is allowed (no `git -C`, no `cd ... &&`). The checkout must be inside a directory Claude Code may use (the item's own worktrees are); if `cd` is refused, ask the user to add the folder with `/add-dir`.

## Item folder outside the checkout
The item folder (`<family>-research/<id>-<slug>`, a sibling of the main checkout, not inside it) is the single copy of `spec.md`, `plan.md` and documents.
From a worktree it is used **in place by absolute path** - never copied, never symlinked. The `allow-item-dir` hook pre-approves
Read/Grep/Glob/Edit/Write on exactly the bound item folder, so subagents get no outside-directory prompt. Always hand subagents the absolute `item_dir`.

## Find (resume)
`S find --id <id>` from any checkout of the repo lists bound worktrees with their phase and bound repos; `S repos` (from any bound checkout) lists the whole item.

## Close
When every PR is merged (or the user is done), per repo:
1. `S clear` first (it asks the user; it unbinds the item and every bound repo). Never `ExitWorktree` with `remove` before the merge (it deletes the branch).
2. Worktree: `ExitWorktree` (keep), then from the main checkout `git worktree remove "<path>"` (asks only with `--force`; refuse to force when it has uncommitted or unpushed work unless the user says so), then `git branch -d <branch>` once merged.
3. Branch only: `git switch <base>`, then `git pull --ff-only`, then `git branch -d <branch>` once merged.
