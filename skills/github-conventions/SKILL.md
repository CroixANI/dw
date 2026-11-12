---
name: github-conventions
description: GitHub facts for the dw workflow - reading issues, sub-issues and attachments, creating and editing issues and sub-issues, type labels, linking issues to commits and PRs - with the known gotchas. Use whenever a dw skill reads from or writes to GitHub issues.
user-invocable: false
---

# GitHub issue conventions

All calls go through `gh` from the **Bash** tool, with `--repo <host/owner/repo>` from `node "${CLAUDE_PLUGIN_ROOT}/scripts/dw-state.js" profile` (`gh_repo`, derived from `origin`; works for github.com and GitHub Enterprise). For `gh api`, pass `--hostname <host>` when the host is not github.com. Keep output compact: always `--json` + `--jq`.
Reads are free. **Every write to issues, labels, sub-issues or projects is gate 4** (a hook asks the user); show what you are about to write in ≤ 5 lines before the call. The GitHub MCP server, if installed, is gated the same way; prefer `gh`.

## Read an issue
- `gh issue view <n> --repo <r> --json number,title,body,labels,state,url,milestone,author,comments --jq '{number,title,state,url,labels:[.labels[].name],milestone:.milestone.title,body,comments:[.comments[]|{author:.author.login,body:.body[0:1500]}]}'`
- An issue URL gives host, owner, repo and number; if it points to another repo than `origin`, use that repo for every call and record the full URL in `spec.md`.
- Sub-issues (children): `gh api repos/<owner>/<repo>/issues/<n>/sub_issues --jq '.[]|{number,title,state}'`.
- Parent: `gh api graphql -F owner=<owner> -F name=<repo> -F n=<n> -f query='query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){parent{number title url}}}}' --jq .data.repository.issue.parent`.
- Linked PRs: `gh pr list --repo <r> --search "<n> in:body" --state all --json number,title,state,url`.

## Types (labels)
Personal repos have no issue *types*, so dw maps labels with `${user_config.type_labels}` (`type=label|label;...`; default `bug=bug;epic=epic;feature=enhancement|feature;task=task`). An issue with sub-issues is an `epic`. No match → ask the user; never guess. When dw creates an issue, it adds the first label of the type (creating a missing label is a separate gate-4 write: `gh label create <name>`; ask first).

## Attachments
Files and images in issue bodies/comments are links (`https://github.com/user-attachments/...`, `.../assets/...`, or `https://<host>/<owner>/<repo>/files/...`). Collect them from the body and comments, then download each into `<item>/documents/attachment-<n>/`:
- Public repo: `curl -fsSL -o "<file>" "<url>"`.
- Private repo or Enterprise: `curl -fsSL -H "Authorization: Bearer $(gh auth token --hostname <host>)" -o "<file>" "<url>"`. Never print or store the token.
Extract archives (`tar -xf` / `unzip -q`) into the same folder. Reading is not a write, so no gate.

## Create and edit (gate 4)
- New issue: write the body to a scratchpad file, then `gh issue create --repo <r> --title "<title>" --body-file <file> [--label <type label>]`. It prints the URL; take the number from it.
- Edit body: regenerate it to a file, `gh issue edit <n> --repo <r> --body-file <file>`. Comment: `gh issue comment <n> --repo <r> --body-file <file>`. dw never closes, reopens or relabels an issue unless the user asks.
- Sub-issue link (parent → child): the REST endpoint takes the child's numeric issue **id**, not its number:
  1. `gh api repos/<owner>/<repo>/issues/<child>  --jq .id`
  2. `gh api -X POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<id>`
  (GraphQL `addSubIssue` takes node ids instead: `--jq .node_id`.) If the endpoint returns 404 (older Enterprise server), fall back to a task list in the parent body (`- [ ] #<child>` lines, one `gh issue edit`) and tell the user.

## Linking
- Commit subject: `<summary> (#<n>)`. PR body first line: `Closes #<n>` (closes the issue on merge into the default branch) or `Refs #<n>` when the PR is only part of the issue. Cross-repo: `<owner>/<repo>#<n>`.
- Local items (`local-<n>`) have no issue: no ref in commits or PRs. If the user later wants an issue, create it (gate 4) and add its URL to `spec.md` `## Source`; the item id stays `local-<n>`.

## Gotchas
- `gh issue view --json comments` truncates nothing: cap bodies with `--jq` slices (`.body[0:1500]`) to protect context.
- `gh api` defaults to POST when `-f`/`-F` fields are given; pass `-X GET` for reads with parameters.
- Closing keywords work only in the PR body or commit messages that land on the default branch, not in PR titles.
- Rate limits: one batched read beats many small ones; never poll in a loop.
