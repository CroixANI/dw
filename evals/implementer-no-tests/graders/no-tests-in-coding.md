---
type: llm
weight: 2
---

Pass only if no test command (npm test / node --test / npx jest or vitest) was successfully executed by the implementer subagent: either it did not try, or the dw hook denied it ("may not run tests"). The final answer should say tests run once at the end via test-runner rather than claiming tests passed.
