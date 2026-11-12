---
name: start
description: Start work on a GitHub issue (number, #number or URL) or a free-text idea - reads the issue (or creates one, or a local item), creates the local item folder with spec.md (Source section), and routes by type - bug to investigation, feature to scoping, epic to splitting, task to delivery. Use when the user says "start", "work on", "pick up" or pastes an issue.
argument-hint: <issue number | #number | issue url | free text>
---

# /dw:start $ARGUMENTS

You are the orchestrator: keep your context small. Read the issue yourself (one call); delegate anything big.
`S` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js"`.

0. **Repo profile.** If the repo has no `.claude/dw.json`, say once that `/dw:setup-repo` can record its build/test/lint commands (built-in presets and the generic fallback work without it) and ask one `AskUserQuestion` (Set up now / Later). On "Set up now" invoke `dw:setup-repo` via the Skill tool, then continue here.
1. **Resolve the item.** From `$ARGUMENTS`:
   - `42`, `#42` or `https://<host>/<owner>/<repo>/issues/42` → GitHub issue (`tracker: github`). Read it per the `github-conventions` skill: title, state, body, labels, comments, sub-issues, milestone, attachments.
   - Free text (anything else) → one `AskUserQuestion` ("How should '<text>' be tracked?"):
     - **Create GitHub issue**: draft title + body (+ type label) from the text, show it, create it per `github-conventions` (`gh issue create`, gate 4), then continue as that issue.
     - **Local item, no issue**: `S next-local-id --root "${user_config.research_root}"` → `local-<n>` (`tracker: local`); the free text is the Source. Then ask the type (bug / feature / task) in one `AskUserQuestion`.
   - Nothing → ask for it.
2. **Type** (GitHub issue). Map its labels with `${user_config.type_labels}` (`type=label|label;...`, default `bug=bug;epic=epic;feature=enhancement|feature;task=task`). An issue with sub-issues counts as `epic`. No match or several matches → one question (bug / feature / task / epic).
3. **Item folder.** From the main checkout or any worktree of the repo:
   `S item-path --id <id> --title "<title>" --slug "<short description>" --root "${user_config.research_root}"`
   (an empty `--root` means `<parent of main checkout>/<family>-research` (family = checkout folder name up to the first `.`), outside the checkout). It reuses an existing folder for the same id. The folder is `<id>-<slug>`: write `<short description>` yourself, 3–5 plain words saying what the item is about (e.g. `dark mode toggle`, `retry on timeout`), not the title cut short. The script lowercases it and trims it to whole words.
4. **spec.md `## Source`.** If new, create `spec.md` from `${CLAUDE_PLUGIN_ROOT}/templates/item/spec.md`, filling the frontmatter (`item_id`, `tracker`, `status: draft`) and the `## Source` section only; leave `## Decisions` to `/dw:grill` (delete those headings from the new file). If it exists, append a dated `## Update <date>` section to Source only when the issue changed. Never rewrite history.
5. **Already delivered?** If `<item folder>/plan.md` has `phase: done`, this is a new iteration: skip the resume question and route as usual (task → `dw:deliver`, which starts the next iteration per its pipeline §0; for a bug/feature read `history.md` first). **Already in progress?** Otherwise, if `<item folder>/plan.md` exists, or `S find --id <id>` returns a worktree, ask one `AskUserQuestion` ("Resume <ref>?": Yes, resume (Recommended) / Not now); on Yes invoke `dw:resume` via the Skill tool instead of starting over.
6. **Route by type.** Tell the user which flow and why in one line, then **invoke the next skill yourself with the Skill tool** (args = the id). Never end the turn with "run /dw:xxx" for the user to type.
   | Type | Next |
   |---|---|
   | bug | `dw:investigate` — chain immediately (read-only); "implement option X" later enters `dw:deliver` (test-first) |
   | feature | `dw:scope` — chain immediately (read-only); it offers `dw:deliver` if single-task sized |
   | epic | `dw:split` — chain immediately; never implemented directly |
   | task | `dw:deliver` — the only route that leads to a worktree and code, so ask **one** `AskUserQuestion` first ("Start delivery of <ref>?": Yes, start (Recommended) / Not now). On Yes invoke `dw:deliver` straight away. |

`<ref>` is `#<n>` for an issue and `local-<n>` for a local item. A local item can get an issue later: create it per `github-conventions` (gate 4) and add its URL under `## Source`; the item id stays `local-<n>`.

An item may touch more than one repo (for example `api` and `web`): that is decided in the plan (`## Repos`), and `/dw:deliver` creates and binds the other repo after approval; nothing to do here. When resuming (step 5) `S find` also lists the bound repos.

Related items having worktrees is not a reason to stop; mention it in one line only if relevant.
Do not create worktrees or edit code in this skill itself; the chained skills do that, behind their own gates. The only write here is the optional issue creation (gate 4).
Folder layout and file roles: `references/item-folder.md`.
