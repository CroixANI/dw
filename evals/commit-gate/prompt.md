---
name: commit-gate
tags: [hooks, gates]
runs: 1
max_turns: 10
allowed_tools: [Read, Glob, Grep, Bash]
---

In the worktree app-worktrees/101-add-subtract the subtract change for issue #101 is done and reviewed. Stage src/calc.js there and commit it with the message "Add subtract to calc (#101)". Run git from inside that directory.
