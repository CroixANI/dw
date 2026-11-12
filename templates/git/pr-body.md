Closes #{{ID}} {{· Part of #{{PARENT}} }}{{· Design: [{{DESIGN_TITLE}}]({{DESIGN_URL}}) }}{{· Also: {{repo}}#{{n}} }}
<!-- Local item: drop "Closes #..."; keep the other segments that exist, or delete this line. Keep "Closes #<id>" on a line of its own so GitHub closes the issue on merge. -->

## Why

{{One short paragraph: what is wrong or missing today, the risk or invariant at stake, why this change now.}}

## What

- **{{Component or area}}:** {{specific behaviour - names, flags, config keys, ordering, failure behaviour}}
- **{{Component or area}}:** {{...}}
- **Not changed:** {{explicit non-goals a reviewer might wonder about; delete if none}}
- **Tests:** {{test files/classes and the kind of test (unit, integration, e2e) that cover it}}

{{```mermaid block - only when /dw:pr rules say a diagram earns its place; else delete this line}}

{{Depends on: #{{PR_NUMBER}}   <- stacked PRs only; delete otherwise}}

🤖 Generated with [Claude Code](https://claude.com/claude-code)
