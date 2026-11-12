<!--
Suggested REVIEW.md for a repo that uses the dw plugin (create it at the repo root, or merge into an existing one).
The dw code-reviewer reads it first; its definitions win over the reviewer's defaults. Replace FILL-IN items. Remove this comment block.
-->

## Severity
- **Important** — would break behaviour, leak data or breach a rule below. Blocks the commit until fixed or explicitly declined.
- **Nit** — everything else (style, naming, a rare case, small perf cost). Max 5 per review, then a count.

## Review passes (tag every finding with its pass)
1. **Bugs** — behaviour, edge cases, async/concurrency, error handling, resource leaks, contract/backward compatibility.
2. **Security** — authentication/authorization and data scoping, secrets, injection, sensitive data in logs or error responses.
3. **Compliance** — the change matches its plan and design:
   - diff vs `plan.md`: unplanned files, missed steps, scope creep;
   - decisions in `spec.md`; repo rules (`CLAUDE.md`, `.claude/rules/`); observability naming; feature-flag rollout;
   - existing or newly added test assertions were not weakened to make the change pass.

## Never dismiss
<!-- Findings on these topics are never declined or disagreed with by the orchestrator without asking you. Security is always included. -->
- Public API or wire contracts other code depends on: FILL-IN (e.g. REST routes, event payloads)
- Persisted formats and database migrations
- FILL-IN

## Do not report
- FILL-IN (e.g. generated files, vendored code, formatting already enforced by a tool)

## Output format for review agents
```
verdict: clean | important-findings
important:
  - R1 [Bugs|Security|Compliance] <path:line> — <problem> — fix: <change>
nits (max 5):
  - N1 [pass] <path:line> — <problem>
nits_not_listed: <n>
plan_compliance: matches | deviations: <list>
```
Every finding cites `path:line`; no citation, no finding.
