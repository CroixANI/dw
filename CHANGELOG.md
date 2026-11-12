# Changelog

## 0.1.0 — 2026-11-11
Initial public release, derived from a private workflow plugin.

- Pipeline: issue → grill → plan (gate 1) → test-first → implement → simplify → one test run → fresh review → gated commit (gate 2) and PR (gate 3) → PR sweep.
- GitHub as tracker and PR host: issues via `gh` (optionally the GitHub MCP server), sub-issues for splits, `Closes #n` linking, gate 4 for issue writes.
- Optional issue: free text at `/dw:start` asks to create a GitHub issue or work on a local item (`local-<n>`).
- Stack-agnostic repo profiles (`.claude/dw.json`, personal `dw-repos.json`, presets, generic fallback) and `/dw:setup-repo`; presets for Node/TypeScript and .NET.
- Multi-repo items, test locks with hashes, plan-approval hash, usage stats and dashboard.
