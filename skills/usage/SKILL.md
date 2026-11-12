---
name: usage
description: Collect (refreshed automatically at session end by a hook) token and estimated-dollar usage of a dw work item (main session plus all subagents) from Claude Code transcripts into usage.json and usage.md in the item folder, and refresh the usage-dashboard.html summary in the research root. Use for "usage stats", "what did this item cost", "collect usage", or after the PR is merged.
---

# /dw:usage

Read-only on transcripts; writes only inside the research root. Costs are list-price **estimates** (a subscription is not billed per token); prices live in `${CLAUDE_PLUGIN_ROOT}/scripts/usage-prices.json`.

1. Id: the argument (`42` or `local-3`), else the active item (`node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" status`).
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-usage.js" item --id <id> [--root "${user_config.research_root}"]` — writes `<item>/usage.json` + `usage.md` (prints one JSON line). Omit `--root` when the option is empty.
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-usage.js" report [--root ...]` — rebuilds `<research root>/usage-dashboard.html` from all items' `usage.json`.
4. Reply in ≤ 5 lines: est. $, calls, sessions, top two phases, the dashboard path. Do not paste the tables.

Safe to re-run at any time (the item is recomputed from all transcripts). Transcripts are deleted after `cleanupPeriodDays` (default 30): collect before they expire.
