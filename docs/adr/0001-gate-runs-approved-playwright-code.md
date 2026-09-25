# 1. Gate and manual runs execute approved Playwright code

A journey gate must give the same verdict for the same commit, quickly and cheaply, but a model-driven browser agent performing every run was slow, varied between runs, paid for model tokens on every push and could route around a broken control. So an agent writes each reviewed journey's actions once as Playwright code, a person approves that code after it is verified, and gate and manual runs replay it with a generic fixture and no model.

Status: accepted.

## Context

When a Browser Use agent performed every run, each milestone took sequential model calls, verdicts could differ between runs of the same commit, and much of the Python worker existed to compensate: single-action enforcement, a code-driven milestone protocol, forced-finalization handling and reconciling agent observations with independent checks. In a trial on a real application's twin, a generated Playwright spec with a generic fixture ran a four-milestone journey in about 3 seconds with no model calls, where the agent needed 40 to 72 seconds; it passed 20 runs out of 20, and an injected persistence bug failed on a reviewed check.

## Decision

An agent (Playwright's generator agent, run headlessly by OpenCode) writes the actions of a reviewed journey as Playwright code. Gate and manual runs execute that code with the generic `perpetual` fixture and no model. The browser agent still discovers journeys but never acts in a run, and the agent run path is removed.

Four guardrails:

1. **Checks come only from the reviewed milestones; AI never writes them.** The spec grammar has no assertions: a milestone only awaits Playwright actions, and the fixture evaluates the checks it loads from the approved case snapshot.
2. **AI-changed code never takes effect or turns a run green by itself.** Generated or saved code is a draft beside the approved code until a person approves it, seeing the code or its diff against the approved code. The grammar allows exactly one plain `test(...)`, so a skipped, `fixme` or `only` test cannot exist.
3. **No automatic retries.** A pass that needed a retry is not a pass: the generated Playwright config keeps `retries: 0` and sets `failOnFlakyTests: true`.
4. **Before approval, the draft is verified.** It runs three times, then once as a control run in which every state-changing request is blocked (except while the fixture signs in) and answered without reaching the application, so its page can still be judged. The three runs must pass, and then a reviewed check must fail in the control run: a journey whose checks cannot tell that nothing it did was kept cannot be approved. A control run that passes, or that ends any other way, such as on an action the block broke, fails the verification. A verification holds only for the exact code and reviewed journey it ran.

## Consequences

- The agent run path is removed: the runner's run mode, milestone driver, final checks, reload tool, Stripe payment guard, recorder and run failure limits, and the agent-outcome parts of the verdict. `journeyResult` keeps only the checks-backed semantics; results of older agent runs still render, with less detail.
- Discovery is unchanged: the browser agent explores the application and proposes reviewable drafts.
- A run needs Playwright's Chromium and code for each journey, not a model. A journey without current code needs review without a browser; the gate runs approved code only, and a person's run may try a current draft.
- A verification holds its stage, so a gate waits for it; its runs never count as a journey's status or reach the gate.
- The control run blocks by HTTP method, so it cannot tell a write from a read sent as a POST (GraphQL, RPC): a journey whose application reads that way fails its checks in the control run for that reason alone.
- Writing code needs a more capable model than a run ever does, since a run needs none; a small model can fail to write a valid spec. Generation is a one-time cost per journey.
- Repairing code after the application changes is not automatic: a person generates, verifies and approves new code.
