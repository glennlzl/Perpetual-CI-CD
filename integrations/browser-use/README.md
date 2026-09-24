# Local browser agent

The browser-first runner uses **Browser Use 0.13.10** for its observe → decide → act loop. **Playwright 1.63.0** owns a dedicated Chromium process, gates navigation, captures viewport frames and checks fixed postconditions. There is no action script, personal browser profile, Docker dependency, Cua fallback or implicit cloud browser in this path.

## Install

```sh
uv sync --project integrations/browser-use --frozen
integrations/browser-use/.venv/bin/python -m playwright install chromium
```

Linux hosts may need Chromium system libraries (`python -m playwright install-deps chromium`, using the installed interpreter). The controller uses this environment by default; `PERPETUAL_BROWSER_PYTHON` can select an absolute interpreter path with the same locked package versions.

Set `OPENROUTER_API_KEY` in the controller environment to use the default planner `openai/gpt-5.4-mini` at `https://openrouter.ai/api/v1`. Alternatively set `PERPETUAL_MODEL_API_KEY`, `PERPETUAL_MODEL`, and optionally `PERPETUAL_MODEL_BASE_URL`. Keys are never accepted in the stdin request or emitted in the protocol. Jev is not a compatible main planner and is not integrated as an accelerator in this adapter.

```sh
node --input-type=module -e 'import {createBrowserRuntime} from "./src/browser/runtime.mjs"; console.log(await createBrowserRuntime().capabilities())'
```

The controller resolves saved settings, environment variables and defaults once. Direct Python worker use requires all three resolved values: `PERPETUAL_MODEL_API_KEY`, `PERPETUAL_MODEL`, and `PERPETUAL_MODEL_BASE_URL`; the worker does not choose provider defaults. Invalid model configuration is reported separately from runtime installation.

Preflight checks package pins, the bundled Chromium executable and model configuration presence. It does not contact the model or claim that a key is valid.

## Contract

One JSON object on stdin, followed by EOF. `mode` is `preflight`, `discover` or `run`. Discovery/run inputs:

- `targetUrl`, `allowedOrigins`: HTTP(S) target and exact allowed navigation origins, including ports. The owned Chromium resolves `host.docker.internal` to 127.0.0.1, so a twin's URLs are the same for the browser and its containers.
- `unavailableServices` for run: optional `[{id,title,missing}]` twin services that did not start for missing test inputs. The agent reports the milestone that needs one not reached, with an `integration` blocker, so it is blocked, never failed.
- `scope`, `requirements`, `sourceContext`: bounded reference text. Source/page contents are untrusted evidence, not agent instructions. Discovery uses all three; a run journey's task carries `requirements` and the approved case, not `scope`.
- `maxSteps`: 1–112, default 30; the controller adds one `done` per milestone to its business budget. The journey's milestones share it. `timeoutSeconds`: 1–1800 for the run journey (for discovery, the request), default 300. A journey that reaches it still evaluates its final assertions and reports `stopCause:"deadline"`; its milestone states were already streamed. If the request-wide backstop (`timeoutSeconds + 10`) fires first, for example during a stuck cleanup, the run still emits `result` with `stopCause:"deadline"` and no final checks. Discovery reports its time limit as `error`.
- `case` for run: exactly one reviewed, selected case with `id`, `name`, `goal`, `preconditions`, `expectedOutcomes`, `assertions`, `selected:true`, `needsReview:false`, and optional ordered `steps: [{id, title, checks?}]`. The controller schedules a run's journeys, one worker each.
- Assertions are `{type:"url-contains"|"text-visible"|"text-absent",value:string}`. They are copied before execution and cannot be edited by the agent.
- Milestone checks (at most 6 per step) are those text checks or `{type:"read-number",label,name}` and `{type:"compare-number",label,name,op:"<"|">"|"="|"!=",than}`, where `than` names an earlier `read-number`.
- `credentials`: an optional run-only `{username,password}` for `run` or `discover`, never persisted. `authEndpoints`: at most 3 absolute URLs with a path other than `/` on the target host (any port). With credentials, discovery may POST only to one of them, its sub-paths or query variants, matched on whole path segments.
- Runs offer the agent `reload_page`, which reloads its tab at the current approved address; navigating to a remembered address is not a reload, because the address can change, such as after a rename.
- With `credentials`, runs and discovery offer the agent `sign_in_with_test_account`; the agent still decides when to sign in, and a journey keeps its sign-in milestone. On the agent's tab it finds a visible sign-in form (exactly one password field, not `autocomplete=new-password`) and the username or email field in the same form (`type=email` or an `username`/`email` autocomplete, else the nearest text field before the password; without a `<form>`, the password's nearest ancestor holding such a field). It fills both under the same origin, top-frame, tab and field-type rule as placeholder input, clicks the form's submit control (never a `type=button` control such as a show-password toggle; its click waits for a control enabled only once both fields hold values) or presses Enter, then waits up to 15 s for the approved page to stay without a password field. It returns `signed_in`, `still_on_sign_in` with at most 100 characters of redacted alert or validation text, `no_sign_in_form` or `error`, never a value. Discovery's POST still needs a configured `authEndpoints` entry. Typing the `<secret>` placeholders stays the fallback, for example for a separate username step.

Stdout is NDJSON only:

- `status`: initialization, preflight and cancellation state.
- `case`: `caseId` and generic action types/statuses. Discovery uses the pseudo-case `discovery`. Inputs, locators, model reasoning and credential values do not enter this feed.
- `frame`: JPEG base64 `data` and millisecond `timestamp`, normally every 350 ms. This is the actual webpage viewport, unmasked; trusted mouse events produce the pointer marker. No synthetic action delay is added. Strict page CSP can prevent the cosmetic marker; actions and frames still execute normally.
- `journey-step`: `caseId`, `stepId`, `status` (`running`, `completed`, `blocked`, or `failed` from an independent check), the agent's bounded `evidence` (absent on `running`) and, for a step with checks, `checks` results `{…definition, passed, observed?, error?, provenance:"independent"}`.
- `discovery`: goal-based `cases`, `summary` and `authenticated` (a configured sign-in exchange succeeded); every candidate is `selected:false`, `needsReview:true`. Milestones are business titles with optional checks, not click scripts. Evidence keeps only citations of lines supplied in `sourceContext` (`N: text` lines per file path, the controller's rule); other citations are dropped.
- `result`: facts about the journey, never a status: `caseId`, `stopCause` (`none` when the agent's reports ended the journey, `deadline`, `forced` when Browser Use forced a report, or `exception`), `agentCompleted` (every milestone reached and the last one's report observed every outcome), bounded `outcomes` from that last report (`outcomeIndex`, `status`, `evidence`, `provenance:"agent"`), agent-reported `blockers` (`stepId?`, `kind`, `evidence`), final assertion results (`type`, `value`, `passed`, or `[]` when the final page was never checked), `diagnostics`, and for `exception` only a sanitized `error`. A cancelled run emits no `result`.
- `error`: sanitized adapter/provider error. No raw model HTTP body is emitted.

The runner, not the agent, drives milestones. One Browser Use agent (flash mode) serves the whole journey. The runner emits the first milestone `running` and gives the agent the journey with "Current milestone 1/n"; each later milestone arrives through `Agent.add_new_task`, which keeps the agent's memory, history and browser session. For each, the agent works only toward that milestone and calls `done` with `{reached, evidence, blockers, outcomes}`; `outcomes` observes every fixed outcome and is asked for with the last milestone. On `reached:true` the runner evaluates the milestone's checks on the live page before anything else happens: `read-number` parses the first number after `label` in a visible matching element or, with only separators between them, in one of its three nearest ancestors, and the model never supplies the value. All checks passing make the step `completed`; otherwise it is `failed`. `reached:false` with blockers makes it `blocked`; without blockers, or when Browser Use forced the report, the deadline passed or the budget ran out, it stays `running` and the controller marks it unconfirmed. Nothing runs after a milestone that was not completed. A case without steps is one request for its goal. The actor seam (`reach(index)` returning that report, or none) lets another engine try a milestone later. Browser Use forces a report after `max_failures` consecutive failures in one milestone: 2 in discovery, 3 in a journey, 4 in a journey of 8 or more milestones.

The runner never decides a case's status or message. The controller's single verdict (`journeyResult` in `src/browser/results.mjs`, specified in `docs/architecture/journey-contract.md`) combines these facts with the milestone states it accepted, and derives whether the final assertions describe an end state the journey reached. When an approved origin is on `stripe.com`, the agent receives Stripe test-card guidance, and `input`, `click` and `send_keys` on Stripe pages require `cs_test_` or `/test_` in the URL path or a visible element whose whole text is `Test mode`/`TEST MODE`/`Sandbox`; a `cs_live_` or `/live_` path is always rejected. Otherwise they fail with `payment_live_mode_rejected`. Stripe frames embedded in the application's own pages are not inspected.

An action's `passed` status means that the action completed, **not** that the case passed. The controller passes a case only when all declared independent assertions pass and the structured agent result includes evidence for every immutable expected outcome. Missing assertions, incomplete evaluation or uncertainty produce `needs_review`. The controller validates outcome indexes against the immutable case snapshot; duplicate, missing or unknown indexes cannot establish a new pass. Evidence is kept as observed, without model API keys, `Bearer` tokens or URL queries, and limited to 2000 UTF-16 code units per outcome, milestone or blocker. Twin test accounts are generated local test data, so evidence, results and frames may show them. Agent observations are shown separately from independent checks. Historical results without observations remain historical results; the viewer marks those observations as not reported rather than inventing them. These browser assertions are limited URL/rendered-text checks, not an independent database/payment oracle.

## Scope and lifecycle

Each case has a fresh temporary browser profile. This resets browser state, **not backend state**. The caller must supply valid business preconditions and manage test fixtures/reset separately. App servers and database services run independently and must already be reachable at the target URL.

Discovery is read-only: HTTP mutation methods are blocked, except a POST to a configured sign-in endpoint when a run-only account is supplied. That authenticated discovery uses the same credential guards as runs and sends no screenshots to the model. Without it, authenticated screens or apps that require POST/GraphQL for reading may remain unexplored; such gaps must be presented as preconditions rather than invented coverage. Supplied source/requirements can still inform reviewable proposals.

The tool allowlist excludes filesystem operations, arbitrary JavaScript evaluation, shell, uploads, downloads and external search. Exact-origin navigation is checked before tool navigation and at request interception. Context interception handles initial popup requests; CDP Fetch handles redirect hops. Guard attachment failures close the affected page and prevent passing results. Allowed pages still load normal external subresources and API requests in run mode: this is **navigation scoping, not complete outbound network isolation or a hardened untrusted-code sandbox**.

SIGTERM/SIGINT cancels the task, stops streaming, disconnects Browser Use, closes owned Chromium and deletes the temporary profile. It emits no `result`: only the controller cancels a journey, and it records that itself. Cleanup failures emit an error. The runtime does not connect to arbitrary CDP endpoints or reuse a user's running browser. Telemetry, cloud synchronization and default extension downloads are disabled.

## Focused verification

```sh
integrations/browser-use/.venv/bin/python -m unittest discover -s integrations/browser-use -p 'test_*.py'
```

`test_browser.py` launches disposable loopback fixtures and a dedicated Chromium. It checks real Browser Use attachment, Agent/schema construction, trusted click execution, live JPEG frames, independent visible-text assertions, blocked external redirects/popups, profile cleanup, and reviewable discovery. Its local OpenAI-compatible response fixture is deterministic: it verifies the actual Agent integration and observation/action protocol **without claiming a live model reasoning result or benchmark score**. `test_journey_runs.py` uses the same kind of fixture for code-driven milestones: checks on the page each milestone's `done` left, blocked, failed, forced and unreached milestones, final outcomes, journeys without milestones, deadlines and the request backstop. `test_sign_in.py` signs in on email, username, disabled-until-filled, formless and multi-form pages, leaves pages without a sign-in form untouched, and checks value-free results, origin and discovery endpoint guards, and the action through the same Agent fixture.

Upstream APIs reviewed from the pinned installed package and official sources:

- https://github.com/browser-use/browser-use
- https://github.com/browser-use/browser-use/blob/main/browser_use/agent/service.py
- https://github.com/browser-use/browser-use/blob/main/browser_use/tools/service.py
- https://playwright.dev/python/docs/api/class-browsercontext
- https://chromedevtools.github.io/devtools-protocol/tot/Fetch/

Before upgrading, recheck Agent callbacks/structured output, tool registration, BrowserSession attach/stop semantics and navigation guards against actual new package source; update both pins and `uv.lock` together.
