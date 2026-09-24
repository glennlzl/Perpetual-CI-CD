# Twins

A twin is a Sandbox stage's application environment: the product's actual code and the services it depends on, running as a local Docker Compose project whose app URLs a [business journey](journeys.md) can target. The controller owns each twin's lifecycle and each journey's verdict. The design is recorded in [Twins and the journey gate](architecture/twins-and-gate.md).

A twin does not clone a production account, copy production data or create Vercel, Railway or other provider resources. Each dependency comes from one service file in `src/twin/services/`: the vendor's official simulation or local mode when one exists, [`vercel-labs/emulate`](https://github.com/vercel-labs/emulate) only when none does, and never a hand-written mock. A service whose test input is missing is **blocked**; nothing substitutes for it.

A running twin, a healthy app and a passed business journey are separate states. An app that answers HTTP does not prove that its authentication, payments or database are configured correctly.

Requirements: a local Docker Linux engine with Compose. The first twin pulls images and installs app dependencies, which can take several minutes.

## From Pipeline to a twin

1. Add a Sandbox stage such as Beta and confirm the source repository and branch. The stage's twin config and environments belong to that repository and stage.
2. Review the twin config: its apps and services. Detection proposes it the first time the stage is opened.
3. Choose **Create Beta environment** (the button names the stage). The controller copies a filtered source snapshot, records ownership, runs each service's setup, creates test accounts, runs the shared install and the fixtures, then runs `docker compose up --wait`. The environment records how long each step took. It becomes Ready when the twin is up; blocked services are listed with the inputs they are missing.
4. Run reviewed journeys against an app URL. A newly ready environment may prepare journey drafts when a model, the browser runtime and an unambiguous application URL are available; drafts are never approved or run automatically.
5. Delete the environment when finished. Deletion runs `docker compose down --volumes` and each service's teardown. A cleanup failure stays visible and is never reported as a successful deletion.

The environment inspector contains the stage's **Integration tests** and **Runs**. The stage card's **Services** list shows each twin service with its provenance (`Actual`, `Official sandbox` or `Emulate`) and status (`Ready`, `Blocked` or `Not started`); **Connect** on a blocked service asks for its missing inputs.

## The twin config

One config per Sandbox stage, stored as data. For a Next.js app with an API, Supabase and Stripe:

```json
{
  "services": {
    "supabase": { "users": [{ "id": "owner", "email": "owner@example.test" }] },
    "stripe": { "webhook": "{{apps.api.url}}/stripe/webhook" },
    "mailpit": {}
  },
  "install": { "directory": ".", "command": "pnpm install --frozen-lockfile" },
  "apps": {
    "web": { "directory": "web", "build": "pnpm build", "start": "pnpm start", "port": 3000,
             "env": { "NEXT_PUBLIC_API_URL": "{{apps.api.url}}" } },
    "api": { "directory": "api", "start": "pnpm start", "port": 3000 }
  },
  "fixtures": [{ "service": "supabase", "sql": "seed/twin.sql" }]
}
```

- `services` maps a service id to its options. Unknown services are rejected when the config is saved.
- An app runs its `build` and then its `start` command on a pinned Node image with corepack enabled. It must listen on `port` (also given as `PORT`) on all interfaces. Directories are relative to the source root.
- An app variable with the name of a service's standard variable, such as `DATABASE_URL` or `STRIPE_SECRET_KEY`, is filled automatically. Other names map explicitly with `{{<service>.<VARIABLE>}}`, `{{apps.<id>.url}}`, or `{{services.<id>.url.<port>}}` for a service's address on one of its named ports. When two services provide the same variable, the app must map it explicitly.
- Service setup runs in the order that `{{<service>.<VARIABLE>}}` placeholders in service options imply. Unknown placeholders and circular references are rejected when the config is saved. Addresses are allocated before any setup, so they impose no order.
- A service option named `env` is an environment, like an app's: a variable that references a blocked service is left out. Any other option that references a blocked service blocks that service too. An app variable that references a blocked service is left out.
- `install` (optional) runs once, after services are ready and before fixtures and apps, because command fixtures such as seed scripts need workspace dependencies.
- A fixture has exactly one of `sql` (a repository file), `query` (inline SQL kept with the config) or `command`. SQL fixtures run `psql` against the service's `DATABASE_URL`. Fixtures run after services are ready and before apps start.

A plan saved by an earlier version, with services that had install and start commands, is replaced by a fresh detection.

### Detection

Detection reads repository evidence only; it never runs repository code.

- **Apps**: scanned Next.js, Vite, Express, Fastify and Hono packages with a `dev` or `start` script, and any other package with a `start` script. Dependencies install where the nearest lockfile is (`pnpm`, `yarn` or `npm`). A `start` script runs after the package's `build` script. Vite and Next.js commands get host and port flags. Scripts that reach a cloud account or publish (`vercel dev`, `railway run`, `deploy`, …) are not proposed. When two or more apps share one workspace lockfile, detection proposes one `install` step and removes that install from their builds.
- **Services**: each service file's `detect` rules, matched against repository paths, dependency names in `package.json`, `requirements*.txt` and `pyproject.toml`, and variable names in example env files such as `.env.example`. Values are never read, and actual `.env` files are not evidence. A service that already runs another (Supabase runs its own PostgreSQL) replaces it.

## Services

| Service | Provenance | What runs |
| --- | --- | --- |
| `postgres`, `redis`, `mongodb`, `mailpit` | Actual | The official images, with generated passwords. Mailpit accepts any SMTP credentials. |
| `llm` | Actual | A real model. By default the App Settings OpenRouter key and model; with `source: app`, the app's own development values, supplied as the service's inputs. |
| `secrets` | Actual | Internal secrets several apps share, such as a webhook signing secret, generated per twin from `names` ending in `SECRET`, `KEY`, `TOKEN` or `PASSWORD`. Rebuilding rotates them. |
| `supabase` | Official sandbox | Local Supabase through the pinned Supabase CLI. The CLI fixes the local database password to `postgres`. Edge functions, test users and a token issuer on the twin's address are supported. |
| `stripe` | Official sandbox | The user's Stripe test key, `stripe fixtures` and `stripe listen` forwarding the listed events to the twin. |
| `trigger-dev` | Official sandbox | One self-hosted Trigger.dev instance per machine; each twin gets its own project and a `trigger dev` worker running the repository's tasks with an exact CLI version. |
| `emulate` | Emulate | Only vendors with no official simulation: GitHub, Google, AWS, Linear, Vercel API and Apple. It refuses vendors that have an official test mode, such as Stripe, Twilio, Clerk, Okta, Auth0, Resend and Slack. |

Adding a service means adding one file to `src/twin/services/` and one import to `src/twin/registry.mjs`. The file declares how the service is detected, the test inputs it needs, its setup, containers, standard variables, optional test accounts and teardown. Product-specific settings belong in the twin config, never in a service.

### Test inputs

A service may declare inputs, such as a Stripe test secret key. They are test credentials only: validated by pattern, stored once per machine in `<data>/twin-inputs.json` (mode 0600), reused across twins and never sent to the browser. Views say only whether each input is set. Settings the Stripe API cannot make, such as the default customer portal configuration, are saved once in the Stripe sandbox's Dashboard.

### Test accounts

A service can create test accounts once its containers run, before the install and fixtures. Supabase creates its `users` through its local Auth admin API. Each account gets a generated password, stored only in the twin's private state (mode 0600) and redacted from its output; views list the id, label and username. Rebuilding a twin replaces the passwords. A run with no account choice uses the first account, so automatic gate runs need no input.

## Source and data boundaries

Creation copies a working-tree snapshot; it does not modify the original checkout or mount it into the twin. A one-shot container copies the snapshot into the twin's own `workspace` volume, and the install, apps and command fixtures run from that volume, because writing dependencies and build output through a host bind mount is several times slower on Docker Desktop. Package managers keep downloads in one machine-wide volume, `perpetual-package-cache`, which deleting a twin keeps.

The snapshot excludes `.env` files, private-key files, local provider state, dependency and build caches and local database files. Local agent configuration directories (`.codex`, `.agents`, `.claude`) and instruction files (`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`) are excluded at every depth. JavaScript, TypeScript and Python source modules named `credentials` or `secret(s)` are kept, as are `build`, `dist` and `coverage` directories beneath `src`. Symbolic links are not source inputs. Limits: 20,000 files, 256 MiB in total and 32 MiB per file. Filename exclusions do not prove that application source contains no embedded credentials; keep production secrets and customer exports out of the repository and the twin config.

Every address inside a twin is `http://host.docker.internal:<port>`, published on 127.0.0.1 only. Perpetual's browser maps that name to 127.0.0.1, so the browser and the containers use the same URLs. Host ports are allocated upward from 43100 in blocks of 48 per twin. There is no outbound network block: application code, install scripts and page resources can reach networks, and a hardcoded production endpoint is not intercepted.

## Controller API

Every request is scoped to an explicit `repoPath` and Sandbox `stageId`: in the query string for GET, in the JSON body for POST. An environment ID alone does not select another source or stage.

| Method and route | Input |
| --- | --- |
| `GET /api/environments` | Returns the stage's environments and twin config (`plan`). |
| `POST /api/environments/plan` | `plan`: a twin config. |
| `POST /api/environments/create` | Uses the saved config; it needs at least one app. |
| `POST /api/environments/destroy` | `id` |
| `POST /api/environments/logs` | `id`; recent twin logs with secrets redacted. |
| `GET /api/twin/services` | The stage's twin services, their provenance and missing inputs. |
| `GET`, `PUT /api/twin/inputs` | Which inputs are set; `PUT` takes `{service, inputs}`. |
| `POST /api/stages/remove` | Confirms removal of the Sandbox stage and all its owned environments. |
| `GET /api/stages/removal` | Removal progress; reading never starts or retries a removal. |

An environment reports `services` (`id`, `title`, `fidelity`, `status`, `missing`), `apps` (`id`, `url`) and test `accounts` without passwords. Creation and deletion take time: read the current state rather than treating an accepted request as completion.

## Shared use and recovery

Browser journeys, health checks and environment deletion share one reservation per environment. A browser target belongs to an owned environment through its app origins, including loopback aliases and `host.docker.internal`, across stage boundaries. An unrelated external URL needs no twin. A busy environment skips its health check. Independent environments can run at the same time.

Confirmed stage removal persists its source and stage before cleanup. Closing the page or selecting another source does not cancel it. The stage is removed only after every owned environment is cleaned up; a cleanup failure keeps the stage and its reservation for a retry. Startup resumes an accepted unfinished removal, but never silently retries a failed cleanup or replays discovery or tests.

Controller shutdown stops new admissions, stops a twin that is still being prepared at its next step and cleans it up, cancels owned browser workers, and saves final results and ownership. Ready environments remain. Forced termination is different: an interrupted environment operation or browser run leaves the affected environment blocked for cleanup on restart, because application work may still be active. Unrelated ready environments stay usable.

Only one controller may open a given data directory; ownership is acquired before recovery and released after shutdown. This is a same-host guard, not coordination across shared network storage.

Browser process cleanup holds its reservation until owned descendant processes exit. Unconfirmed cleanup quarantines the environment, which then needs explicit deletion before reuse.

The health monitor reads the twin's containers every 30 seconds. A stopped or unhealthy container fails the environment at once; other check errors must repeat first. An environment its health monitor failed is rechecked on the same cadence and becomes Ready again when its containers are healthy. Recovery does not recreate the twin or regenerate tests, and it does not apply to creation failures, interrupted operations, cleanup failures or destroyed environments.

## Runtime storage

Each environment keeps its source snapshot in `<data>/environments/<id>/source` and its twin in `<data>/environments/<id>/twin/`: `compose.yaml`, `.env` (mode 0600, holding every value; `compose.yaml` only references it) and `twin.json`. Deletion removes both. At most eight environments exist at once.

An environment created before Compose twins ran its app in a Cua guest. It loads as Failed with the step Retired, and deleting it removes that guest.

Service and app images are pinned by tag, not by digest, so a twin is not a fully reproducible supply-chain lock.
