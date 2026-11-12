#!/usr/bin/env bash
# Builds a tiny node git repo for dw evals, laid out like a real dw setup, in the current directory:
#   app/                                    main checkout (branch main, protected)
#   app-research/101-add-subtract/          item folder of issue #101 (the default research root: <parent>/<repo>-research)
#   app-worktrees/101-add-subtract/         item worktree on feature/101-add-subtract (only when a phase is given)
# Usage: make-toy.sh [phase]   (no phase = main checkout only; with phase = item 101 worktree bound at that phase)
set -euo pipefail
PHASE="${1:-}"
ROOT="$PWD"
APP="$ROOT/app"
ITEM="$ROOT/app-research/101-add-subtract"
WT="$ROOT/app-worktrees/101-add-subtract"
BRANCH="feature/101-add-subtract"

mkdir -p "$APP" "$ITEM"
cd "$APP"
git init -q -b main
git config core.autocrlf false
git config user.email dev@example.com
git config user.name Dev
mkdir -p src test
printf "'use strict';\n// calc: simple arithmetik helpers\nfunction add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n" > src/calc.js
printf "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/calc');\ntest('add', () => assert.strictEqual(add(2, 3), 5));\n" > test/calc.test.js
printf '{\n  "name": "calc",\n  "private": true,\n  "scripts": { "test": "node --test test/" }\n}\n' > package.json
printf 'node_modules/\n' > .gitignore
cat > CLAUDE.md <<'MD'
# Toy repo (dw evals)
- No build step. Tests: `node --test test/` (one file: `node --test test/<file>.test.js`).
- No GitHub access in this sandbox: the issue is already copied into the item folder's spec.md.
MD
printf '# REVIEW\nImportant = breaks behaviour. Nits max 5.\n## Never dismiss\n- Public function signatures of src/calc.js\n' > REVIEW.md
cat > "$ITEM/spec.md" <<'MD'
---
item_id: 101
tracker: github
status: draft
---
# Spec — #101 Add subtract to calc
## Source
- **Type:** task   **State:** open   **Labels:** task
- **Issue:** https://github.com/example/calc/issues/101
### Acceptance criteria
1. `subtract(5, 3)` returns 2.
2. `subtract(a, b)` throws a TypeError when either argument is not a finite number.
3. `add` is unchanged.
### Goal of this run
deliver: design → plan → code → PR
MD
git add .
git commit -q -m init

if [ -n "$PHASE" ]; then
  git worktree add -q "$WT" -b "$BRANCH"
  cat > "$ITEM/plan.md" <<MD
---
item_id: 101
tracker: github
type: task
phase: $PHASE
worktree: $WT
branch: $BRANCH
base: main
test_mode: code-first
fix_cycles: 0
pr:
repos: [app]
prs: []
---
# Plan: Add subtract (from spec.md)
## Repos
- app: add subtract to src/calc.js
## Files that change
- src/calc.js — add subtract(a, b) with finite-number validation
## Order of work
1. Implement subtract in src/calc.js and export it.
## Proof
- app: \`node --test test/\`
- Build: n/a
MD
  GD="$(git -C "$WT" rev-parse --absolute-git-dir)"
  mkdir -p "$GD/dw"
  printf '{"item_id":"101","tracker":"github","issue_url":"https://github.com/example/calc/issues/101","type":"task","item_dir":"%s","worktree":"%s","branch":"%s","repo":"app"}\n' "$ITEM" "$WT" "$BRANCH" > "$GD/dw/item.json"
fi
