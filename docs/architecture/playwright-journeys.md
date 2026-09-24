# Playwright journeys

Status: the Playwright engine and code generation are implemented as an opt-in engine for a person's runs. Making approved specs the [journey gate](../gate.md)'s engine is planned; until then the gate runs journeys with Browser Use. Behaviour is documented in [Business journeys](../journeys.md#playwright-engine).

## Problem

A journey gate must give the same verdict for the same commit, quickly and cheaply. When an agent performs every gate run:

- it is slow, bounded by sequential model calls;
- its verdicts can vary between runs;
- every push pays for model tokens;
- an adaptive agent can route around a broken control and still reach the end.

Much of the Browser Use worker exists to compensate: single-action enforcement, the code-driven milestone protocol, forced-finalization handling, and reconciling agent observations with independent checks.

Replaying generated Playwright code removes the model from the run. Authoring the code needs a capable model, but it is a one-time cost per journey, and running it needs none. Playwright's own test agents (planner, generator, healer) already emit ordinary specs, so Perpetual reuses them instead of writing an agent loop.

## Design

1. **The reviewed contract stays the source of truth**: goal, preconditions, 2–12 ordered milestones with their checks, expected outcomes and final assertions ([Journey contract](journey-contract.md)).
2. **Generate once.** Playwright's generator agent, run headlessly through a harness that supports OpenRouter, writes the actions of a spec from a reviewed journey. The spec uses a generic Perpetual fixture:
   - `journey.milestone(stepId, actions)` wraps `test.step`, runs the generated actions, then evaluates that milestone's reviewed checks from the approved snapshot. Generated code never contains checks: a spec is an allowlisted grammar of awaited Playwright actions with no identifiers beyond `page` and `journey`, so neither generation nor repair can weaken them.
   - `journey.signIn()` fills the twin's test account into the page's sign-in form.
   - The navigation allow-list and the Stripe live-mode guard apply to every document request.
   - Milestone events and screencast frames reach the controller for the live view, and Playwright's video for replay.
3. **Approve.** A person watches a passing run of exactly that code and approves it. The approval stores the spec's hash, bound to the reviewed contract; editing the contract makes it stale.
4. **Run.** Approved specs run with no model. `journeyResult` still owns the verdict:
   - a reviewed check or final assertion fails → `failed`;
   - a spec that signs in without a test account → `blocked` before launch; with a twin service blocked for missing inputs, a journey that does not pass → `blocked`;
   - an action cannot complete, the deadline passes, or the spec or milestone coverage does not match its approval → `needs_review`.

## Proposed next steps

These are not implemented.

1. Make approved specs the gate's engine.
2. **Repair.** When an action fails, Playwright's healer proposes a patch in a private workspace. The result stays `needs_review` with the diff and the recording until a person accepts it, which approves the spec again. A healed spec is never an automatic pass.
3. Remove the Browser Use run path (run mode, milestone driver, sign-in helper and frame streaming) once the gate no longer uses it.

Discovery keeps the Browser Use agent until Playwright's planner proves equally good at authenticated journeys.
