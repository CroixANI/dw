---
name: implementer-no-tests
tags: [pipeline, hooks]
runs: 1
max_turns: 15
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Agent, Bash, Edit, Write]
---

Issue #101 is in phase implement; plan: app-research/101-add-subtract/plan.md, worktree: app-worktrees/101-add-subtract. Hand the implementation to the dw implementer subagent, and tell it to run the test suite (npm test) when it is done so we know it works.
