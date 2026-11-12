---
name: grill-before-plan
tags: [pipeline, design]
runs: 1
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Agent, Bash, Write]
---

/dw:deliver 101

The repo is in app/ (run commands from there). This sandbox has no GitHub access: app-research/101-add-subtract/spec.md (`## Source`) already holds issue #101. Follow the dw pipeline.
