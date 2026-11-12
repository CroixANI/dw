---
name: scope
description: Scope a feature (GitHub issue or local item) before implementation - research affected modules and existing patterns, judge size, write outcomes.md, and offer a design note when large, sub-issues when multi-step, or /dw:deliver when it is a single task. Use for "scope <id>" or after /dw:start routes a feature.
argument-hint: <id>
---

# /dw:scope $ARGUMENTS

1. **Intake.** Ensure `spec.md` (`## Source`) exists (`/dw:start` steps 1–4).
2. **Research in a subagent.** One `researcher` call with numbered questions: which modules/entry points are touched, which existing patterns or similar features to follow (`path:line`), contract/persistence/migration impact, config or feature-flag needs, obvious unknowns. Split into 2–3 parallel researchers only when several areas or repos are involved.
3. **Judge size** from the answers:
   - **single-task** — one area, existing pattern, one focused PR.
   - **multi-task** — several steps/PRs, still one design.
   - **large** — several areas or repos, or a real design decision, or materially more than one task.
4. **Write `outcomes.md`** from `${CLAUDE_PLUGIN_ROOT}/templates/item/outcomes-scope.md`.
5. **Offer the next step** (one question):
   - single-task → ask "Deliver <ref> now?" (`AskUserQuestion`); on Yes invoke `dw:deliver` via the Skill tool (design grilling → plan → build). Do not ask the user to type the command.
   - multi-task → propose child tasks as a draft in `outcomes.md`; on approval, a GitHub item hands over to `dw:split` (sub-issues, gate 4); a local item keeps them as a task list in `outcomes.md` and delivers them one by one.
   - large → offer a design note: `docs/design/<id>-<slug>.md` committed with the first PR, or a comment on the issue (gate 4). If not large, do not ask about a design note.
6. **Report:** summary, size, `outcomes.md` path, the offered next step.
