---
name: setup-repo
description: Record a repo's dw profile - infer build, test, lint and format commands, test file globs and the test-command pattern from the repo (manifests, lockfiles, CI workflows, README, CLAUDE.md), show them, and write .claude/dw.json after approval. Use for "setup repo", "/dw:setup-repo", when /dw:start finds no .claude/dw.json, or when a stack has no built-in preset.
argument-hint: "[path to checkout]"
---

# /dw:setup-repo $ARGUMENTS

dw itself knows no stack. Hooks and agents read a **repo profile**, resolved as: `.claude/dw.json` in the repo > `<research_root>/dw-repos.json` (`{"<repo name>": {...}}`, for repos you do not want to commit to) > detected presets (`${CLAUDE_PLUGIN_ROOT}/presets/*.json`) > a generic fallback. This skill writes the first one. No plugin change is ever needed for a new stack.

1. **Current profile.** `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" profile [--repo "<checkout>"]` — shows `profile_source`, detected `stacks`, every field and `warnings`. If `.claude/dw.json` exists, this run updates it (show the diff, not the whole file).
2. **Inspect the repo** (file names and small files only; no builds, no installs, no test runs):
   - manifests and lockfiles: `package.json` (scripts!) + `package-lock.json`/`pnpm-lock.yaml`/`yarn.lock`/`bun.lockb`, `*.sln`/`*.csproj`, `pyproject.toml`/`requirements*.txt`/`tox.ini`/`noxfile.py`, `go.mod`, `Cargo.toml`, `pom.xml`/`build.gradle*`, `Gemfile`, `composer.json`, `Makefile`/`justfile`/`Taskfile.yml`;
   - CI: `.github/workflows/*.yml` (the commands CI really runs are the best evidence);
   - `README*`, `CONTRIBUTING*`, `CLAUDE.md`, `.claude/rules/` (stated commands and test conventions win over guesses);
   - where tests live (`git ls-files` patterns: `test/`, `tests/`, `__tests__/`, `*_test.*`, `*.spec.*`, `*Tests/`).
   For a large or unusual repo, delegate this to one `researcher` call with these questions instead of reading yourself.
3. **Propose** the profile (only fields that differ from what `profile` already shows):
   | Field | Meaning |
   |---|---|
   | `stacks` | informational names, e.g. `["python"]` |
   | `base_branch` | PR base when not the `origin/HEAD` default |
   | `test_globs` | repo-relative globs of test files (locked tests, test-author only) |
   | `test_command_pattern` | regex of commands that run tests (denied for implementer/simplifier) — cover every runner the repo uses, e.g. `\bpytest\b\|\btox\b\|python -m unittest` |
   | `build_cmd` | build or type-check, no tests (implementer's check) |
   | `test_cmd` | run the whole relevant suite once |
   | `test_filter_hint` | how to run single tests, with a placeholder, e.g. `pytest <file>::<test>` |
   | `lint_cmd` / `format_cmd` | check-only forms (`--check`, `--verify-no-changes`) on changed files where possible |
   | `copy_untracked` | git-ignored files a new worktree needs, e.g. `[".env.local"]` |
   | `single_command_shell` | `true` if the repo's permission allow-list forbids `&&`, pipes and `git -C` |
   Every command must be non-interactive (no watch mode). Cite where each came from (`package.json scripts.test`, `ci.yml:23`); mark guesses as guesses.
4. **Approve.** One `AskUserQuestion`: Write `.claude/dw.json` (Recommended) / Write to the research-root override instead / Edit first / Cancel. The write asks again (a hook guards this file). Never write without the user's answer.
5. **Write** pretty JSON with only the agreed fields. Then run `profile` again and report `profile_source`, the effective fields and any `warnings` in ≤ 8 lines.

**Safety rules (enforced by the hooks, explain them if the user asks):** test globs and test-command patterns can only be **added** to the built-in fallback; negated globs and unsafe regexes (nested quantifiers, over-long) are dropped and listed under `warnings`. So a profile can never switch test protection off. Commit `.claude/dw.json` with a normal dw item or a plain commit (gate 2); it is repo knowledge, like `CLAUDE.md`.
