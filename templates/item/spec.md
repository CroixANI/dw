---
item_id: {{ID}}          # 42 (GitHub issue) | local-3 (local item)
tracker: {{github|local}}
status: draft            # draft | agreed (user confirmed shared understanding)
---
# Spec — {{REF}} {{TITLE}}

## Source
- **Type:** {{bug|feature|task|epic}}   **State:** {{open|closed|local}}   **Labels:** {{LABELS}}   **Milestone:** {{MILESTONE or "none"}}
- **Issue:** {{ISSUE_URL or "local item, no issue"}}
- **Parent:** {{#PARENT and title, or "none"}}
- **Links:** {{design docs and other URLs from the body or comments, or "none" - /dw:pr puts them in the PR header}}
- **Fetched:** {{UTC_TIMESTAMP}}

### Description
{{DESCRIPTION — issue body (markdown, trimmed), or the user's words for a local item}}

### Repro steps / Acceptance criteria
{{REPRO_STEPS or ACCEPTANCE_CRITERIA}}

### Attachments
- {{name}} ({{size}}) — {{downloaded to documents/... | not downloaded}}

### Goal of this run
{{one line: "root-cause investigation, no code, no issue writes" | "deliver: design → plan → code → PR" | "split into sub-issues" | "scope investigation"}}

<!-- Source is append-only. If the issue changes later, add a dated "## Update <date>" section instead of rewriting. The issue stays the source of truth. /dw:start writes everything above this line; /dw:grill adds everything below. -->

## Decisions
Design decisions from the /dw:grill session. Facts came from lookups; decisions are the user's.
Each line: decision — one-line rationale. plan.md is built from this file.

### Affected modules and contract boundaries (public API, messages/events, persistence)
- ...
### Reuse vs new abstractions
- ...
### Data and migration impact
- ...
### Backward compatibility
- ...
### Error handling and observability (logs / traces / metrics)
- ...
### Security
- ...
### Rollout (feature flags, config)
- ...
### Test strategy (test-first vs code-first, which test levels)
- ...
### PR split strategy
- ...
### Out of scope
- ...
### Open questions (carried forward, never silently assumed)
- ...
