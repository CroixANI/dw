---
name: split
description: Split an epic (GitHub issue or local item) into child items - research scope, draft children (title, description, expected outcome), get approval, then create them as GitHub sub-issues (or a task list) linked to the parent. Use for "split <id>" or after /dw:start routes an epic.
argument-hint: <id>
---

# /dw:split $ARGUMENTS

Light split only: one child per independently shippable piece. Design decisions for each child happen later in its own `/dw:grill`.

1. **Intake.** Ensure `spec.md` (`## Source`) exists (`/dw:start` steps 1–4).
2. **Research** with `researcher` (parallel per area if several): affected modules, similar existing features, constraints, natural seams for independent delivery.
3. **Draft** `split-draft.md` from `${CLAUDE_PLUGIN_ROOT}/templates/item/split-draft.md`: one child per independently shippable piece; each with description, expected outcome, type label (`feature` or `task`), rough PR budget (~400 changed lines per PR).
4. **Approval.** Show the draft (titles + outcomes inline, path to the file). Nothing is created before the user approves it as a whole or with edits.
5. **Create** (GitHub item; each write hits gate 4 — the user approves it), per `github-conventions`:
   - `gh issue create` per child (title, body with `Part of #<parent>`, type label).
   - Then link every child to the parent as a **sub-issue** (`gh api` sub-issues endpoint, by the child's issue id). Never skip it. If the sub-issue API is unavailable (older GitHub Enterprise), fall back to a task list in the parent body (`- [ ] #<child>`, one `gh issue edit`), and say so.
   - Local item: no GitHub writes; the approved draft becomes a task list in `outcomes.md`, and each child is started later with `/dw:start "<child title>"`.
6. **outcomes.md** from `${CLAUDE_PLUGIN_ROOT}/templates/item/outcomes-split.md`: created issue numbers, link confirmation (sub-issue or task list), deviations from the draft.
7. **Report** the created numbers/titles and parent-link status; offer `/dw:start <child>` for the first child.
