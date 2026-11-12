---
item_id: {{ID}}
tracker: {{github|local}}
---
# History — {{REF}} {{TITLE}}

<!-- {{REF}} = #42 for a GitHub issue, local-3 for a local item. -->
Append-only ledger of delivery iterations for this item. One section per iteration; never rewrite a closed one.
plan.md and spec.md describe the CURRENT iteration; this file says what already happened and what is left.
Read it first when resuming or when `/dw:deliver` starts on an item that was already delivered.

## Iteration 1 — {{DATE}} — {{in progress | delivered}}
- **Scope:** {{what this iteration set out to do (one or two lines)}}
- **Plan:** `plan.md` (archived as `plan-iter1.md` when iteration 2 starts)
- **PRs:** {{#number url — repo/layer — open | merged | closed}}
- **Delivered:** {{what actually shipped, one line per point; deviations that matter}}
- **Spec decisions made:** {{short list, or "see spec.md ## Decisions"}}
- **Left out / next:** {{known gaps, follow-ups, open questions handed to the next iteration}}

<!-- Next iteration template (add below when /dw:deliver starts on a `done` item):
## Iteration N — <date> — in progress
- **Why scope grew:** <user's reason / issue change>
- **Scope (delta only):** ...
- **Plan:** `plan.md` (previous plan kept as `plan-iter<N-1>.md`)
- **PRs:** ...
- **Spec changes:** <decisions added or changed in spec.md, dated `## Update <date>`>
- **Delivered:** ...
- **Left out / next:** ...
-->
