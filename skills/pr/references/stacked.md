# Stacked PRs with `gh stack`

Use when plan.md `## PR split` defines layers. One PR per bounded concern; never mix unrelated changes in a layer.
`gh stack` is an optional `gh` extension: if `gh stack --help` fails, say so and offer plain stacked branches instead (each layer's PR based on the branch below, opened with `/dw:pr` steps 2–4 per layer).

## Inspect first (before any stack mutation)
1. `git rev-parse --show-toplevel` — must be this item's worktree (`dw-state.js status`).
2. `git status --short` · `git branch --show-current` · `git remote -v`
3. `gh stack view --json` (fallback `gh stack view`)
Report: worktree vs expected, current branch, stack detected?, bottom/top branch, existing PRs, uncommitted changes, recommended next action. If the state is unclear or the worktree doesn't match, stop and ask.

## Decide
- Reuse the existing stack if lineage and scope match; otherwise a new stack. Define branch and PR order per layer (layer 1 = foundation).

## Commands
- Add layer: `gh stack add <branch-name>` · navigate: `gh stack top|bottom|up|down` · rebase: `gh stack rebase`
- Push branches: `gh stack push` (prefer over raw `git push`) — **gate 3**
- Create/update PRs: `gh stack submit` — **gate 3**
- Each layer's body: the normal PR template (`/dw:pr` step 2) with a Why/What scoped to that layer and a diagram of only that layer's slice, plus `Depends on: #<n>` of the layer below. Layer 1 carries the feature-level Why; later layers link back to it. Only the top layer says `Closes #<issue>`; lower layers say `Refs #<issue>`. Title `<Area>: <layer summary>`.
- Never force-push manually unless the user asks explicitly.

## URL rules (anti-hallucination)
- A stack is an ordered set of PRs, not one URL. Report bottom PR, top PR and the ordered list from `gh stack view` / `gh pr view --json url`.
- Never construct URLs like `/stacks/<id>` unless a command printed it.

## Output
Stack decision (reuse/new), ordered branch list, ordered PR URLs, risks and rollback plan (which layer can be reverted independently).
