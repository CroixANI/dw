#!/usr/bin/env bash
set -euo pipefail
bash "$(dirname "$0")/../_fixtures/make-toy.sh" commit
printf "\nfunction subtract(a, b) {\n  return a - b;\n}\nmodule.exports.subtract = subtract;\n" >> app-worktrees/101-add-subtract/src/calc.js
