# Twins and the journey gate

Status: implemented. Behaviour is documented in [Twins](../twins.md) and [Journey gate](../gate.md).

## Decisions

- Web twins run the product's actual code under Docker Compose. The Cua desktop is only for desktop applications.
- Each external dependency comes from the vendor's official simulation or local mode first, then [`vercel-labs/emulate`](https://github.com/vercel-labs/emulate), and anything else is decided case by case. There are no hand-written API mocks or mock model servers.
- Reviewed journeys are a CI/CD gate that runs on every push to the target branch and on a manual re-run, not an optional schedule.
- Perpetual never branches on a particular product. A product's twin config, fixtures and journeys are data.

## Twin

A twin is a generated Docker Compose project plus a `.env` file. It runs the product's actual app code and the services that code depends on. The runtime writes `compose.yaml` and `.env` (mode 0600) under `<dataDir>/environments/<id>/twin/`, runs each service's setup, then runs `docker compose up --wait`. Teardown runs `docker compose down --volumes` plus each service's teardown. Compose already handles ordering (`depends_on`) and health checks, so Perpetual does not reimplement either.

- Apps run the repository's own code from the source snapshot on a pinned base image. The user's checkout is never mounted.
  - A one-shot `source` service copies the snapshot into the twin's own `workspace` volume, and the install, apps, repository-code services and command fixtures run from that volume. Writing dependencies and build output through a host bind mount is several times slower on Docker Desktop.
  - Package managers keep downloads in one machine-wide external volume, `perpetual-package-cache`, which Perpetual owns and which deleting a twin keeps. pnpm's store is named there explicitly.
  - Each twin records how long every preparation step took, so a slow or failed twin shows where its time went.
- Ports are allocated upward from a base in a block per twin and published on 127.0.0.1.
- Every address inside the twin is `http://host.docker.internal:<port>`. Perpetual's Chromium maps that name to 127.0.0.1, so the browser and the containers see the same URLs.

## Services

Each supported service is one file, `src/twin/services/<id>.mjs`, in a shape similar to `vercel-labs/emulate` packages. Adding a service means adding that file and registering it.

```js
export default {
  id: 'mailpit', title: 'Mailpit', fidelity: 'actual',          // actual | official-sandbox | emulate
  detect: { packages: ['nodemailer'], env: [/^SMTP_/] },           // how a repository shows it needs this service
  includes: [],                                                  // optional: services it already runs, e.g. supabase: ['postgres']
  inputs: [],                                                    // values the user supplies once, e.g. a Stripe test key
  setup: async ctx => ({}),                                      // optional work before containers start; returns outputs
  containers: ctx => [{ name: 'mailpit', image: 'axllent/mailpit:v1.31.2', ports: { smtp: 1025, web: 8025 } }],
  env: ctx => ({ SMTP_HOST: ctx.host, SMTP_PORT: ctx.port('smtp') }),   // the standard variables it provides
  accounts: async ctx => [],                                     // optional: test accounts [{ id, label, username, password }]
  teardown: async ctx => {},                                     // optional
};
```

- `ctx` has four groups of values:
  - `options`: this service's section of the twin config;
  - `inputs` and `outputs`;
  - addressing: `host`, `port(name)`, `url(name, path)`, `app(id).url`, and `sharedPort(name, current?)`, the port of a service's machine-wide instance, reserved once in `<dataDir>/twin-services/ports.json` outside every twin's port block;
  - `run(image, args)` for a pinned CLI image, and `exec(file, args)` for a pinned CLI on the host that drives Docker itself. The Docker socket is never mounted into a container.
- Inputs are test credentials only. They are validated by pattern, stored locally (mode 0600), never sent to the client and reused across twins. A service with a missing input is **blocked**: its variables are left out, and journeys that need it report `blocked (integration)`. Nothing substitutes for it.
- **Choosing a source:** if the vendor offers an official simulation or test mode, use it. Use `emulate` only for services that have none. If an official mode needs a user connection that is missing, the service is blocked; it never falls back to `emulate`.

| id | Source |
|---|---|
| `postgres`, `redis`, `mongodb`, `mailpit` | Actual, from the official images. |
| `llm` | Actual. The App Settings OpenRouter key and model by default, or the app's own development values with `source: app`. |
| `secrets` | Actual. Internal secrets that several apps share, generated per twin. |
| `supabase` | Official local mode through the Supabase CLI. The CLI fixes the local database password to `postgres` and binds its own ports; this is accepted because the CLI is the official local mode. |
| `stripe` | Official sandbox: the user's test key, `stripe listen` and `stripe fixtures`. |
| `trigger-dev` | Official local mode. One shared self-hosted instance per machine; each twin gets a project and a dev worker. `version` is an exact CLI version, built once into a local image; the worker signs in from a 0600 profile file, never from its environment. |
| `emulate` | Only for services with no official simulation: Google and GitHub OAuth sign-in, AWS, Linear, the Vercel API and Apple. |

Services with official test modes get their own files as they are needed, never an `emulate` section: for example Twilio (test credentials), Clerk, Okta and Auth0 (development instances), Resend (test addresses) and Slack (a development workspace).

## Twin config

One config per stage, stored as data. Detection proposes it and the user reviews it. For a Next.js app with Supabase and Stripe:

```yaml
services:
  supabase: { directory: backend/supabase, users: [{ id: owner, email: owner@example.test }] }
  stripe:   { webhook: "{{apps.api.url}}/stripe/webhook" }
  llm: {}
  mailpit: {}
install: { directory: ., command: pnpm install --frozen-lockfile }
apps:
  web: { directory: web, build: pnpm build, start: pnpm start, port: 3000,
         env: { NEXT_PUBLIC_API_URL: "{{apps.api.url}}" } }
  api: { directory: api, start: pnpm start, port: 8080 }
fixtures:
  - { service: supabase, sql: seed/twin.sql }
```

- An app variable that has the same name as a service's standard variable, such as `STRIPE_SECRET_KEY`, is filled automatically. Only other names need an explicit `{{service.VAR}}` or `{{apps.<id>.url}}` mapping.
- `{{services.<id>.url.<port>}}` is a service's address on one of its named ports, such as Supabase's `api`. Ports are allocated before any setup, so an address adds no setup order and is kept whether or not its service is blocked. An address on a port the service never uses fails the twin's preparation.
- Setup runs in the order that `{{service.VAR}}` placeholders imply. Circular references are rejected when the config is saved.
- A service option named `env` is an environment, like an app's: a variable that references a blocked service is left out. Any other option that references a blocked service blocks its service too.
- Supabase edge functions: `functions: { directory?, env?, noVerifyJwt? }`.
  - `supabase start` serves the project's `supabase/functions`, or `directory` when the repository keeps them elsewhere.
  - `env` is written to the functions' env file (mode 0600).
  - Functions listed in `noVerifyJwt` accept requests without a JWT, such as a vendor's webhook.
  - A webhook that a function receives uses the address, never a variable, because the function's env needs the webhook's signing secret:

```yaml
services:
  supabase: { functions: { env: { STRIPE_WEBHOOK_SECRET: "{{stripe.STRIPE_WEBHOOK_SECRET}}" }, noVerifyJwt: [stripe-webhook] } }
  stripe:   { webhook: "{{services.supabase.url.api}}/functions/v1/stripe-webhook" }
```

- Fixtures run after services are ready and before apps start.
- Test accounts come from a service's `accounts(ctx)` hook, which runs once services are ready and before the install and fixtures. Supabase creates its `users: [{ id, email, emailConfirmed?, metadata? }]` through its local Auth admin API.
  - Each account gets a generated password, stored only in the twin's own state file (mode 0600) and redacted from its output.
  - Environment and browser views list accounts as id, label and username only.
  - A run or exploration uses the chosen account; with no choice it uses the first, so automatic gate runs need no input. One account forces serial journeys.
  - Rebuilding a twin replaces the passwords.
- `install` (optional) runs once in its directory, as a one-shot Compose service under its own profile, after services are ready and before fixtures and apps, since command fixtures such as seed scripts need workspace dependencies. Detection proposes it when two or more apps share one workspace lockfile, and removes that install from their builds.

## CI gate

- **Watch.** The controller polls the target branch head through the GitHub connection, with an ETag, every 60 seconds while it runs, and offers a manual **Run now**. There are no inbound webhooks and no public URL.
  - Only a managed GitHub source is watched, and only with the connected account. The first head seen for a branch is a baseline, not a push.
  - **Run now** tests the watched head of a managed source, otherwise the scanned commit.
- **On a new commit:**
  1. Update the managed source copy to that commit in place (fetch it, then reset), so environments stay attached to its path. The user's own checkout is never changed. The move waits until every twin of the pipeline has copied the source.
  2. Rebuild the stage's twin: delete the stage's twins that hold resources, create a new one (a new snapshot, fresh service data, fixtures, accounts) and wait for its browser preparation, which points an automatic application URL at it.
  3. Run the reviewed, selected journeys against the rebuilt twin.
  4. Record the gate per stage and commit in `<dataDir>/gates/state.json`.
- Gates run one at a time, the furthest stage first, so a promoted commit finishes before a newer push moves the source. A stage busy with a person's run or an environment operation keeps its gate queued and is retried every 10 seconds without holding back other stages.
- If a newer commit arrives while a gate runs, the current gate finishes and only the newest pending commit runs next. The skipped commits are recorded as superseded.
- **Verdicts:**
  - `passed` only when the run passed;
  - `failed` only when a journey failed;
  - everything else needs release, with its reason: blocked or needs-review journeys, skipped journeys, a cancelled run, a run that stopped without a failed journey, no reviewed journeys (nothing is rebuilt), a twin that could not be rebuilt, an application URL that is not the rebuilt twin, and a gate interrupted by a controller restart.
- **Commit status** `perpetual/<stage>` through the GitHub API, posted only with the connected account:
  - `pending` "Running" while rebuilding or running;
  - `success` for passed, `failure` for failed;
  - blocked or needs-review stays `pending` with "Needs release" until a person releases it in Perpetual, then becomes `success` ("Released by <user>");
  - queued and superseded gates report nothing. A failed report is kept on the gate and retried; it never holds back the gate or its promotion.
- **Release** needs the connected GitHub account. A failed gate is never released.
- **Promotion:**
  - A passed or released gate starts the next Sandbox stage at the same commit. A commit older than one that already reached that stage is recorded there as superseded.
  - Production shows "Ready" only when every Sandbox gate for that commit is passed or released.
  - Perpetual does not deploy Production. Existing deployment workflows can require the commit status.
- Only reviewed, selected journeys run. Drafts and discovery never run automatically.

## Interface

- The pipeline shows a commit moving through the stages, driven only by real records: Source shows the scanned commit, Build & Deploy shows GitHub Actions results for it, a Sandbox stage shows its twin rebuilding and its journeys running, then the gate result, and Production shows readiness.
- The stage card Badge shows the gate state (`Queued`, `Running`, `Passed`, `Failed`, `Needs release`, `Released`) with the commit; its Tooltip gives the reason or a status report error. Production's Badge shows `Ready` with the commit.
- The stage footer offers **Run now**. Needs release offers a shadcn Alert Dialog **Release** action. Failed never offers release.
- When a gate moves the managed source, the page reloads the scan and keeps the test workspace and its drafts.
- Each twin service's provenance appears as a compact Badge in the stage card's Services list, with no explanatory copy.

## Verification

- Unit tests cover Compose file generation, placeholder resolution, secret redaction, port allocation, the gate state machine (supersede, release, promotion) and commit status mapping.
- An opt-in integration test runs a disposable Compose project with one app and Mailpit.
- Acceptance on a real application means a Beta twin with its actual services, such as local Supabase, the LLM service and a Stripe sandbox when keys are available, and its reviewed journeys run from a real push. Unavailable dependencies stay blocked.
