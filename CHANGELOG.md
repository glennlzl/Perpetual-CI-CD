# Changelog

## 0.1.0 — unreleased

The first public release: a local, single-user control room that runs on your machine and binds only to loopback.

### Pipeline

- Repository discovery without executing project scripts or reading `.env` files: packages and configuration, GitHub workflows, jobs and steps, services, workspace dependencies, and Vercel and Railway clues.
- A Pipeline canvas of Source → Build → Production, with Sandbox stages such as Beta and Gamma, stage status Badges, GitHub Actions results for the scanned commit in Build, the repository's deployment targets in Production, and saved transition controls. See [Pipeline interface](docs/pipeline-ui.md).
- A GitHub connection through the local GitHub CLI session or browser device sign-in, repository and branch selection with a managed source checkout, and a Git graph of real commits and branch refs.
- Read-only GitHub, Vercel and Railway adapters, failed-run diagnosis, and a starter CI workflow for repositories without one.

### Business journeys

- Reviewed browser journeys with ordered business milestones, independent checks and fixed expected outcomes, run as approved Playwright code in a dedicated local Chromium against any application URL, with no model at run time and no automatic retries. See [Business journeys](docs/journeys.md).
- Discovery of journey drafts by a local Browser Use agent from the running application and bounded source context, drafting from a typed or dictated description, and review before anything runs.
- Journey code: Playwright's generator agent, run by OpenCode, writes a reviewed journey's actions as a draft beside the approved code. A person approves it, seeing the code or its diff, after it passes three runs and a control run with every write blocked, including what a page sends over a WebSocket once the journey acts, in which a reviewed check fails. A control run that a write could get around is inconclusive rather than missed. See [ADR 0001](docs/adr/0001-gate-runs-approved-playwright-code.md).
- Code approved without the four runs of a verification, as it was after a single passing run before verification existed, loads as a draft, and a control run verifies only after its three passing runs, so a gate never runs unverified code. A draft keeps its latest verification's record, so the verdict outlives the run history, and a verification holds its twin from its first attempt to its last.
- Run-unique values: journey code types data with the run's token, `journey.run`, and a reviewed check names it as `{run}`, so a control run never passes on a value an earlier run stored. Text checks also read the values the application put in visible form fields; approvals record the check version their control run was caught under. See [Run-unique values](docs/journeys.md#run-unique-values).
- A stage's sign-in page, where `journey.signIn()` signs in when the application URL shows no sign-in form; discovery records where its account signed in. Code generation first checks that the test account can sign in, before any model call.
- Parallel journeys with shared-data scheduling, test accounts, skip and stop, live frames, recordings and one controller-owned verdict.
- App-wide OpenRouter model settings.

### Twins and the journey gate

- Twins: a Sandbox stage's application environment as a Docker Compose project running the product's actual code, with services from official local or sandbox modes (PostgreSQL, Redis, MongoDB, Mailpit, a real LLM, generated secrets, Supabase, Stripe, Trigger.dev) and `vercel-labs/emulate` where no official mode exists. Stripe takes the user's test keys or a Stripe sandbox that Perpetual creates on request, without a Stripe account, and renews before it expires. Apps run on the Node.js major the repository declares. See [Twins](docs/twins.md).
- Generated twin configs: when a stage's config is still the detected skeleton and App Settings has a model, an agent writes the config from the repository's evidence, and the controller keeps it only once the twin it describes is ready, every app answers and a test account exists. See [Generated twin config](docs/twins.md#generated-twin-config).
- The journey gate: for each push to the target branch, or on **Run now**, rebuild the stage's twin at that commit, replay its reviewed journeys' approved code and report a `perpetual/<stage>` GitHub commit status, with release and promotion to the next stage. A local checkout's gate rebuilds only while the checkout is at the tested commit without uncommitted changes. See [Journey gate](docs/gate.md).

### Other

- TypeScript in strict mode throughout, run directly by Node.js 24.12+'s type stripping with no build step for the controller; `npm run typecheck` checks both projects.
- An experimental Cua desktop sandbox for desktop applications, through the `perpetual sandbox` CLI. See [Desktop sandbox](docs/desktop-sandbox.md).
- Licensed under AGPL-3.0-only, with a Contributor License Agreement for pull requests.
