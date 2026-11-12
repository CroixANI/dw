---
name: grill
description: Grill the user on a solution design until shared understanding - builds a design tree, asks the whole frontier each round as numbered questions with recommended answers, looks up facts via subagents, and records settled decisions in spec.md. Use for "grill me", "/grill", stress-testing a plan or idea, and automatically in the dw feature/task design stage before plan.md.
argument-hint: "[item id | path to plan/idea | free text]"
---

# /dw:grill $ARGUMENTS

Interview the user relentlessly until you reach a shared understanding. Map it as a **design tree**: every decision branches into the decisions that hang off it.

## Rounds
The **frontier** = every decision whose prerequisites are settled — the questions you can ask now without guessing answers you have not heard. Ask the whole frontier in one round, then **wait**. Format:

```
❓ **Q1 - <title>**: <question; options if useful>

➡️ <your recommended answer>

---
```

Word every question so "yes" accepts your recommendation. A question that depends on another question still open in this round belongs to a later round. After each answer set, recompute the frontier.

## Facts vs decisions
Facts are your job, never the user's: dispatch a `researcher` subagent (codebase, issues, PRs) with numbered questions; don't ask the user anything you can look up. A running lookup is an unsettled prerequisite: only questions downstream of it wait; ask the rest now. Decisions are the user's: put each to them.

## Coverage (dw design stage — every branch must be visited)
Affected modules and contract boundaries (API, messaging, persistence) · reuse of existing patterns vs new abstractions · data and migration impact · backward compatibility · error handling and observability (logs, traces) · security · rollout (config, feature flags) · test strategy incl. **test-first vs code-first** and which test level (unit / integration / end-to-end, per the repo's conventions) · PR split strategy · explicitly out of scope. Planning checklists to draw questions from: `references/checklists.md`.

## Done
Only when the frontier is empty **and** the user confirms shared understanding. Then, if there is a dw item, update `<item>/spec.md` in place (created by `/dw:start` with `## Source`; if missing, create it from `${CLAUDE_PLUGIN_ROOT}/templates/item/spec.md`). Never edit `## Source`. Add the `## Decisions` headings from the template: each settled decision with a one-line rationale under its heading; anything unresolved goes to **Open questions** (never silently assumed); set `status: agreed`. Standalone use (no item): give the decision list in the reply and offer to save it.

Do not act on the design (no plan, no code) inside this skill.
