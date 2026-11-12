# Design checklists

Use these to generate grilling questions; the answers are facts (researcher) or decisions (user).
Repo-specific rules (module boundaries, test levels, naming) live in the repo's `CLAUDE.md`, `REVIEW.md` and `.claude/rules/`; read those first and prefer them over this list.

## Modules and boundaries
- Which entry points are impacted (endpoints, handlers, CLI commands, UI routes)? Which downstream dependencies (queues, APIs, storage, caches)?
- Who owns the rule being changed? Does the change stay inside existing module boundaries?
- Runtime impact: latency, retries, failure paths.
- Backward-compatibility constraints for contracts and their consumers (other repos, clients, stored data).
- Required config or feature-flag changes.

## Persistence
- Affected models / tables / documents; migration needed?
- Query and index impact of new access paths.
- Rollback considerations for data-shape changes.
- Data-access code stays persistence-only; transaction/concurrency behaviour preserved.

## Tests
- Each acceptance criterion maps to at least one verification step.
- New functionality → the fastest test level that proves it (usually unit); bug fix → regression test; refactoring → existing coverage stays green.
- A slower level (integration, end-to-end) only when the behaviour crosses components that fakes cannot cover.

## Traceability
- One implementation scope per item unless a split is approved; each PR states its scope and stack dependency; the issue ref (`#<n>`) in commits and the PR body.
