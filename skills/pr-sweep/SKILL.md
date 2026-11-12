---
name: pr-sweep
description: Babysit the dw item's pull request - sweep unresolved review threads (human and bot) and failing checks via gh, classify them, fix valid ones through implementer + one test run per batch, then push and reply (gated). Use for "sweep PR", "address review comments", "fix failing checks", or when the PR is waiting on feedback.
argument-hint: "[pr-number]"
---

# /dw:pr-sweep $ARGUMENTS

One cycle per invocation; the user can repeat it or run it under `/loop`. Never hand the PR to another tool that pushes or resolves threads on its own from here.

1. **Locate.** PR from `$ARGUMENTS`, else every PR in plan.md `prs:` (fall back to `pr:`); a multi-repo item sweeps each PR in turn. Each PR's repo and checkout come from `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" repos` (match `gh_repo`). Must be in the item's worktree (`/dw:resume <id>` if not). `git pull --ff-only` first, in that repo's checkout (`worktree` skill "Running commands in a bound repo"); if it fails (diverged branch), stop and ask.
2. **Collect** (compact, `--json` + `--jq` only):
   - checks: `gh pr checks <n> --repo <gh_repo of that PR> --json name,state,link --jq '.[] | select(.state != "SUCCESS")'`
   - unresolved threads: GraphQL query from `references/queries.md` (`reviewThreads` where `isResolved == false`: id, path, line, author, first comment body).
3. **Classify** each item (show the table to the user):
   - **Must fix** — correctness, reliability, security, failing tests/checks.
   - **Optional** — style, non-blocking refinement (fix only if the user picks it).
   - **Invalid** — misunderstanding / not applicable (draft a short, polite reply with the reason).
   Also mark each Must-fix/Optional item **code** or **test** (the comment asks to add, change or fix a test).
   Low confidence → ask the user before changing code.
4. **Fix as one batch:**
   - `test` items → agent `test-author` (`mode: code-first`, the comments as the fix list, and the PR's repo entry from `dw-state.js repos` as `repo`, so it uses that repo's test commands). If `dw-state.js status` still shows a test lock, `release-locks` first; if it refuses, ask the user to run `/dw:unlock-tests <reason>` — never work around a lock.
   - `code` items → implementer with the list (+ chosen Optional).
   - Skip `implementer` when the batch has only `test` items. Then test-runner **once** for the batch (`only:` affected tests) → `/dw:commit` (gate 2) → `git push` (gate 3).
   Failing CI check you cannot reproduce locally: summarize `gh run view <id> --repo <gh_repo> --log-failed` in one `researcher` call (never `log-analyst`), don't read it raw.
5. **Reply** to each addressed thread (what changed + short SHA) and resolve only threads you fixed — GraphQL mutations are gate 3. Never resolve a human reviewer's thread you only replied to; let them resolve.
6. **Report:** new items, classification counts, fixes + SHA, test line, replies posted, remaining blockers, whether the PR is now waiting only on approval.
7. When the PR is merged (or the user says they are done), offer once: "Collect usage stats for <ref>? (`/dw:usage`)".
