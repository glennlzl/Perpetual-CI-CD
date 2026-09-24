# Perpetual

## Language

**Pipeline** — The connected stages through which a project's source, delivery and business verification progress.

**Stage** — A named point in a pipeline, such as Source, Build & Deploy, Beta or Production. A stage's environment readiness and test results are separate states.

**Stage removal** — A user-confirmed operation that cleans up a Stage's owned environments before removing the Stage. It continues independently of the page that requested it; incomplete cleanup retains the Stage and its resource ownership for retry.

**Test workspace** — The current source and stage's integration cases, test configuration, application environments and run history, together with changes the user has not yet saved. Changing source must not carry those changes into another source's workspace.

**Business journey** — A coherent sequence of user actions leading to a meaningful business outcome, preserving session and business state along the way. Avoid treating an isolated click or internal function check as a journey.

**Business milestone** — An ordered part of a reviewed journey, such as saving and reopening a workflow or verifying a credit change. Agent-reported milestone completion is an observation, not an independent passing result.

**Journey queue** — Bounded execution of the reviewed journeys in a run. Each journey has its own browser worker. Shared application data creates an exclusive barrier; independent test data permits parallel workers. Skipping stops the owned worker but does not roll back application side effects.

**Reviewed case** — A business journey with a user-approved goal, preconditions, expected outcomes and independent checks. Generating a draft does not approve or execute it.

**Journey spec** — The Playwright actions of one reviewed case, generated or written as a draft, with no checks of its own: the reviewed checks are evaluated from the case at run time. A draft is approved only after a person's run of exactly that code passed; a gate runs approved specs only, and editing the reviewed case makes the approval stale. The UI calls it the journey's code.

**Expected outcome** — A fixed acceptance condition for a reviewed case. Agent execution may gather observations about it but cannot change it.

**Agent observation** — The agent's reported evidence and assessment of an expected outcome. It is not an independent check or proof of an external side effect.

**Independent check** — A declared condition evaluated separately from the agent's completion claim. Current browser checks observe final-page text or URL; they do not independently establish database or payment outcomes.

**Test run** — One execution of reviewed cases against an application, retaining the approved case snapshot and its results. Each case keeps its browser session throughout its journey; a fresh session does not reset application data.

**Journey gate** — The decision whether one commit may leave one Sandbox stage: the stage's twin is rebuilt at that commit and its reviewed, selected journeys run. A failed journey fails the gate; any other incomplete result needs a person's release. A passed or released gate moves the commit to the next Sandbox stage, and Production is Ready only for a commit every Sandbox gate passed or released. A gate reports a GitHub commit status; it never deploys.

**Application environment** — The running application and dependencies targeted by a test. Its availability alone does not mean a business journey passed. Users call it a _twin_, such as the Beta twin.

**Twin service** — One supported dependency of an application environment, such as a database, payment processor, job runner, model or mail server, defined in one file. The file says how the service is detected in a repository, which test credentials the user supplies once, how it starts and which standard variables it provides. A service uses the vendor's official simulation or test mode when one exists and `emulate` only when none does. Product-specific settings live in the twin config, never in a service. Avoid calling a service a mock.

**Owned guest** — An isolated execution environment created and identified by Perpetual, whose operations and cleanup belong to that environment. It is optional for browser tests against an existing URL.
