# /dw:deliver — step 8: review

`S` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js"` (run from inside the worktree once it exists).

## 8. Review (fresh context)
- `S set-phase review`. Agent `code-reviewer`: `plan`, `spec`, `worktree`, `base`; one call per repo with changes (it reads that repo's own `REVIEW.md`). Merge the findings into one ledger with a repo prefix (`R1 [web]`).
- **Triage every Important finding yourself before any fix.** The reviewer is a fresh model: it can be wrong or over-reach, and each cheap-looking fix grows the diff. Read the cited `path:line` (one `researcher` call if you need more) and record one outcome per R id in a ledger (id, outcome, evidence), kept in your context and passed on:
  - `fix` — a real defect in the intended case.
  - `disagree` — false positive or misread; evidence is `path:line`, a test or output.
  - `decline` — out of scope, a rare case, extra compatibility or small perf cost (a Nit in REVIEW.md terms); name the follow-up, one line.
  - Never `disagree`/`decline` on your own a finding tagged Security, or one about a topic listed under `## Never dismiss` in the repo's `REVIEW.md` (typical: authorization scope, persisted or wire formats, public API contracts, migrations). Show the user both sides in 2-3 lines and let them decide. Do not agree with a finding just to end the loop.
- **Smallest fix.** Run `git diff --shortstat <base>` first. Implementer gets only the `fix` ids, plus: delete or narrow code before adding a guard/helper/option, fix the case that happened, add no test the plan's Proof does not need. Run `git diff --shortstat <base>` again; if the diff grew, cut first.
- Then test-runner with `only:` the reviewer's `affected tests` → code-reviewer `rereview: true` with the previous findings **and the ledger** (it marks each old id `resolved` or `still open: <reason>`). Max one re-review. A disagreement still open after that, and any remaining Important finding, goes to the user with both sides. If the re-review reports no Important finding, stop.
- Nits: show the list; fix only those the user picks. Declined items are listed as follow-ups in the report, not fixed.
