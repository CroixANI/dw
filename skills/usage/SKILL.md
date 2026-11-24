---
name: usage
description: Collect (refreshed automatically at session end by a hook) token and estimated-dollar usage of a dw work item (main session plus all subagents) from Claude Code transcripts into usage.json and usage.md in the item folder, and refresh usage-dashboard.html and usage-help.html in the research root. Use for "usage stats", "what did this item cost", "collect usage", or after the PR is merged.
---

# /dw:usage

Read-only on transcripts; writes only inside the research root. Costs are list-price **estimates** (a subscription is not billed per token); prices live in `${CLAUDE_PLUGIN_ROOT}/scripts/usage-prices.json`; areas, stages and thresholds live in `${CLAUDE_PLUGIN_ROOT}/scripts/usage-config.json` (override any key in `<research root>/usage-config.local.json`).

1. Id: the argument (`42` or `local-3`), else the active item (`node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" status`).
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-usage.js" item --id <id> [--root "${user_config.research_root}"]` — writes `<item>/usage.json` + `usage.md` and prints one JSON line including `signals`. Omit `--root` when empty.
   - Work done in the main checkout on the default branch has no id in `cwd`/branch and is guessed from the dominant id of its session; `--session <session id[,id]>` stores an explicit session claim in `usage.json` (wins over the guess).
   - A folder without an item id: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-usage.js" item --item-dir <folder> --session <session id[,id]>`.
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-usage.js" report [--root ...]` — rebuilds `<research root>/usage-dashboard.html` and `usage-help.html`, scanning transcripts for coverage (`--no-scan` skips the coverage scan).
4. Reply in ≤ 6 lines: est. $, active time, top two stages, signals that fired (by label), dashboard path. Do not paste the tables.

Safe to re-run at any time. When no transcript matches, the command fails and the old `usage.json` is kept. Transcripts are deleted after `cleanupPeriodDays` (default 30): collect before they expire.
