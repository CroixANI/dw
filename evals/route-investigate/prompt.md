---
name: route-investigate
tags: [routing]
runs: 2
max_turns: 6
allowed_tools: [Read, Glob, Grep, Skill]
---

Investigate GitHub issue #57: exports drop the last row when the file has more than 1000 rows. The reporter attached a log file to the issue.
