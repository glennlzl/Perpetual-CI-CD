# Autopilot

Autopilot is a stage's standing permission to make changes for the repository on its own: fix a failed build or deployment, update dependencies, resolve a dependency conflict, follow a runtime deprecation. Every change is a pull request on a branch of the pipeline's own, verified by the stage before it merges. The interface is in place ([Pipeline interface](../pipeline-ui.md#autopilot)) and renders whatever the controller records; this document is the controller's design and the order to build it in. The decision it rests on is [ADR 0002](../adr/0002-autopilot-merges-verified-changes.md).

## Principles

- **A change is a pull request.** Autopilot never commits to the target branch. A change lives on `perpetual/<kind>-<sha7>` and reaches the target branch only through GitHub's merge API, so branch protection, required checks and review rules apply to Autopilot as they do to anyone.
- **The stage verifies, then Autopilot merges.** Build verifies with the pull request's checks, Production with the deployment the provider records for the pull request's head, and later a Sandbox stage with the journey gate at that head. A change never turns a failed gate into a passed one; the merged commit runs the stage again like any push.
- **Two modes per stage**, saved with the pipeline: `merge` (the default) merges once verified; `ask` stops at the open pull request, which then reads `Needs review` until a person merges or closes it on GitHub.
- **The agent edits; the controller runs.** A change's code is written by an OpenCode agent with edit permission in a private worktree and nothing else, the way journey code and twin configs are written today (`src/agents/opencode.ts`). Installs, builds and tests run in a container through the twin runtime (`src/twin/runtime.ts`), never on the host: an `npm install` executes lifecycle scripts, and repository discovery already promises to run no project script on the host.
- **Detection is free, authoring costs a model call.** Signals come from GitHub reads that cost a `304` when nothing changed and from ecosystem commands in a container. The model runs only once a change has a trigger and a plan.
- **Bounded.** One change per stage at a time, three authoring attempts per change, ten minutes per attempt, and a change that cannot be verified or merged ends as `Not merged` with its reason and its pull request left open.
- **Nothing product-specific.** Triggers, commands and prompts come from what the scan detected (package manager, workflows, deployment targets), never from a particular application.

## Components

```
src/autopilot/
  manager.ts    the loop: triggers → changes → steps, persisted, one worker per stage
  triggers.ts   what starts a change: failed run, failed deployment, alerts, outdated, bot pull requests
  workshop.ts   a private worktree of the managed source, container commands, commit and push
  author.ts     the OpenCode fixer: prompt, permissions, attempt feedback, provenance
  github.ts     pull requests, check runs, merge, through the signed-in GitHub CLI
  rules.ts      pure: step order, states, badge view, mode validation, retention
  view.ts       GET /api/autopilot and the state's autopilot field
```

The manager mirrors `src/gate/manager.ts`: a `createAutopilotManager({ dataDir, source, github, steps })` with seams for GitHub and for the steps, so tests drive it with fakes; records in `<data>/autopilot/state.json` through `src/store.ts` (private directory, guarded read, atomic write, save queue) with its own restart recovery; `idle()` and `close()` for tests and shutdown.

### Workshop

A change works in `git worktree add <data>/autopilot/work/<change-id> <sha>` off the managed source copy (`src/github-source.ts`), which already holds the commit. The user's own checkout is never touched. Commits carry the connected account's noreply identity and a message that names the change. Pushes use gh's credential helper (`git -c credential.helper='!gh auth git-credential' push origin HEAD:refs/heads/perpetual/…`), the mechanism `gh auth setup-git` installs, so no token is ever written by Perpetual. A push GitHub refuses for a workflow file (the token lacks the `workflow` scope) ends the change as `Not merged` with that reason.

Container commands run through the twin runtime's `run(image, args)` with the worktree mounted and the package cache volume attached, the same way fixtures run today. The image and commands follow the detected ecosystem: `npm ci` and `npm test` for a Node repository with a lockfile, `pnpm`, `yarn`, `pip`, `cargo` or `go` likewise; a repository with no recognised toolchain skips the local check and verifies on GitHub alone.

### Author

The fixer is an OpenCode primary agent like the journey generator: its own HOME, only the OpenRouter key from Settings, `permission: { edit: allow (worktree only), bash: deny, webfetch: deny, external_directory: deny }`. Its prompt holds the trigger's evidence (the failed job's log lines as `src/providers.ts` already extracts them, the alert, the outdated list, the conflict), the plan, and the previous attempt's failure when there is one. The controller owns the attempt loop as `src/environments/generation.ts` owns the twin config loop: author, run the local check in a container, feed the failure back, at most three times. Every attempt is redacted with the existing helpers before it is stored or shown.

### GitHub

All writes go through `gh api` with the connected session, run through `src/github-cli.ts` (one environment, runner, reply parser and failure classifier for every gh call) as `src/gate/github.ts` posts commit statuses: `POST /repos/{r}/pulls`, `PUT /repos/{r}/pulls/{n}/merge` (`merge_method` from the repository's allowed methods, squash first), `PATCH` to close a superseded pull request. Reads reuse `githubRequest` with ETags: check runs and statuses for a head (`/commits/{sha}/check-runs`, `/commits/{sha}/status`), workflow runs for a head (`/actions/runs?head_sha=`), deployments for a head (`src/github-deployments.ts`), open pull requests, Dependabot alerts. A `405` or `403` on merge is branch protection or a missing permission: the change ends `Needs review` with GitHub's message.

## The change loop

Each change records the five steps the interface shows, with the facts each step is allowed to state. Step names differ by trigger; states are `pending`, `active`, `done`, `failed` and `waiting`.

| Step | Reactive (a failure) | Proactive (a signal) | Facts in the detail |
| --- | --- | --- | --- |
| 1 | Read the failure | Found | failed job and step, log line; alert id, package, count |
| 2 | Diagnose | Plan | the cause in one line; the versions to move |
| 3 | Change | Change | files, `+n −m`, branch, local check result |
| 4 | Verify | Verify | check names and result, deployment environment, gate |
| 5 | Merge | Merge | pull request number and target, or why it waits |

States: a change is `running` from step 1; `merged` when step 5 merged; `needs-review` when the mode is `ask`, protection refused the merge, or verification could not conclude in time; `not-merged` when authoring or verification failed after its attempts. A `needs-review` change keeps polling its pull request and ends `merged` or `not-merged` when a person merges or closes it.

Concurrency: one change per stage at a time; a new trigger for a stage with a running change is queued and dropped if the same trigger is already queued. A trigger for a commit the target branch has moved past is dropped, so a change always targets the branch head.

## Triggers and verification

| Stage | Trigger | Read from | Kind, title | Verified by |
| --- | --- | --- | --- | --- |
| Build | a workflow run for the head failed | `/actions/runs?head_sha=`, then `gh run view --log-failed` and `diagnoseFailure` | `fix`, Fixing build | the pull request's checks all succeed |
| Build | a run annotation warns of a deprecated action or runner | check-run annotations for the head | `runtime`, Updating actions | checks |
| Build | an open Dependabot or Renovate pull request | `/pulls?state=open` by bot author | `update`, Updating dependencies (adopted) | its own checks; a conflict is rebased and its lockfile regenerated in a container |
| Build | a Dependabot alert | `/dependabot/alerts?state=open`, when the session may read them | `update`, Fixing a vulnerability | checks |
| Build | outdated packages, once a day | the ecosystem's outdated command in a container | `update`, Updating dependencies | checks |
| Production | a deployment for the head failed | `src/github-deployments.ts` | `fix`, Fixing deployment | a successful deployment recorded for the pull request's head |
| Production | a runtime the provider deprecates | the failed deployment's description and the config files | `runtime`, Updating runtime | as above |

Verification waits for the head's checks with an ETag poll every 15 seconds up to 30 minutes, then `needs-review`. Major version updates take the `ask` path until a Sandbox stage can verify a pull request head with the journey gate (phase 4), because a green build alone rarely proves a major upgrade.

## Data

`<data>/autopilot/state.json` holds, per pipeline key: `modes: Record<stageId, 'merge' | 'ask'>`, `changes: Change[]` and `seen` (the last head, run ids, alert numbers and pull requests handled, so a trigger fires once). A change is the client's `AutopilotChange` plus `key`, `sha`, `branch`, `trigger`, `attempts` and `provenance { harness, model }`. The newest 50 changes per pipeline are kept; the view lists a stage's running changes and its changes ended within the last day, newest first.

## Routes

- `GET /api/autopilot?repoPath=` returns the contract's `AutopilotView` (`contract/autopilot.ts`), `{ repoPath, stages: { [stageId]: { mode, changes } } }`, for the active source; `409` when `repoPath` is not the active source, through the controller's `withActiveScan` like the other per-source reads.
- `POST /api/autopilot/mode` with `{ repoPath, stageId, mode }` saves a stage's mode, validated as `unknown`.
- `GET /api/state` carries the same view as `autopilot`; its presence is what enables the interface.
- `POST /api/autopilot/check` with `{ repoPath, stageId }` runs the stage's triggers now (a **Check now** action, phase 2).

## Phases

1. **Skeleton and the Build fix.** The manager, its state file and restart recovery; the view and mode routes; the workshop (worktree, container check, commit, push); the fixer agent with the attempt loop; pull request, check polling and merge; the failed-run trigger. Tests: rules and view; the manager with fake GitHub, fake author and fake workshop through every end state; the workshop's git and container commands with a recorded runner; the routes. This phase makes the interface real end to end for one kind of change.
2. **Dependencies.** Adopted bot pull requests, with rebase and lockfile regeneration in a container; Dependabot alerts; the daily outdated check; **Check now**. Tests per trigger with recorded GitHub replies and container output.
3. **Production.** The failed-deployment trigger, config changes, verification by the recorded deployment for the pull request's head, runtime deprecations.
4. **The gate at a pull request head.** The gate manager learns to build a twin at a commit that is not on the target branch and to report `perpetual/<Stage>` on it, so Sandbox stages verify changes before they merge and major updates leave the `ask` path. This changes `docs/gate.md` and the watcher, and gets its own ADR.

## Failure handling and limits

- A controller restart ends a running change's active step as failed with `The controller stopped during this change.`, keeps its branch and pull request, and reports it `not-merged`; nothing is retried on its own.
- A worktree is removed when its change ends; a branch is deleted after its pull request merges, never while the pull request is open.
- A repository without a GitHub connection, or a session without write access, records no changes and shows the modes only; the first refused write ends the change with the message the gate uses for the same refusal.
- Rate limits and network failures pause polling with the gate's backoff; they never end a change.
- Logs and agent output are redacted before storage with the existing helpers, and the OpenRouter key reaches only the OpenCode process.
