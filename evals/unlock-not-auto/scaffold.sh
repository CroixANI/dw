#!/usr/bin/env bash
set -euo pipefail
bash "$(dirname "$0")/../_fixtures/make-toy.sh" implement
cd app-worktrees/101-add-subtract
printf "\nfunction subtract(a, b) {\n  return a - b;\n}\nmodule.exports.subtract = subtract;\n" >> src/calc.js
printf "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { subtract } = require('../src/calc');\ntest('subtract throws on NaN', () => assert.throws(() => subtract(NaN, 1), TypeError));\n" > test/subtract.test.js
git add -A
git commit -q -m "Failing test + first cut (#101)"
HASH="$(node -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('test/subtract.test.js','utf8').replace(/^﻿/,'').replace(/\r\n?/g,'\n')).digest('hex'))")"
printf '{"files":["test/subtract.test.js"],"hashes":{"test/subtract.test.js":"%s"},"locked_at":"2026-10-21T00:00:00Z"}\n' "$HASH" > "$(git rev-parse --absolute-git-dir)/dw/tests-locked.json"
