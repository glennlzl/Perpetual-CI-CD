# Changelog

## 0.1.0 — unreleased

The first public release: a local, single-user control room that runs on your machine and binds only to loopback.

### Pipeline

- Repository discovery without executing project scripts or reading `.env` files: packages and configuration, GitHub workflows, jobs and steps, services, workspace dependencies, and Vercel and Railway clues.
- A Pipeline canvas of Source → Build & Deploy → Production, with Sandbox stages such as Beta and Gamma, stage status Badges, GitHub Actions results for the scanned commit, and saved transition controls. See [Pipeline interface](docs/pipeline-ui.md).
- A GitHub connection through the local GitHub CLI session or browser device sign-in, repository and branch selection with a managed source checkout, and a Git graph of real commits and branch refs.
- Read-only GitHub, Vercel and Railway adapters, failed-run diagnosis, and a starter CI workflow for repositories without one.

### Business journeys

- Reviewed browser journeys with ordered business milestones, independent checks and fixed expected outcomes, run as approved Playwright code in a dedicated local Chromium against any application URL, with no model at run time and no automatic retries. See [Business journeys](docs/journeys.md).
- Discovery of journey drafts by a local Browser Use agent from the running application and bounded source context, drafting from a typed or dictated description, and review before anything runs.
- Journey code: Playwright's generator agent, run by OpenCode, writes a reviewed journey's actions as a draft beside the approved code. A person approves it, seeing the code or its diff, after it passes three runs and a control run with every write blocked, including what a page sends over a WebSocket once the journey acts, in which a reviewed check fails. A control run that a write could get around is inconclusive rather than missed. See [ADR 0001](docs/adr/0001-gate-runs-approved-playwright-code.md).
- Code approved without the four runs of a verification, as it was after a single passing run before verification existed, loads as a draft, and a control run verifies only after its three passing runs, so a gate never runs unverified code.
- Parallel journeys with shared-data scheduling, test accounts, skip and stop, live frames, recordings and one controller-owned verdict.
- App-wide OpenRouter model settings.

### Twins and the journey gate

- Twins: a Sandbox stage's application environment as a Docker Compose project running the product's actual code, with services from official local or sandbox modes (PostgreSQL, Redis, MongoDB, Mailpit, a real LLM, generated secrets, Supabase, Stripe, Trigger.dev) and `vercel-labs/emulate` where no official mode exists. Stripe takes the user's test keys or a Stripe sandbox that Perpetual creates on request, without a Stripe account, and renews before it expires. See [Twins](docs/twins.md).
- The journey gate: for each push to the target branch, or on **Run now**, rebuild the stage's twin at that commit, replay its reviewed journeys' approved code and report a `perpetual/<stage>` GitHub commit status, with release and promotion to the next stage. See [Journey gate](docs/gate.md).

### Other

- TypeScript in strict mode throughout, run directly by Node.js 24.12+'s type stripping with no build step for the controller; `npm run typecheck` checks both projects.
- An experimental Cua desktop sandbox for desktop applications, through the `perpetual sandbox` CLI. See [Desktop sandbox](docs/desktop-sandbox.md).
- Licensed under AGPL-3.0-only, with a Contributor License Agreement for pull requests.
