---
name: investigate
description: Investigate a bug (GitHub issue or local item) - download and extract its attachments, analyze logs and traces in subagents, research the code, and write outcomes.md with root cause, fix options and evidence. No code changes, no issue writes. Use for "investigate bug <id>" or after /dw:start routes a bug.
argument-hint: <id>
---

# /dw:investigate $ARGUMENTS

Goal: a root-cause report the user reviews before any fix. You synthesize; subagents read the heavy data.
**No code edits, no issue writes** (no comments, labels or state changes).

1. **Intake.** If `spec.md` (`## Source`) is missing, run the `/dw:start` steps 1–4 first.
2. **Evidence download.** GitHub issue: find attachment links in the body and comments and download them per `github-conventions` into `<item>/documents/attachment-<n>/` (extract archives, one folder per archive). Local item: ask the user for paths to any logs, traces or screenshots and copy them into `documents/`. Plain logs/traces go straight into `documents/`.
3. **Classify each evidence folder** by file names (do not read contents yourself):
   - logs, OpenTelemetry/Jaeger/Tempo trace exports, crash dumps as text → **log-analyst**
   - screenshots, small config or sample-data files → note them for the researcher
4. **Fan out in parallel** (one Agent call per evidence folder, plus one researcher):
   - `log-analyst`: files, bug summary, the question "what failed, when, and where in code".
   - `researcher`: 3–6 numbered fact questions from the bug text (which module/handler owns this behaviour, recent changes in that area via `git log`, similar past issues or PRs via read-only `gh`).
5. **Synthesize** only from the subagents' contracts. If evidence conflicts or is thin, run one more targeted researcher round rather than reading raw files.
6. **Write `outcomes.md`** from `${CLAUDE_PLUGIN_ROOT}/templates/item/outcomes-bug.md`: what happens, likely root cause with `path:line`, affected modules, 1–3 fix options (each with risk and the failing test that would prove it), evidence links.
7. **Report** (≤ 10 lines): root cause in one sentence, confidence, recommended option, `outcomes.md` path. Offer `/dw:grill` only if choosing between options is a real design decision. End with:
   "To fix it, say **implement option A** — I'll plan it (test-first: failing repro test, then the fix) in an isolated branch or worktree (you choose) via /dw:deliver."
   When the user replies with an option, invoke `dw:deliver` via the Skill tool (`<id> option X`) yourself; do not ask them to type the command.
