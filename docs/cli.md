# CLI

Run the CLI from the source directory with `node src/cli.mjs <command>`. To put `perpetual` on your path, run `npm link` there. The package has not been published to npm; a package with the same name on the registry is not this project.

Every command accepts `--data PATH` for the local data directory (default: `.perpetual` in the current directory) and `--repo PATH` for the repository (default: the current directory). Output is JSON unless noted.

## Commands

| Command | What it does |
| --- | --- |
| `perpetual serve --repo PATH [--port 4317]` | Starts the controller and the interface on `http://127.0.0.1:<port>`. The server binds only to loopback. |
| `perpetual scan --repo PATH` | Scans the repository: packages and configuration, Git identity, GitHub workflows and jobs, services, workspace dependencies and Vercel/Railway clues. It does not read `.env` files or execute project scripts. |
| `perpetual providers --repo PATH` | Scans, then reads GitHub, Vercel and Railway status with the credentials in the environment; see [Provider connections](providers.md). |
| `perpetual failure --repo PATH --run RUN_ID` | Reads one GitHub Actions run: its jobs, failed steps, a redacted log excerpt and a rule-based diagnosis. |
| `perpetual init-ci --repo PATH [--output FILE]` | For a repository without workflows, writes a starter validation workflow from its scripts and package manager, by default to `<data>/exports/perpetual-ci.yml`. It refuses when workflows exist and never overwrites a file. Review the file before adding it to your repository. |
| `perpetual sandbox …` | The optional desktop sandbox; see [Desktop sandbox](desktop-sandbox.md). |

`npm start -- --repo PATH` builds the interface and then runs `serve`. After changing the client, run `npm run build`; a running server picks up the rebuilt assets.

## Examples

```sh
node src/cli.mjs serve --repo /absolute/path/to/project
node src/cli.mjs scan --repo /path/to/project
node src/cli.mjs providers --repo /path/to/project
node src/cli.mjs failure --repo /path/to/project --run 123456
node src/cli.mjs init-ci --repo /path/to/project --output /tmp/proposed-ci.yml
```

## Scripts

`node scripts/validate-repository.mjs <repo> <expectations.json>` checks discovery against an expectations file you write for a repository. The file is data, for example:

```json
{
  "workflows": ["CI"],
  "deployments": { "Vercel": 1 },
  "keepsExistingCi": true,
  "copiedTests": { "files": ["test/config.test.mjs"], "run": ["test/config.test.mjs"] }
}
```

- `workflows`: workflow names that must be detected.
- `deployments`: the minimum number of deployment targets per provider.
- `keepsExistingCi`: no starter workflow may be proposed.
- `copiedTests`: repository files copied into a temporary directory, and the `node --test` files run there, for configuration-contract tests.

It does not install or start the application or run its full test suite. The report is printed and written to `artifacts/<expectations name>-validation.json`.

`node scripts/browser-agent-contract.mjs` runs the controller, the browser worker and Chromium against a disposable local page with a deterministic model fixture; see [Business journeys](journeys.md#tests).

## Tests

```sh
npm test               # Node tests
npm run test:browser   # Python browser worker tests, after installing the browser runtime
npm run build          # production build of the interface
```

`PERPETUAL_DOCKER_TESTS=1 node --test test/environment-twin-docker.test.mjs` is an opt-in Docker acceptance test: it runs a disposable app and Mailpit as a real twin, checks the app reaches Mailpit, reads health and logs, and deletes the twin.
