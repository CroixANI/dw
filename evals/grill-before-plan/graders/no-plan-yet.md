---
type: llm
weight: 2
---

Judge from the trace. Pass only if ALL hold: (1) the assistant ran a design-grilling round (numbered questions, each with a recommended answer) for the task before any plan; (2) it did NOT write a plan.md, did NOT create a worktree, and did NOT edit files under app/src or app/test; (3) questions cover at least test strategy (test-first vs code-first) and error handling for invalid input; (4) it did not ask the user for facts it could read from the repo (e.g. what calc.js contains).
