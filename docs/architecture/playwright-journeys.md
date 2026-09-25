# Playwright journeys

Status: accepted and implemented, with four guardrails recorded in [ADR 0001](../adr/0001-gate-runs-approved-playwright-code.md). Every gate and manual run executes a journey's Playwright code; the browser agent only discovers journeys. Behaviour is documented in [Business journeys](../journeys.md#journey-code).

1. Checks come only from the reviewed milestones; AI never writes them.
2. AI-changed code never takes effect or turns a run green by itself: it is a draft beside the approved code until a person approves it, seeing the code or its diff.
3. No automatic retries: `retries: 0` and `failOnFlakyTests: true`.
4. Before approval, the draft passes three runs, then a control run in which every state-changing request is blocked; a reviewed check must fail in the control run.

## Problem

A journey gate must give the same verdict for the same commit, quickly and cheaply. When an agent performs every gate run:

- it is slow, bounded by sequential model calls;
- its verdicts can vary between runs;
- every push pays for model tokens;
- an adaptive agent can route around a broken control and still reach the end.

Much of the Browser Use worker existed to compensate: single-action enforcement, the code-driven milestone protocol, forced-finalization handling, and reconciling agent observations with independent checks.

Replaying generated Playwright code removes the model from the run. Authoring the code needs a capable model, but it is a one-time cost per journey, and running it needs none. Playwright's own test agents (planner, generator, healer) already emit ordinary specs, so Perpetual reuses them instead of writing an agent loop.

## Design

1. **The reviewed contract stays the source of truth**: goal, preconditions, 2–12 ordered milestones with their checks, expected outcomes and final assertions ([Journey contract](journey-contract.md)).
2. **Generate once.** Playwright's generator agent, run headlessly by OpenCode against OpenRouter, writes the actions of a spec from a reviewed journey. The spec uses a generic Perpetual fixture:
   - `journey.milestone(stepId, actions)` wraps `test.step`, runs the generated actions, then evaluates that milestone's reviewed checks from the approved snapshot. Generated code never contains checks: a spec is an allowlisted grammar of awaited Playwright actions with no identifiers beyond `page` and `journey`, so neither generation nor repair can weaken them.
   - `journey.signIn()` fills the twin's test account into the page's sign-in form.
   - The navigation allow-list and the Stripe live-mode guard apply to every document request.
   - Milestone events and screencast frames reach the controller for the live view, and Playwright's video for replay.
3. **Keep a draft beside the approved code.** Generated or saved code is always the draft. Both are bound to the reviewed contract's hash, so editing the contract makes both stale.
4. **Verify.** A draft runs three times, then once as a control run in which every request whose method is not GET, HEAD or OPTIONS is answered without reaching the application, except while the fixture signs in. The three runs must pass, and a reviewed check must fail in the control run; otherwise the checks cannot tell that nothing the journey did was kept. A verification holds only for the exact code and reviewed journey it ran, and holds its stage so a gate waits.
5. **Approve.** A person approves exactly the verified draft, seeing the code or its line diff against the approved code. The draft becomes the approved code.
6. **Run.** Gate runs execute approved code only; a person's run may try a current draft while no approved code is current. No model is needed. `journeyResult` still owns the verdict:
   - a reviewed check or final assertion fails → `failed`;
   - code that signs in without a test account → `blocked` before launch; with a twin service blocked for missing inputs, a journey that does not pass → `blocked`;
   - an action cannot complete, the deadline passes, the code or milestone coverage does not match its approval, or the journey has no current code → `needs_review`.

## Consequences

- The Browser Use run path is removed: the runner's run mode, milestone driver, final checks, reload tool, Stripe payment guard, recorder and run failure limits. Results of older agent runs still render, without their agent observations.
- The control run blocks by method, so a read sent as a POST (GraphQL, RPC) is blocked too, and such an application's journey fails its checks in the control run for that reason alone.

## Proposed next steps

These are not implemented.

- **Repair.** When an action fails, Playwright's healer proposes a patch in a private workspace. The result stays `needs_review` with the diff and the recording until a person verifies and approves it. A healed spec is never an automatic pass.
- Discovery keeps the Browser Use agent until Playwright's planner proves equally good at authenticated journeys.
