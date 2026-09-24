# Issue tracker: GitHub

Issues, specs and implementation tickets live in this repository's GitHub Issues. Run the `gh` CLI from a checkout of the repository; if the checkout has several remotes, choose the upstream once with `gh repo set-default`.

## Conventions

- Create an issue: `gh issue create --title "..." --body-file <file>`.
- Read an issue: `gh issue view <number> --json number,title,body,labels,comments,state`.
- List issues: `gh issue list --state open --json number,title,body,labels,comments`, with the relevant label and state filters.
- Comment on an issue: `gh issue comment <number> --body-file <file>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close an issue: `gh issue close <number>`.

For multiline bodies and comments, write the exact Markdown to a temporary file and pass `--body-file`; preserve real newlines and literal code. Consult `docs/agents/triage-labels.md` for the canonical label mapping.

When a skill says **publish to the issue tracker**, create a GitHub issue. When it says **fetch the relevant ticket**, read the issue body, labels and comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

If this flag is explicitly changed to `yes`, use the equivalent `gh pr` operations and the same triage labels. Read both the PR discussion and diff. Include external authors with association `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR` or `NONE`; exclude `OWNER`, `MEMBER` and `COLLABORATOR` from the external request queue.

GitHub shares one number space across issues and PRs. For an ambiguous reference, resolve its type before operating on it.

## Wayfinding operations

Used by `wayfinder`: the map is one issue, and its children are decision or implementation tickets.

- **Map:** an issue labelled `wayfinder:map`, containing Notes, Decisions-so-far and Fog.
- **Child:** link it as a GitHub sub-issue. If sub-issues are unavailable, use a task list in the map body and `Part of #<map>` at the top of the child body. Label it `wayfinder:<type>`, where type is `research`, `prototype`, `grilling` or `task`.
- **Blocking:** use GitHub native issue dependencies. Add an edge with `gh api --method POST 'repos/{owner}/{repo}/issues/<child>/dependencies/blocked_by' -F issue_id=<blocker-db-id>`; `gh api` fills `{owner}` and `{repo}` from the checkout. Obtain the numeric database ID with `gh api 'repos/{owner}/{repo}/issues/<blocker>' --jq .id`; it is different from the issue number and `node_id`.
- **Fallback:** if native dependencies are unavailable, put `Blocked by: #<n>, #<n>` at the top of the child body. A ticket is unblocked only when all blockers are closed.
- **Frontier:** enumerate the map's open children, excluding assigned tickets and those with open blockers. Use `issue_dependencies_summary.blocked_by` when available, otherwise resolve each textual blocker. Select the first eligible ticket in map order.
- **Claim:** assign the selected ticket to the driving developer with `gh issue edit <number> --add-assignee @me` when that is the intended assignee.
- **Resolve:** post the answer, close the child, then append a concise result and child link to the map's Decisions-so-far.
