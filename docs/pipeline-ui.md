# Pipeline interface

Start the controller as described in the [README](../README.md) and open `http://127.0.0.1:4317`. The server binds only to loopback.

## Canvas

The **Pipeline** page opens directly onto the saved repository's delivery graph, with the left navigation collapsed; the header toggle expands it. Stages run horizontally, **Source → Build → Production**, on a dotted React Flow canvas with directional arrows. Source and Production stay the first and last stages. Without a repository, the page shows **Connect your GitHub** and one **Connect GitHub** button bearing the GitHub mark, which opens the Connect GitHub dialog directly.

The first frame shows the pipeline from its first stage at a readable zoom. When the pipeline is wider than the canvas, pan it. The canvas toolbar holds only zoom and **Fit view**, which shows the whole pipeline at any zoom. The canvas frames itself again after a window or sidebar resize, and after a layout change (a stage added, removed, expanded or collapsed) unless you have panned or zoomed since. Expanding nested content inside a card keeps the current zoom.

Select Source, a service action or a gate to open its configuration in a non-modal Sheet on the right; there is no separate edit mode. On a wide window the Sheet narrows the canvas, and the selected stage is panned into view without zooming. Closing the Sheet restores your previous frame unless you moved the canvas meanwhile. Below 901px the Sheet covers the canvas.

Stages, transition controls and collapse state persist separately for each repository.

## Stage cards

A card grows with its visible content: at least 256px wide and at most `clamp(256px, 70vw, 720px)`, with wrapping labels and natural height rather than an internal scroll area. Following stages are placed from the measured card widths plus a fixed gap, and the connection anchors follow the cards.

Configuration and execution status appears in a shadcn Badge to the right of the stage title. Discovered configuration alone never implies a successful deployment.

Provider rows, tests and nested GitHub workflow steps use shadcn Item and Separator compositions: circular marks on a continuous vertical rail, content on the right, and Collapsible expansion. This is application layout built from registry components, not an official Timeline component. See [Asset provenance](ASSETS.md#registry-components).

## Sandbox stages

The **+** on an eligible connection inserts a **Sandbox** stage there, such as Beta or Gamma. A Sandbox stage follows Build or another Sandbox stage; the Source → Build connection has no insertion control. A pipeline holds at most 12 stages.

Only Sandbox stages offer **Add test**. Their footer also holds **Run now** for the [journey gate](gate.md), **Release** when a gate needs one, and the rename and delete controls. Stage settings only rename the stage. Deleting a stage asks for confirmation and removes it only after its owned environments are cleaned up; see [Twins](twins.md#shared-use-and-recovery).

A Sandbox card lists the stage's twin **Services** and its integration tests. A **Behind** Badge marks a twin built from an older commit than the scanned one; its tooltip shows both commits. The gate Badge (`Queued`, `Running`, `Passed`, `Failed`, `Needs release` or `Released`) shows the commit it applies to, and its tooltip gives the reason or a commit status report error. Production shows `Ready` with the newest commit that every Sandbox gate passed or released; before a gate reports, it reads `Unverified`, or `Not connected` when the repository configures no deployment target.

## Transition controls

The pause control beneath each arrow opens a shadcn Alert Dialog with **Cancel** and **Pause deployment** (or **Resume deployment**). Confirming saves the open or paused state of that transition and keeps any previously saved reason. It does not resize or move the canvas.

These controls describe the pipeline only: they do not block GitHub, Vercel or Railway deployments. The [journey gate](gate.md) is what reports a commit status that branch protection can require. Rollback is not available.

## Build and Production

Build and Production are expanded by default and show their provider rows; each provider group and its nested content start collapsed. Build holds only the workflow runner. Production holds the deployment targets the repository configures, which are its production deployments, never Build steps. An application directory such as `frontend` stays in the underlying scan and is not promoted into a separate step.

- **GitHub Actions**, in Build: one card for every discovered workflow, including those that deploy or configure Vercel preview aliases. Its nested Collapsible list shows each workflow, job and step name. Expanding it does not select, dispatch or change a workflow. Workflow YAML and execution settings stay out of the interface. With a GitHub connection, workflows, jobs and steps carry the status of their GitHub Actions runs for the scanned commit, and the stage Badge combines them; a run for another commit never counts. Runs are polled every 5 seconds while one is active and every minute otherwise, only while the page is visible. Workflows that have no file in `.github/workflows`, such as Dependabot runs, never set the stage status.
- **Vercel**, in Production: a separate group for discovered project previews, including those inferred from alias configuration. Repository clues do not verify cloud access.
- **Railway**, in Production: a separate group. Its drawer keeps only configuration file links, without read-only Build and Deploy field sections.

The backend supplies the delivery projection (`source`, `build` and `production`), and the interface renders those groups as supplied, without reclassifying or filtering providers. Workflow runners and deployment targets stay separate, including targets discovered through workflows. Discovery keeps explicit configuration paths, project names and deduplicated workflow evidence, and bindings follow that evidence rather than connecting every frontend to every Vercel target.

Service settings read the repository's current configuration when opened. A configuration file link opens GitHub's editor for the scanned branch when that branch exists on GitHub (otherwise the path is plain text); edits happen there, not through a local Save button. Repository configuration does not represent verified cloud settings.

Each scan records a `discoveryVersion`. At startup the server attempts one read-only rescan of cached discovery from an older version and saves it while keeping the stages and source; if the rescan fails, the cached data stays. `/api/state` recomputes the delivery projection. A pipeline saved while Build was the single Build & Deploy stage loads with that stage as Build, keeping its state and transitions.

## Branch selector

A shadcn branch Select sits at the upper left of the canvas. It shows the scanned branch and lists the repository's branches through the GitHub connection, with **Load more…** for further pages. Without a connection it offers **Connect GitHub…**, which opens Source settings.

Choosing a branch uses the managed source checkout (see [Provider connections](providers.md#github)) and refreshes the graph. It does not change your working checkout or trigger a deployment, and a branch name never implies a deployment environment. Old `/?view=environments` links open this layout.

## Git graph

The **Git graph** button beside the branch selector opens the same non-modal right-hand Sheet, widened for history. The `@jalco/commit-graph` community registry component draws real commits, parent relationships, branch refs, tags and clickable commit details. `/?preview=branch-map` opens it directly.

- **Current branch** (the default) follows the selected source branch; **All branches** shows the repository-wide history. History loads 100 commits at a time with **Load more**, up to 500.
- For a GitHub source under Perpetual's managed source directory, opening the graph first fetches full commit ancestry and every remote branch head, and **Refresh history** fetches again. Fetches omit file blobs, leave the scanned HEAD and working tree unchanged, and are reused for pagination. Current-branch history follows the fetched remote tip, so newly pushed commits appear after a refresh while the source files stay pinned to the scanned commit. The footer shows **GitHub history**.
- An original user checkout is read-only and shows **Local history**; this feature never fetches or modifies it. **Shallow clone** marks incomplete local history.

The graph is a community registry component, not an official shadcn primitive. Its license and local adaptations are recorded in [Asset provenance](ASSETS.md#registry-components).
