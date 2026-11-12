---
name: unlock-tests
description: Remove the dw test lock from the current item's failing tests when a test itself is wrong, recording the reason in plan.md. The unlock is gated by a hook that asks the user. Use only when the user says the test is wrong, or for "/dw:unlock-tests".
argument-hint: "<reason>"
disable-model-invocation: true
---

# /dw:unlock-tests $ARGUMENTS

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" status` — show the locked files.
2. A reason is required (`$ARGUMENTS`). If empty, ask for one sentence: why is the test wrong (not "the code is hard to make pass")?
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" unlock-tests --reason "<reason>"` — the hook asks the user; the reason is appended to plan.md.
4. Next: test-author fixes the test (it runs once and must still fail for the expected reason in test-first mode), then re-lock with `dw-state.js lock-tests <files>` (new hashes are taken then).

Not needed after the commit: `/dw:commit` releases the lock itself once the locked tests are committed unchanged.
