# Business journeys

A business journey is a complete user flow, from entry and prerequisites to a business outcome, run in a real browser against a running application. For a Next.js app with Supabase and Stripe, one journey might sign in, choose a plan, pay in Stripe test mode, return to the app and check that the account shows the new plan. Beta and Gamma (Sandbox) stages hold a stage's journeys.

The controller owns every verdict. A successful click, an agent's completion claim or a recording is never a pass on its own, and an application environment that is Ready says nothing about whether a journey passes.

Each journey has a reviewed goal, preconditions, ordered business milestones, fixed expected outcomes and independent checks. At run time the actions come from one of two engines:

- **Browser Use** (the default): a model-driven agent in a dedicated local Chromium decides each action from the current page.
- **Playwright** (opt-in): an approved, generated spec performs the actions with no model. See [Playwright engine](#playwright-engine).

The design is recorded in [Browser-first business testing](architecture/browser-first.md), [Journey contract](architecture/journey-contract.md) and [Playwright journeys](architecture/playwright-journeys.md).

## Install

Use Node 22 or later, Python 3.11–3.13 and [uv](https://docs.astral.sh/uv/). Install the browser runtime separately:

```sh
uv sync --project integrations/browser-use --frozen
uv run --project integrations/browser-use python -m playwright install chromium
npm run build
```

Linux hosts may also need Chromium's system libraries (`python -m playwright install-deps chromium` with the installed interpreter). `PERPETUAL_BROWSER_PYTHON` can name an absolute Python executable that has the pinned browser dependencies. Do not use a personal browser profile or production login state.

## Configure a model

Open the app-wide **Settings** page from the sidebar. Enter an **OpenRouter API Key** and choose a model; the list comes from OpenRouter's catalog of models that take text and images and support tools, and the saved model, else `openai/gpt-5.4-mini`, is preselected when the catalog has it. Or export the settings before starting the controller:

```sh
export OPENROUTER_API_KEY='your-key'
export PERPETUAL_MODEL='openai/gpt-5.4-mini'                   # optional
export PERPETUAL_MODEL_BASE_URL='https://openrouter.ai/api/v1'  # optional
node src/cli.mjs serve --repo /absolute/path/to/your/repo
```

`PERPETUAL_MODEL_API_KEY` with `PERPETUAL_MODEL` and `PERPETUAL_MODEL_BASE_URL` selects another OpenAI-compatible endpoint. Saved settings take precedence over the environment. They are stored in the controller's data directory with mode 0600, and no response returns the key.

The model receives the task, bounded source excerpts, requirements and observed page content. Discovery and Browser Use runs use the configured model. Drafting a journey from a description, dictation and code generation need an OpenRouter key and model in Settings, and use OpenRouter credits.

## Where journeys run

A stage's journeys run against one application URL, set beside the stage's application link.

| Situation | What is needed |
| --- | --- |
| An existing preview or Beta URL | The test browser only |
| An application already running on localhost | The test browser only |
| Source exists but the app is not running | A [twin](twins.md) of the stage, or the app and its dependencies started some other way |
| An independent, resettable database is needed | A twin, which starts its services from scratch |

A twin's data persists between runs until the twin is rebuilt; the [journey gate](gate.md) rebuilds it for every commit it tests.

When a new twin is Ready and a person has not chosen another URL, the target becomes the twin's one web-frontend app, or else its only app; otherwise a person chooses. A newly ready twin also prepares journey drafts once, when a model, the browser runtime and an unambiguous URL are available and the stage has no tests yet. Missing setup stays visible without failing the twin. Opening a page or restarting the controller never starts this paid discovery again.

A fresh browser context resets cookies and storage, not database rows or external service state. Browser navigation is limited to the application's origins plus, for runs, the stage's reviewed external origins; that is not network isolation, and application assets and API requests can still reach the application's configured dependencies.

## Workflow

1. Open **Integration tests** on a Beta or Gamma stage and set the application URL.
2. Choose **Generate** to explore the application, optionally with a test focus. The agent receives bounded, redacted source context sampled across UI, API, product documentation and shared code, and proposes up to four journeys as unselected drafts. Generate can replace the current tests after a successful, nonempty discovery; a failed or empty replacement keeps them. To add one journey instead, choose **Add test**, enter its **Description** (typed, or dictated with **Dictate**) and choose **Generate test**. This turns the description and source context into one draft without opening the application.
3. Review the draft's goal, preconditions, milestones, checks and expected outcomes, then save. Add missing account or fixture requirements. Cases need no CSS selectors or authored click steps.
4. Select reviewed journeys and run them. The run dialog's **Test account** offers the twin's test accounts (the first by default), a manually entered account, or none; without twin accounts, **Use test account** takes a manually entered one. Entered values stay in the dialog for one request. When the selected journeys all have current Playwright code, approved or draft, the dialog also offers the **Engine**, and they can run with Playwright even without a model. Closing the live viewer does not cancel the run; **Stop** does.
5. Read the result. Independent checks decide it; a journey with no executable checks stays **Needs review**.

**Add test** appears only on Sandbox stages. A stage holds at most 60 cases; a run takes 1 to 30 of them.

**Dictate** records a description after microphone permission. **Stop** sends the recording through the local controller to OpenRouter's transcription endpoint and appends the transcript to the editable description. Audio is not written to application storage. Recording stops automatically at two minutes and is capped at 8 MiB; closing the dialog discards an unfinished recording and cancels a pending transcription. Typing stays available when the browser cannot use a microphone.

## Cases and milestones

A reviewed case has a name, goal, preconditions, expected outcomes, final assertions, `isolation` (`shared` by default, or `isolated`) and ordered milestones, `steps: [{id, title, checks?}]`. A case saved as reviewed needs 2 to 12 milestones, unless it is identical to a stored case from before milestones (selecting or deselecting it is allowed). Generated and drafted cases always stay drafts until a person saves a review; generation never approves or runs them.

A milestone may carry up to 6 checks, which the runner evaluates itself on the live page when the milestone is reached; the model never supplies the observed value:

- `url-contains`, `text-visible` or `text-absent`, with a `value`;
- `read-number` with a `label` and a `name`: captures the number shown after the visible label;
- `compare-number` with `label`, `name`, `op` (`<`, `>`, `=` or `!=`) and `than`, the name of a `read-number` from an earlier milestone or earlier in the same one.

Final assertions (`url-contains`, `text-visible`, `text-absent`) describe the page the journey ends on. These checks observe page text and URLs; they do not independently prove database persistence, payment settlement or email delivery.

## Discovery

Discovery explores the target read-only: the browser blocks mutating HTTP requests. With a test account, discovery may also sign in, and may POST to up to three configured auth endpoints on the application host, each with a path other than `/`; a twin's test account supplies its own sign-in endpoint. The result records whether it signed in. Without an account, authenticated screens can stay unexplored; such gaps become preconditions, not invented coverage.

Source evidence is limited to supplied repository paths and line numbers; a citation of a line that was not supplied is dropped. A journey that is invalid for another reason is left out and named, with its reason, at the end of the discovery summary (at most 4000 characters). Discovery fails when it accepts no journey and either proposed one or was replacing tests; existing tests are kept.

Source and page text are untrusted content: they cannot authorize tools or change expected outcomes.

## Runs

- **Concurrency.** A run takes `concurrency` 1 to 4 (default 2). Each journey has its own browser worker, session, frames and progress. Journeys with shared test data run one at a time; only journeys a person marked `isolated` can overlap. A single test account forces serial scheduling. A fresh browser profile does not isolate balances, subscriptions or other backend state.
- **Time and budget.** `journeyTimeoutSeconds` is 60 to 1800 (default 900) per journey. The Browser Use action budget is the stage's `maxSteps` (1 to 100, default 60) plus one per milestone, at most 112.
- **Origins.** Runs may also open up to 10 reviewed `externalOrigins`: HTTPS origins with no path, query or credentials, such as a Stripe checkout. On Stripe pages the browser acts only in test mode (a `cs_test_` or `/test_` path, or Stripe's test-mode banner); a `cs_live_` or `/live_` path is always refused.
- **Blocked services.** A twin service that is blocked for missing inputs is passed to the run; a milestone that needs it is reported blocked, never failed.
- **Skip and stop.** A queued journey can be skipped without launching. An active journey becomes `skipping` until its worker has cleaned up, then `skipped`; other journeys keep their results. Skipping cannot undo actions already performed. **Stop** cancels the whole run. Uncertain browser cleanup quarantines the twin.
- **Restart.** After a controller restart, journeys that never started become `cancelled`, running ones `failed`, and skipping ones `skipped`; a milestone still `running` becomes `unconfirmed`.

Drafts and case saves can happen during a run, because a run uses its own snapshot of the reviewed cases; they cannot overlap discovery or another case write. Each run keeps that snapshot, so historical results stay tied to the exact reviewed case.

### Test accounts

Runs and discovery accept either a run-only `credentials` account or a twin `accountId`, not both. Without either, a ready twin's first test account signs in; `accountId: null` uses none. Account values reach only the current worker and are never saved with cases, configuration or run requests. The controller reads a twin account's password from the twin's private state; views list only its id, label and username.

The worker gives Browser Use placeholders instead of the values. Before substituting them it checks the exact scheme, host, port, top-level frame and input type, and a password goes only into a password field. With an account, the agent can also call `sign_in_with_test_account`, which fills the page's one visible sign-in form, submits it and reports `signed_in`, `still_on_sign_in`, `no_sign_in_form` or `error`, never a value. Account-backed runs send the model page text without screenshots, with the account values redacted. Cross-origin and iframe sign-in are not supported.

Twin test accounts are generated local test data, so evidence, results, live frames and recordings show what the run observed about them. Model API keys and `Bearer` tokens are scrubbed from free text. Use dedicated test accounts, never production ones.

## Verdicts

The runner reports facts, never a status: how the journey stopped (`none`, `deadline`, `forced` or `exception`, and `action` for a Playwright spec), agent observations of each expected outcome, blockers (`account`, `fixture`, `integration`, `permission` or `environment`) and final assertion results. `journeyResult` in `src/browser/results.mjs` is the only verdict, applied once per journey on every path, including a worker stopped by its time limit and a journey interrupted by a restart. Precedence, highest first:

1. `failed`: a milestone check failed, a final assertion on the reached end state failed, an agent observation reported a failed outcome, or the journey stopped on an error.
2. `blocked`: a milestone was blocked, or the agent reported a blocker.
3. `needs_review`: the deadline passed, Browser Use forced a final report, a milestone is incomplete, or evidence is insufficient.
4. `passed`: every milestone completed with its checks, every final assertion was checked and passed, and, for Browser Use, the agent completed with evidence for every expected outcome. A journey needs at least one final assertion (Browser Use) or at least one check or assertion (Playwright) to pass.

Final assertions describe the end state, so when a journey stopped short of it (a blocked or failed milestone, a reported blocker, or an early stop) they are shown as not reached and neither fail nor pass the journey. A run rolls up as `failed`, `blocked`, `needs_review`, `cancelled`, `completed` (the run had skips) or `passed`, in that order.

## Live view and recordings

Beta and Gamma cards list the stage's journeys with their queued, running and result states. Selecting a journey focuses its expanded card in the inspector, which has two views: **Integration tests** and **Runs**. Each running journey streams JPEG frames of its own browser viewport (1280×800), and its milestones update as the controller accepts them. Milestone completion from the agent is labelled as an observation. No sample footage or synthetic progress replaces an unavailable stream.

Every tab of a run journey is recorded as WebM; discovery is not recorded. A finished journey plays its recordings (one tab per recording); one without a recording shows its **Last frame**, never presented as live activity. A stage keeps the recordings of its latest 5 runs. A missing recorder, such as a missing ffmpeg, leaves a journey unrecorded without failing it; a killed worker reports no recording.

Frames and recordings may show test data. They stay behind the local, scoped controller.

## Playwright engine

The Playwright engine is opt-in: a person chooses it in the run dialog. Browser Use stays the default, and the [journey gate](gate.md) uses Browser Use.

### Specs

A spec is the Playwright actions of one reviewed journey, saved as stage data. It contains no checks: the reviewed checks and final assertions come from the approved case snapshot at run time, so a spec can neither write nor weaken them.

A spec runs in the same process as the fixture that judges it, so `src/journeys/playwright/specs.mjs` accepts a grammar rather than arbitrary JavaScript. A spec is at most 200 KB, parsed by Playwright's bundled Babel, and has exactly `import { test } from 'perpetual'` and one `test(title, async ({ page, journey }) => { … })`. Its body only awaits `journey.milestone('<id>', async () => { … })`, with literal IDs for exactly the case's milestones, in order. A milestone only awaits `journey.signIn()` or one Playwright action on `page`, its locators and frame locators, `page.keyboard` or `page.mouse` (`goto` to an http(s) URL or path, `reload`, `click`, `fill`, `press`, `selectOption`, `waitForURL`, …), with literal, options-object or locator arguments. No other identifier, declaration, assignment, computed access, function or control flow is accepted, so `expect`, page scripts, routing, direct requests, `process` and other globals cannot be written. A run validates the stored code again.

### Approval

A draft spec is approved only after a person's Playwright run of exactly that code passed, for the reviewed contract it was written for. Editing the goal, preconditions, milestones, checks, expected outcomes or final assertions makes the approval stale; renaming or selecting does not. Removing a case removes its spec. A person's run may use an unapproved draft, which is how a draft earns approval; a run started without a person runs approved specs only.

### Runs

Each journey runs as one `playwright test` process under the same supervisor as the Browser Use worker, so skip, stop, deadlines, concurrency and environment reservations behave the same. No model is needed. A private temporary workspace holds the generated config, the approved case snapshot and the spec, and `perpetual` resolves to `src/journeys/playwright/fixture.mjs`. The fixture takes the event channel and the account out of the process environment before any spec runs.

The fixture starts each journey on the target URL. `journey.milestone(id, actions)` enforces the reviewed order, runs the actions in a `test.step`, then evaluates that milestone's checks from the snapshot, each waiting up to 10 seconds for its condition. `journey.signIn()` fills the run's account into the page's one sign-in form. Every document request is checked against the allowed origins, and a top-level Stripe page loads only in test mode. A refused navigation, or a page no check can judge, stops the journey for review, never as a failed check. Frames stream at about three per second.

A Playwright journey has no agent observations: a failed check or final assertion fails it; an action that could not complete, a milestone skipped or out of order, a spec that differs from its approval, or the deadline needs review. A spec that signs in with no account available is blocked before launch. When a twin service is blocked for missing inputs, the spec still runs, and a journey that does not pass is reported blocked on that service, since without an agent nothing tells whether the missing service caused the failure.

### Generating code

**Generate code** in a reviewed journey's menu writes its spec with existing tools: the Playwright Test generator agent that `playwright init-agents --loop=opencode` emits, run headlessly by [OpenCode](https://opencode.ai) (`opencode-ai@1.18.32`) against OpenRouter. Perpetual writes no agent loop or MCP client (`src/journeys/playwright/generation.mjs`). It needs a reviewed case with milestones, an OpenRouter model in Settings, and the stage's application URL on the stage's ready twin. It holds that twin like a run, one generation per case at a time; **Stop generating** cancels it. Nothing else starts a generation: not a view, a restart or the gate.

The generation works in a private folder that is removed when it ends. The generator can write only test files in its own `tests/` folder; the config, seed, fixture mapping, plan and OpenCode configuration are read-only and must stay unchanged. OpenCode runs with its own `HOME`, so it reads none of your global OpenCode configuration, plugins or instructions, and only OpenCode receives the model key. Each harness call has 10 minutes.

The written file is validated like any spec. An invalid or missing file gets one repair attempt with the validation error; a still-invalid file fails the generation and nothing is saved. A valid spec is saved as a draft with its provenance (harness, generator and model) and still needs approval. Generation quality depends on the model; the test suite drives the pinned test MCP server with a fake harness (`test/fixtures/fake-opencode.mjs`).

The journey card shows a `Playwright` badge with the code's state: `Draft`, `Approved` or `Stale`, and `Generating` or `Generation failed` with its error. There is no code viewer or editor.

## API

The main routes are below. Every request is scoped to `repoPath` and a Sandbox `stageId`. Mutations need the controller session token and a same-origin request.

| Method and route | Input |
| --- | --- |
| `GET /api/browser` | The stage's configuration, cases, specs, runs and preparation state. |
| `POST /api/browser/config` | `config`: target URL, scope, requirements, `maxSteps`, `journeyTimeoutSeconds`, `externalOrigins`, `authEndpoints`. |
| `POST /api/browser/cases` | `cases`, `baseCases`; a stale `baseCases` returns 409. |
| `POST /api/browser/draft` | `description`: one draft from a description. |
| `POST /api/browser/transcribe` | A dictated recording. |
| `POST /api/browser/discover` | Starts discovery; optional `replaceCaseIds`, `credentials` or `accountId`. |
| `POST /api/browser/run` | Optional `caseIds`, `concurrency`, `engine` (`browser-use` or `playwright`), `credentials` or `accountId`. |
| `POST /api/browser/skip` | `id`, `caseId` |
| `POST /api/browser/stop` | `id` |
| `GET /api/browser/runs/:id` | Full run progress. |
| `GET /api/browser/runs/:id/frame` | `caseId`: the journey's latest JPEG frame. |
| `GET /api/browser/runs/:id/video` | `caseId`, `file`: a recording the journey reported, with byte ranges. |
| `POST /api/browser/specs` | `caseId`, `code`: saves a draft spec. |
| `POST /api/browser/specs/approve` | `caseId`, `hash` |
| `POST /api/browser/specs/generate` | `caseId`; `POST /api/browser/specs/generate/cancel` stops it. |

App-wide model settings are not scoped to a stage: `GET` and `POST /api/settings/model` read and save the OpenRouter model and key, and `GET /api/settings/models` lists the eligible models.

## Implementation

- `src/business/browser-cases.mjs`: case validation and redacted, bounded source context.
- `src/browser/`: scoped state, worker supervision, scheduling, model settings, frames, recordings and the verdict (`results.mjs`).
- `src/journeys/playwright/`: the spec grammar, fixture, reporter, runtime and code generation.
- `integrations/browser-use/`: the pinned Python worker (Browser Use and Playwright for Python), milestone driver, independent checks, sign-in helper and frames. Its [README](../integrations/browser-use/README.md) documents the worker protocol.
- `client/src/BrowserTestingPanel.jsx`, `BrowserAgentViewer.jsx` and the journey components: the interface.

## Tests

- `npm test` covers the controller, case validation, verdicts, scheduling, the spec grammar and the API.
- `npm run test:browser` runs the Python worker's tests, including a real Chromium against disposable local pages.
- `node scripts/browser-agent-contract.mjs` runs the controller → Python → Browser Use → Chromium path against a disposable page with a deterministic model fixture: two isolated journeys at concurrency 2, their separate frames, milestone states and independent `read-number` and `compare-number` results.

These use deterministic model fixtures. They establish contracts and failure behaviour, not a real model's accuracy on a real application.
