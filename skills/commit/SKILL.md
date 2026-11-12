---
name: commit
description: Create a scoped, traceable commit for the current dw item ("<summary> (#<n>)" subject) after tests and review. The commit itself is gated by a hook that asks the user. Use for "commit", "create commit", or the commit step of /dw:deliver.
argument-hint: "[short summary override]"
---

# /dw:commit

For a dw item this skill replaces any other commit helper the repo documents (the user chose the dw flow). If the repo's `CLAUDE.md` defines a commit-message convention (for example Conventional Commits), follow it and keep the issue ref.

0. **Which repo.** One commit per repo. With a multi-repo item run this skill once for each checkout from `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" repos` that has changes (`git status --short` there), each on its own item branch; the message uses the same summary and ref, and the body names the repo's part. Shell in a bound repo: `worktree` skill "Running commands in a bound repo".
1. **Preconditions** (from `dw-state.js status` + plan.md): you are in the item's worktree (or the bound repo's checkout you were given), not on a protected branch; test-runner's last result (this repo's block, with several repos) is PASS (or the user explicitly accepted otherwise, in the conversation); review has no open Important findings. If not, say what's missing and stop.
2. **Scope.** `git status --short`. Stage only files that belong to the plan (`git add <paths>`, never `git add .` / `-A` blindly). Never stage the item folder, `.claude/settings.local.json`, `pr-body.md`, files from the profile's `copy_untracked`, scratch or debug files. Unexpected files → ask.
3. **Message** from `${CLAUDE_PLUGIN_ROOT}/templates/git/commit-message.txt`: subject `<imperative summary> (#<n>)` for a GitHub item, no ref for a local item; a 1–3 line what/why body; `Co-Authored-By` trailer with the current model.
   Write it to a temp file in the scratchpad and commit with `git commit -F <file>` (avoids quoting issues; one command).
4. **Gate 2.** The hook asks the user. Before that, show in ≤ 6 lines: files, test line, review verdict, subject.
5. **Release the test lock** (test-first items; with several repos run it once after the last repo's commit; for the optional red-test-only commit of pipeline step 4 the PASS/review preconditions do not apply and `release-locks` is expected to refuse at phase `tests`: leave the lock): `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" release-locks`. It succeeds only from phase `commit` on and only if the locked tests are committed unchanged; if it refuses, say why and leave the lock.
   If gate 2 denied the commit because a locked test changed, stop and show the user the file; never restore or edit it yourself.
6. **Output:** short SHA, subject, file count. Do not push (that's `/dw:pr`, gate 3).

One logical change per commit. Never amend or rewrite pushed history without explicit approval. Never use `--no-verify`.
