# GraphQL for the PR sweep (gh api graphql)

Host: from the PR's `gh_repo` (`dw-state.js repos`; `host/owner/repo`, e.g. `github.com/octo/app`); pass `--hostname <host>` (needed for GitHub Enterprise, harmless for github.com).

## Unresolved threads (read — no gate)
```
gh api graphql --hostname <host> -F owner=<owner> -F name=<repo> -F pr=<n> -f query='
query($owner:String!,$name:String!,$pr:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$pr){
  reviewThreads(first:100){ nodes{ id isResolved isOutdated path line
    comments(first:1){ nodes{ author{login} body url } } } } } } }' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved|not) | {id,path,line,outdated:.isOutdated,author:.comments.nodes[0].author.login,body:(.comments.nodes[0].body[0:400])}'
```

## Reply to a thread (write — gate 3)
```
gh api graphql --hostname <host> -f threadId=<id> -f body='<reply>' -f query='
mutation($threadId:ID!,$body:String!){ addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){ comment{ url } } }'
```

## Resolve a thread you fixed (write — gate 3)
```
gh api graphql --hostname <host> -f threadId=<id> -f query='
mutation($threadId:ID!){ resolveReviewThread(input:{threadId:$threadId}){ thread{ isResolved } } }'
```
Keep each call a single command (no pipes); `--jq` filters inside gh.
