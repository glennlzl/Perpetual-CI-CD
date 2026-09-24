# Journey contract

Status: implemented. The Python runner (`integrations/browser-use/`), the Node controller (`src/browser/`) and the client agree on every field below. Nothing here permits simulated pages, fixture success or inferred business outcomes. User-facing behaviour is described in [Business journeys](../journeys.md).

## Journeys and live runs

- A reviewed case is a journey: a goal, prerequisites, ordered business milestones, fixed expected outcomes, independent checks and source evidence. Runtime actions are chosen by the agent, or by an approved spec with the [Playwright engine](playwright-journeys.md).
- Discovery proposes up to four coherent journeys from source and observed product behaviour. Regeneration replaces the chosen current cases only after a successful discovery; immutable run snapshots stay available.
- Each journey owns one browser worker and keeps its session across milestones. A run holds the environment's reservation until every worker has finished cleanup.
- Run concurrency is 1 to 4, default 2. Cases default to shared application data and run exclusively; only a reviewed case that declares independent test data can overlap other such cases. Browser profile isolation does not isolate account balances or application data.
- A queued journey can be skipped without launching. An active journey enters `skipping`, cancels its worker and becomes `skipped` after cleanup. Skip never rewinds side effects or becomes success. Uncertain cleanup quarantines the owned environment.
- Frames are scoped by source, stage, run and case. Milestone events are agent observations; final verification stays separate. Real activity drives all motion in the interface, which respects reduced-motion preferences, and no preview footage is invented.

## Case and milestone shape

```
case.steps: [{ id, title, checks?: MilestoneCheck[] }]   // 2–12 for new or edited reviewed cases
MilestoneCheck =
  | { type: 'url-contains' | 'text-visible' | 'text-absent', value }        // 1–4000 chars
  | { type: 'read-number', label, name }                                   // capture
  | { type: 'compare-number', label, name, op: '<'|'>'|'='|'!=', than }     // compare with an earlier capture
```

- `label`: 1–120 characters of visible text next to the number, such as `Credits`. `name` and `than`: `/^[a-z][A-Za-z0-9]{0,39}$/`.
- A step has at most 6 checks. `than` must name a `read-number` in an earlier step or earlier in the same step.
- Step ids are stable. Editors keep existing ids by title match and mint unused ids for new lines.
- Cases from before milestones (`steps: []`) stay readable and runnable, unchanged. A case saved as reviewed (`needsReview: false`) needs 2–12 steps unless it is identical to a stored earlier case.
- `isolation` is `shared` (default) or `isolated`.

## Independent milestone checks

- The runner evaluates a step's checks itself, on the live page, when the step is reached. The model never supplies the observed value.
- `read-number` finds visible elements whose own text contains `label`, walks up at most 3 ancestors, and parses the first number after the label. Since an ancestor's text includes its siblings, only separators (no letters or digits) may sit between the label and the number. It accepts `1,240`, `1240.5`, `-3` and `$12.00`, and fails if it finds no number. Captured values are kept per case.
- `compare-number` reads the value the same way and compares it with the named capture.
- Each result is `{type, …definition, passed, observed?, error?}` with provenance `independent`.
- A failed check makes the step `failed`, and the controller's verdict fails the case. A step whose checks all pass is `completed`.
- The step event carries the results: `{type: 'journey-step', caseId, stepId, status, evidence?, checks?}`.

## Code-driven milestones

- The runner, not the agent, drives milestones. There is no milestone-report tool: the agent is asked for one milestone at a time and ends each with `done`.
- The done report is `{reached, evidence, blockers, outcomes}`: `evidence` is one observed sentence (1–2000 characters), `blockers` the list below, and `outcomes` the agent's observations of every fixed outcome, requested with the last milestone.
- For each step in order the runner emits `running`, asks the agent to reach it, then records `completed` or `failed` (from the checks) for `reached: true`, or `blocked` for `reached: false` with blockers. `reached: false` without blockers, a forced report, the deadline or the step budget leave the step `running`. Nothing runs after a step that was not completed.
- One Browser Use agent in flash mode serves a journey. Later milestones reach it through `Agent.add_new_task`, which keeps its memory, history and browser session; all milestones share the journey's step budget and deadline. Browser Use forces a report after consecutive failures: 2 in discovery, 3 in a journey, 4 in a journey of 8 or more milestones.
- A case without steps is one request for its goal, with the same report.

## Progress events and transitions

- Step statuses: `pending | running | completed | blocked | failed | unconfirmed | skipped | cancelled`.
- The worker may emit `running`, `completed`, `blocked` and `failed` (`failed` only from an independent check).
- The only transitions the controller accepts are `pending → running` for the first unfinished step, then `running → completed | blocked | failed`. `completed`, `blocked` and `failed` are terminal; nothing may follow a blocked or failed step.
- A `running` event has no evidence; every other status needs 1–2000 characters of evidence, which are stored.
- Twin test accounts are generated local test data. Evidence, reports, summaries and frames keep what was observed about them; only the text sent to the model is redacted.
- When the run ends, the controller turns a step still `running` into `unconfirmed`, or into `skipped` or `cancelled` for a skipped or cancelled journey. It never becomes `blocked`.
- Progress has a monotonic `progress.revision`, incremented on every accepted event, including frames and queue changes, and a per-case `actionCount` (the total, not truncated) and `lastAction`. The controller keeps the worker's `frameCapturedAt` separately from its own `frameUpdatedAt`.

## Runner facts and the controller verdict

- A run request carries exactly one reviewed `case`. The controller schedules the run's journeys and starts one worker per journey.
- The runner reports facts, never a status or verdict message. Its final event is `{type: 'result', result: {caseId, stopCause, agentCompleted, outcomes, blockers?, assertions, diagnostics?, error?}}`:
  - `stopCause`: `none` (the agent's reports ended the journey), `deadline` (the journey's time limit or the request backstop), `forced` (Browser Use forced a report after repeated failures or at the step budget) or `exception` (the journey could not continue; only this carries a sanitized `error`). The Playwright engine adds `action`.
  - `agentCompleted` is true only when every milestone was reached and the last report observed every fixed outcome.
  - `outcomes` are agent observations from the last report. `blockers` are `[{stepId?, kind: 'account'|'fixture'|'integration'|'permission'|'environment', evidence}]`, at most 10; a malformed list is discarded, and the case cannot pass.
  - `assertions` are the final assertions `{type, value, passed}` checked on the page the journey ended on, or `[]` when that page was never checked.
  - `diagnostics` holds bounded counters only: model calls, failure categories, steps without actions, observed actions and whether Browser Use forced finalization. Unknown fields are stripped; no provider message or prompt is kept.
  - Milestone states are not repeated; the controller has them from `journey-step` events.
- A cancelled runner reports no result. Stop, Skip and the kill timer are controller decisions, and `cancelled` and `skipped` come only from them.
- One function, `journeyResult` in `src/browser/results.mjs`, owns a journey's status and message. It validates the facts against the approved snapshot and combines them with the accepted milestone states. The manager calls it exactly once per journey: for a reported result, for a worker its kill timer stopped (with the facts reported before, or `stopCause: 'deadline'`), for a worker error (`stopCause: 'exception'`) and for a journey interrupted by a controller restart.
- Final assertions describe the journey's end state, and the controller derives whether it was reached. The journey stopped short of its end state when a milestone is `blocked` or `failed`, the agent reported a blocker, or it stopped for any cause other than `none` before every milestone completed (a case without milestones never shows that it finished). Its final assertion results then carry `reached: false` and can neither fail nor pass the case. A `reached` value from the worker is ignored.
- Case statuses: `passed | failed | blocked | needs_review | cancelled | skipped`. The verdict applies this order, and its messages are the only journey messages:
  1. `failed`: a milestone check failed (*Milestone check failed: title.*), a reached final assertion did not pass (*A final assertion failed.*), an agent observation reported a failed outcome (*A fixed business outcome failed.*), or the stop cause is `exception` (its sanitized detail).
  2. `blocked`: a milestone is `blocked` or the agent reported a blocker (*Blocked at milestone: title.*, or *Blocked: kind prerequisite unavailable.* without a milestone).
  3. `needs_review`: the stop cause is `deadline` (*Journey exceeded its time limit.*) or `forced`, a milestone is incomplete, or evidence is insufficient.
  4. `passed`: agent completion, every fixed outcome satisfied with evidence, at least one approved final assertion, every one checked and passed, valid blockers and diagnostics, and every milestone completed.
- Error text is presentation, never a signal. Model API keys, `Bearer` tokens and URL queries are scrubbed from free text only; protocol fields (`type`, `status`, `stopCause`, ids, `kind`, `op`, approved assertion `value`) are never rewritten.
- `blocked` is never counted as passed or failed.
- Run roll-up order: `failed > blocked > needs_review > cancelled > completed (had skips) > passed`.

## Budget and time

- The action budget per journey is `config.maxSteps + steps.length`, capped at 112, so each milestone's `done` does not consume the business action budget.
- `journeyTimeoutSeconds` is 60–1800, default 900; a stored config without it uses the default. Workers receive `timeoutSeconds = journeyTimeoutSeconds` as their journey's deadline.
- At the deadline the runner still evaluates final assertions and finishes recordings, then reports `stopCause: 'deadline'`. If a stuck cleanup outlasts the request-wide backstop (`timeoutSeconds + 15` seconds), the runner reports `stopCause: 'deadline'` with no final checks.
- The controller's kill timer fires at `timeoutSeconds + 45` seconds, after the backstop. The verdict judges a worker it stopped from the facts reported before, or from `stopCause: 'deadline'`: `needs_review` unless a milestone failed or was blocked. Uncertain cleanup still fails the journey and quarantines its environment.

## Origins, payments and authenticated discovery

- `externalOrigins`: HTTPS origins only, at most 10, with no credentials, path or query, set in the stage's test settings. A run worker receives `allowedOrigins = [target origin, ...environment app origins, ...externalOrigins]`. Discovery stays on the target environment's origins, except for the sign-in exchange below.
- Payment test-mode guard, in the runner, on `*.stripe.com` pages:
  - `input`, `click` and `send_keys` are allowed only when the page's URL path contains `cs_test_` or `/test_`, or a visible element's whole text is Stripe's test-mode banner (`Test mode`, `TEST MODE` or `Sandbox`). A `cs_live_` or `/live_` path is always rejected, whatever the page shows.
  - Otherwise the action fails with `payment_live_mode_rejected`.
  - Stripe frames embedded in the application's own pages are not inspected.
- Only when a Stripe origin is allowed, run instructions include Stripe's test cards: `4242 4242 4242 4242` succeeds and `4000 0000 0000 0002` is declined, with any future expiry, CVC and ZIP.
- Discovery may take the same run-only `credentials` (never persisted). `authEndpoints` holds at most 3 absolute URLs on the target host (any port), each with a path other than `/`, and a twin's test account can supply its own. Discovery permits a POST to one of them (for example `http://127.0.0.1:54321/auth/v1/token`), its sub-paths or query variants, matched on whole path segments so `/auth/v1/token-revoke` is not included, and still blocks every other mutation. With credentials, discovery uses the same credential tools and guards as runs, including `sign_in_with_test_account`, without screenshots. The discovery result records `authenticated`.

## Run instructions

- For credit, usage or balance outcomes, observe the starting value in the first relevant milestone and the final value at the end.
- For asynchronous work, wait and observe again instead of assuming completion.
- The first milestone confirms the required starting state (plan, balance, account). If the state does not match, the milestone is not reached and has blockers.
- A settings journey records the original value and ends by restoring it.
- Payment actions happen only in Stripe test mode with the test cards above; otherwise the milestone is blocked.

## Scheduling and API

- `effectiveConcurrency` is 1 when a test account is shared or fewer than 2 cases are isolated; otherwise `min(concurrency, isolated cases)`. The run records `concurrencyLimit: 'shared-data' | 'account' | null`, and a queued journey's `queueReason` is `account`, `shared-data` or `browser`.
- The discovery summary is limited to 4000 characters in both Python and Node.
- Restart recovery turns journeys that never started (`queued` or `pending`) into `cancelled` (*Controller stopped before this journey started*), `running` ones into `failed`, `skipping` ones into `skipped` and `cancelling` ones into `cancelled`. Running steps become `unconfirmed`, and matching result rows are added.
- `draft` and `saveCases` are allowed during an active run, because the run uses an immutable snapshot. They stay exclusive with discovery and with other case writes.
- `/api/state` summaries include `progress` only for active runs and each case's latest run, without `actions` (they keep `actionCount`, the last action, steps, `queueReason` and frame timestamps). Full progress stays in `runProgress`.
