# Changelog

## 0.1.0 — unreleased

The first public release: a local, single-user control room that runs on your machine and binds only to loopback.

### Pipeline

- Repository discovery without executing project scripts or reading `.env` files: packages and configuration, GitHub workflows, jobs and steps, services, workspace dependencies, and Vercel and Railway clues.
- A Pipeline canvas of Source → Build & Deploy → Production, with Sandbox stages such as Beta and Gamma, stage status Badges, GitHub Actions results for the scanned commit, and saved transition controls. See [Pipeline interface](docs/pipeline-ui.md).
- A GitHub connection through the local GitHub CLI session or browser device sign-in, repository and branch selection with a managed source checkout, and a Git graph of real commits and branch refs.
- Read-only GitHub, Vercel and Railway adapters, failed-run diagnosis, and a starter CI workflow for repositories without one.

### Business journeys

- Reviewed browser journeys with ordered business milestones, independent checks and fixed expected outcomes, run by a local Browser Use worker in a dedicated Chromium against any application URL. See [Business journeys](docs/journeys.md).
- Discovery of journey drafts from the running application and bounded source context, drafting from a typed or dictated description, and review before anything runs.
- Parallel journeys with shared-data scheduling, test accounts, skip and stop, live frames, recordings and one controller-owned verdict.
- An opt-in Playwright engine that runs approved, generated specs without a model, and code generation with Playwright's generator agent through OpenCode.
- App-wide OpenRouter model settings.

### Twins and the journey gate

- Twins: a Sandbox stage's application environment as a Docker Compose project running the product's actual code, with services from official local or sandbox modes (PostgreSQL, Redis, MongoDB, Mailpit, a real LLM, generated secrets, Supabase, Stripe, Trigger.dev) and `vercel-labs/emulate` where no official mode exists. See [Twins](docs/twins.md).
- The journey gate: for each push to the target branch, or on **Run now**, rebuild the stage's twin at that commit, run its reviewed journeys and report a `perpetual/<stage>` GitHub commit status, with release and promotion to the next stage. See [Journey gate](docs/gate.md).

### Other

- An experimental Cua desktop sandbox for desktop applications, through the `perpetual sandbox` CLI. See [Desktop sandbox](docs/desktop-sandbox.md).
- Licensed under AGPL-3.0-only, with a Contributor License Agreement for pull requests.
