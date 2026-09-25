# Perpetual

## Language

**Pipeline** — The connected stages through which a project's source, delivery and business verification progress.

**Stage** — A named point in a pipeline, such as Source, Build & Deploy, Beta or Production. A stage's environment readiness and test results are separate states.

**Stage removal** — A confirmed operation that cleans up a Stage's owned environments before removing the Stage. It continues independently of the page that requested it; incomplete cleanup retains the Stage and its resource ownership for retry.

**Test workspace** — The current source and stage's integration cases, test configuration, application environments and run history, together with changes the user has not yet saved. Changing source must not carry those changes into another source's workspace.

**Business journey** — A coherent sequence of user actions leading to a meaningful business outcome, preserving session and business state along the way. Avoid treating an isolated click or internal function check as a journey.

**Business milestone** — An ordered part of a reviewed journey, such as saving and reopening a workflow or verifying a credit change. A milestone completes only when its reviewed checks pass after its actions; completing its actions alone is not a passing result.

**Journey queue** — Bounded execution of the reviewed journeys in a run. Each journey has its own browser worker. Shared application data creates an exclusive barrier; independent test data permits parallel workers. Skipping stops the owned worker but does not roll back application side effects.

**Reviewed case** — A business journey with a user-approved goal, preconditions, expected outcomes and independent checks. Generating a draft does not approve or execute it.

**Journey code** — The Playwright actions of one reviewed case, with no checks of its own: the reviewed checks are evaluated from the case at run time. A case has at most one _approved_ code and one _draft_ beside it. Generated or saved code is always the draft and never replaces the approved code by itself; a person approves a draft after its verification passed, seeing the code or its diff. A gate runs approved code only; a person's run may try a current draft when no approved code is current. Editing the reviewed case makes both stale. Code references call it the journey spec.

**Verification** — The runs a draft must pass before it can be approved: three ordinary runs of exactly that code, then a control run. It holds only for that code and the reviewed case it ran against, so the same code saved for changed checks is unverified. It stops at the first run that does not pass, holds its stage so a gate waits, and a controller restart ends an unfinished one as cancelled.

**Control run** — A verification's last run, in which every state-changing request is blocked except while the fixture signs in. A reviewed check must fail in it: one that passes with nothing kept has checks that cannot tell, and one that ends another way judged nothing. A control run never counts as the journey's current status.

**Expected outcome** — A fixed acceptance condition for a reviewed case. Neither generated code nor a run can change it; a run's reviewed checks back it.

**Agent observation** — The browser agent's reported evidence while it discovers journeys. It is not an independent check or proof of an external side effect, and no run reports one.

**Independent check** — A reviewed condition the fixture evaluates on the live page from the approved case, never one the journey's code contains. Current browser checks observe page text, URLs and numbers; they do not independently establish database or payment outcomes.

**Test run** — One execution of reviewed cases' journey code against an application, retaining the approved case snapshot and its results. Each case keeps its browser session throughout its journey; a fresh session does not reset application data. There are no automatic retries.

**Journey gate** — The decision whether one commit may leave one Sandbox stage: the stage's twin is rebuilt at that commit and its reviewed, selected journeys run their approved journey code; a journey without it needs review. A failed journey fails the gate; any other incomplete result needs a person's release. A passed or released gate moves the commit to the next Sandbox stage, and Production is Ready only for a commit every Sandbox gate passed or released. A gate reports a GitHub commit status; it never deploys.

**Application environment** — The running application and dependencies targeted by a test. Its availability alone does not mean a business journey passed. Users call it a _twin_, such as the Beta twin.

**Twin service** — One supported dependency of an application environment, such as a database, payment processor, job runner, model or mail server, defined in one file. The file says how the service is detected in a repository, which test credentials the user supplies once or, where the vendor allows it, Perpetual creates on the user's request, how it starts and which standard variables it provides. A service uses the vendor's official simulation or test mode when one exists and `emulate` only when none does. Product-specific settings live in the twin config, never in a service. Avoid calling a service a mock.

**Owned guest** — An isolated execution environment created and identified by Perpetual, whose operations and cleanup belong to that environment. It is optional for browser tests against an existing URL.
