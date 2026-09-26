# Adapters

Each framework under test is one adapter in `adapters/<key>/`, implementing `Adapter` from [`harness.ts`](../harness.ts) and registered in `ADAPTERS`. On OpenRouter over chat completions: `aisdk`, the baseline, and `pi`, `opencode`, `miniswe` and `openai-agents`. On the OpenAI track over Responses: `aisdk-openai`, `agents-openai` and `codex`. `--frameworks all` skips an adapter that cannot run here or does not declare the run's provider, and says why; naming one explicitly is refused. This page defines the contract and what each adapter does.

## The contract

```ts
interface Adapter {
  key: 'aisdk' | 'pi' | 'opencode' | 'miniswe' | 'openai-agents' | 'aisdk-openai' | 'agents-openai' | 'codex';
  version: string;                 // framework@version actually loaded, e.g. read from its package.json
  inBox: boolean;                  // true: the runner attaches the gateway relay before the attempt
  providers?: Partial<Record<'openrouter' | 'openai', 'chat' | 'responses'>>;   // where it runs and the wire API it speaks there; absent: { openrouter: 'chat' }
  available(): Promise<string | null>;   // why it cannot run here (missing binary, venv, lockfile); null when it can
  prepare?(box: BenchBox, signal: AbortSignal): Promise<void>;   // untimed setup, e.g. copy a binary to /opt/bench
  harnessPaths?: readonly string[];      // paths under /workspace the harness writes; removed before the diff
  runAttempt(input: AttemptInput): Promise<AttemptOutcome>;
}
runAttempt({ box, system, prompt, failing, model, gateway: { baseUrl, boxUrl?, token, provider?, wire? }, limits: { steps, timeMs, cost }, signal, scratch, log })
  -> { reason: 'done' | 'steps' | 'time' | 'cost' | 'idle' | 'context' | 'provider' | 'error', steps, summary?, error?, reproduced?, frameworkCost? }
```

### What the runner does, not the adapter

- It creates the box and removes it afterwards.
- It opens and closes the gateway token.
- It applies the time limit: `signal` aborts 30 s after `limits.timeMs`, and the gateway refuses requests after `timeMs`.
- It applies the cost cap: the gateway refuses once the attempt spent `limits.cost`.
- It applies the request cap: 120 requests.
- It removes `harnessPaths`, takes the diff, and judges.
- It counts steps and tool calls from the gateway, the same way for every framework.
- It decides the final reason: a gateway refusal first, then the runner's deadline, then the adapter's `reason`.
- It runs an adapter only against a provider it declares, over the wire API it declares for it, and passes both as `gateway.provider` and `gateway.wire`. `--frameworks all` skips an adapter that does not declare the run's provider; naming it is refused.

### What every adapter must do

1. **Use exactly the given inputs.**
   - The prompt: `prompt`, byte for byte, as the first user message or task.
   - The instructions: `system`, which is the product's `INSTRUCTIONS`.
     - aisdk, openai-agents, aisdk-openai and agents-openai use it verbatim as the system prompt.
     - pi, opencode, miniswe and codex keep their own tuned system prompt and append `appendedInstructions(key, system)`. That is INSTRUCTIONS verbatim, then the harness note from `harnessNote(key)`, so "call done" means the same thing everywhere.
2. **Use only the model it is given.**
   - The model id is `model.id`, exactly. The gateway refuses any other model with HTTP 400 and records a model violation. That includes small, title and summary models, so point every model slot at `model.id` or disable it.
   - Context and output limits come from `model.contextWindow` and `model.maxOutput`.
3. **Reach nothing but the gateway.**
   - A host adapter uses `gateway.baseUrl` (`http://127.0.0.1:<port>/api/v1`) with `gateway.token` as the API key. On OpenRouter it may use the OpenAI-compatible chat completions API only; on OpenAI, `{baseUrl}/chat/completions` or `{baseUrl}/responses`, whichever wire it declared (see [the OpenAI track](#the-openai-track)).
   - An in-box adapter uses `gateway.boxUrl` (`http://gateway:8080/api/v1`). It starts its process with `gatewayEnvironment()` from `box.ts`, so `gateway` joins `NO_PROXY`.
   - Disable telemetry, tracing, update checks, sharing, web fetch and web search, and MCP servers.
   - Never pass the host environment to a command. `box.exec` already gives only the box's own environment.
   - Never write the token anywhere but the process that needs it. It is the only credential an adapter ever holds.
4. **Act only inside the box.**
   - Every file read, file write and command runs through `box.exec` (docker exec) in `/workspace`, or inside the box for an in-box harness.
   - Nothing is read from or written to the host checkout. `scratch` is a private host folder for the adapter's own temporary files.
5. **Finish the framework's way, and report it.**
   - `done`: the model signalled completion (a done tool, a final message, or mini's submit line), with `summary`.
   - `steps`: the framework's own turn limit of `limits.steps` was reached. Set it natively where the framework has one.
   - `idle`: the model stopped without signalling done.
   - `context`: the conversation outgrew the context window.
   - `provider`: the model endpoint returned an error, a gateway 402 included. Put the message in `error`.
   - Let an abort of `signal` throw, or return `time`.
6. **Report `reproduced` where it can be measured, else `null`.**
   - Measure it with the product's rule: `reproduces(command, failing)` from `src/repair/workflow.ts`, for a shell command that exited non-zero before the first file change.
7. **Report `frameworkCost` if the framework tracks cost itself.** It is shown beside the gateway's cost and never used for budgets.

### Tests each adapter adds

- **`test/<key>.test.ts`**: pure units, with no Docker and no network. At least the configuration the adapter builds: model id, base URL, token placement, tools and permissions, and that INSTRUCTIONS are included.
- **`test/<key>.docker.test.ts`**: skipped unless `BENCH_DOCKER=1`. A smoke test on `logic-tier-boundary`:
  - the fake upstream's `solver` behind a real gateway drives at least one shell tool call through the box;
  - the attempt ends at `done`;
  - the diff is non-empty;
  - `judge` passes it.
  
  Remove every container the test created.
- **`node run.ts run --dry-run --frameworks <key> --cases all`** solves every case, as `aisdk` solved round 1's eight.
  - The solver finds the shell tool by the name `run` or `bash`, and fills other required string parameters.
  - It finishes with a `done` tool when one exists. Otherwise it echoes the submit line when a message mentions `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`, and otherwise it answers with plain text.

## The OpenAI track

With `--provider openai` the gateway forwards to `https://api.openai.com/v1` and prices each request from `prices/openai.json` ([README](../README.md#the-model-gateway-gatewayts)). An adapter that runs there:

1. **Declares it.** `providers: { openai: 'chat' }` or `{ openai: 'responses' }`, beside `openrouter` if it runs there too. The wire is the API it sends, and the runner passes it back as `gateway.wire`.
2. **Uses bare OpenAI ids.** `model.id` is an id the price table lists, such as `gpt-6-luna`, never `openai/gpt-6-luna`. `model.contextWindow` and `model.maxOutput` come from the table.
3. **Points an OpenAI client at the gateway.** `baseURL: gateway.baseUrl` (or `gateway.boxUrl` in a box) and `apiKey: gateway.token`. It never reads `OPENAI_API_KEY`, `OPENAI_BASE_URL` or the host's OpenAI configuration; the runner deletes `OPENAI_API_KEY` before loading adapters. Tracing and telemetry stay off, as everywhere.
4. **Works statelessly on Responses.** The gateway sends every Responses request without `previous_response_id` with `store: false` and asks for `reasoning.encrypted_content`. So the adapter:
   - sets `store: false` in its framework too, so the framework replays whole output items instead of `item_reference`s (the AI SDK sends references unless `providerOptions.openai.store` is false);
   - replays reasoning items with their `encrypted_content`, which OpenAI refuses to take without once `store` is false;
   - does not chain with `previous_response_id` or `conversation`: a chain's first request is not stored, so its second fails.

   The fake OpenAI holds requests to the same rules, so a dry run catches an adapter that breaks them.
5. **Uses function or custom tools only.** Hosted tools (`web_search`, `file_search`, `code_interpreter`, `image_generation`, `mcp`, …) and chat's `web_search_options` are refused with 400.
6. **Leaves the tier and the usage to the gateway.** The gateway sets `service_tier: "default"` on every request and `stream_options.include_usage` on a streamed chat completion, whatever the framework sends.
7. **Knows the chat wire's limit.** GPT-6 Sol and Luna call functions over chat completions only with `reasoning_effort: "none"`, which a chat-wire adapter must send itself; the gateway leaves a chat request's `reasoning_effort` as sent. On Responses, the run's `--reasoning` policy governs `reasoning.effort`. `gpt-5.3-codex` is served on Responses only.

Its tests add a dry run with `--provider openai` to the ones above.

## pi

Implemented in `adapters/pi/`: `index.ts` (the adapter), `session.ts` (the pi session) and `operations.ts` (its tools' operations over the box), with `test/pi.test.ts` and `test/pi.docker.test.ts`.

- **Packages.** They are the adapter's own dependencies: `adapters/pi/package.json` pins them exactly and its lockfile pins the rest. Install them with `npm ci --prefix adapters/pi` in `bench/repair`. Until then, `available()` says so, `all` skips pi, and the bench's typecheck fails on the adapter's imports. Verified on npm on 2026-09-25:

  | Package | Version | License | Use |
  | --- | --- | --- | --- |
  | `@earendil-works/pi-coding-agent` | 0.87.1, the latest, published 2026-09-22; Node ≥ 22.19 | MIT | the SDK session, system prompt, loop and tools. Its npm-shrinkwrap.json pins its tree, which npm installs beneath it, pi-ai 0.87.1 and typebox 1.3.27 included |
  | `@earendil-works/pi-ai` | 0.87.1 | MIT | model types, and pi's own context-overflow test |
  | `typebox` | 1.3.27, the version pi pins (1.3.34 is the latest) | MIT | the done tool's schema |

  `@mariozechner/pi-coding-agent` stopped at 0.73.1.
- **Session.** pi's SDK (`createAgentSession`) in the runner's process, so `inBox: false`. Nothing is loaded from disk or the network:
  - in-memory settings and session;
  - a model runtime with no `models.json`, no stored credentials, and no availability pass over the other providers pi knows, which would read the host environment;
  - a resource loader with no extensions, skills, prompt templates, themes or context files (AGENTS.md and the like);
  - `PI_OFFLINE=1`, `PI_TELEMETRY=0` and `PI_SKIP_VERSION_CHECK=1` in the runner's environment, and settings that turn off install telemetry (and with it pi's OpenRouter attribution headers) and prompt-cache warming.
- **Prompt.** pi's own system prompt, with `appendedInstructions('pi', system)` as its appended text. `prompt` is the first user message, byte for byte (`expandPromptTemplates: false`). Two parts of pi's prompt do not fit the box: it suggests `rg`, which the box does not have, and it names pi's own documentation by host paths.
- **Tools.** pi's own `read`, `bash`, `edit` and `write` definitions (descriptions, schemas, truncation) with box operations, registered as custom tools, which replace the built-ins of the same names; and `done` (`summary`), with the product's description. Exactly these five are active. `grep`, `find` and `ls` stay off, as in pi's default set; pi's grep would search with ripgrep on the host.
  - Reads, writes, `mkdir` and access checks are `sh -c` scripts through `box.exec`. A read returns at most 32 MB, as text; images are not detected.
  - `bash` runs `bash -c 'exec 2>&1; cd -- "$1" && eval "$2"'` through `box.exec` in the directory pi names, with the box's environment. The host environment pi builds for a local shell is dropped, and pi's `PI_*` session variables are not exposed.
  - pi's bash has no default timeout. In the box a command gets the product's 300 s unless pi passes one, and at most 900 s.
  - The box keeps the last 1 MB of a command's output. pi shows its usual tail (2000 lines or 50 KB) and names a log of the rest in the host's temp folder; the adapter moves that log into the box at the same path, where the model's reads go, and deletes it from the host.
  - The working directory is the box's `/workspace`, which does not exist on the host. pi only resolves paths against it; its read tool's host existence probes find nothing and fall through to the box.
- **Model.** pi's own OpenRouter entry for `model.id`, when its catalog lists one, which keeps pi's per-model compat flags, thinking levels and prices; otherwise one built from `model`. Either way:
  - `provider: 'openrouter'` and `api: 'openai-completions'`. The catalog's Messages API entries (`anthropic/*`) become chat completions and lose their Anthropic compat flags, since the gateway serves chat completions only;
  - `baseUrl: gateway.baseUrl`, with the token as the runtime's in-memory OpenRouter key;
  - `reasoning`, `contextWindow` and `maxTokens` from `model`.

  pi always streams. Its thinking level (medium by default) goes out as `reasoning.effort`, which the gateway's policy normalizes.
- **Limits and endings.** pi's `finishTurn` hook ends the run at the end of a turn that called `done`, even beside other calls, where pi's `terminate` alone would not stop it. It also ends the run at the turn that reaches `limits.steps` answered turns. A turn with a final answer and no tool call ends it anyway.
  - In each of these cases the adapter aborts the session, which skips pi's post-run work, such as compacting a long conversation for a turn that will not come. Compaction during the run stays pi's default.
  - Failed model calls get 2 session retries, as the product's calls do; a gateway 402 is not retried.
  - An abort of `signal`, or the box's removal for writing too much, aborts the session and throws its reason.
- **Reported.** `done` with its summary; `steps` at the limit; `idle` for a final answer without done; `context` when pi reads the last model error as a context overflow; `provider` for any other model error, with pi's message.
  - `reproduced` applies the product's rule to pi's bash commands and exit codes before its first write or edit.
  - `frameworkCost` is pi's own estimate from its catalog's prices, so only for models it lists.
  - `harnessPaths` is empty: pi writes nothing under `/workspace`. The smoke test checks that the diff holds the fix alone, and that pi accepts the missing host `/workspace`.

## opencode

Implemented in [`opencode/index.ts`](opencode/index.ts), with `test/opencode.test.ts` and `test/opencode.docker.test.ts`. It was read against the source at the `v1.18.32` tag (anomalyco/opencode, commit 545f51d).

- **Versions and licenses** (verified on 2026-09-25):
  - `opencode-ai` 1.18.32 (MIT), npm's latest today. This is `OPENCODE_VERSION` in `src/agents/opencode.ts`. `available()` refuses to run if the product moves to a version the pinned digests are not for.
  - `opencode-linux-arm64`, `opencode-linux-x64` and `opencode-linux-x64-baseline` 1.18.32 from the npm registry, each pinned to its `dist.integrity` (sha512). They have no license field; the license is opencode-ai's MIT. The baseline build serves an x64 CPU without AVX2, as opencode's installer picks it.
  - Inside the binary, from the tag's manifests: `@openrouter/ai-sdk-provider` 2.9.0 and `ai` 6.0.168, built with Bun 1.3.14.
  - `ripgrep` 15.1.0 (Unlicense or MIT) from its GitHub release: `aarch64-unknown-linux-gnu` or `x86_64-unknown-linux-musl`, each pinned to its release sha256. This is the build opencode 1.18.32 would otherwise download itself on first use, inside the attempt's time.
- **Binaries, fetched lazily.** Nothing is fetched by `setup`, and no image is built. The first `prepare()` of a run does this, untimed:
  1. It reads the box's `uname -m` and whether its CPU lists `avx2`.
  2. On the host, it downloads that package and ripgrep, checks both digests, and unpacks them with the host's `tar` into `.cache/opencode/<version>/<variant>`. The folder is moved into place only when whole. Concurrent attempts share one fetch, and a failed fetch is tried again by the next attempt.
  3. It copies the folder to `/opt/bench` in the box. ripgrep goes to `$XDG_CACHE_HOME/opencode/bin/rg`, where opencode looks before downloading it.
  4. `opencode --version` must print the version in the box.
- **In the box**, all outside `/workspace`:
  - `/opt/bench/bin/opencode`;
  - `/opt/bench/opencode.json`, written through stdin with mode 0600, the only place that holds the token;
  - `/opt/bench/INSTRUCTIONS.md`, which is `appendedInstructions('opencode', system)`;
  - its XDG folders under `/opt/bench/opencode`.

  `HOME` stays the box's own, because opencode's bash tool passes its whole environment to the commands it runs. opencode writes nothing under `/workspace` with this config, so there are no `harnessPaths`. At startup opencode also installs its plugin SDK into its own config folder in the background, through the box's egress proxy, as it does on every start.
- **Config (opencode.json):**
  - The provider is opencode's bundled OpenRouter provider (`npm: "@openrouter/ai-sdk-provider"`), with `options.baseURL = gateway.boxUrl` and `options.apiKey = gateway.token`, and `enabled_providers: ["openrouter"]`.
  - Its one model is `model.id`, with `tool_call`, `reasoning`, `status: "active"` and `limit: { context, output }` taken from `model`. `model` and `small_model` are both `openrouter/<model.id>`.
  - `instructions: ["/opt/bench/INSTRUCTIONS.md"]`. opencode keeps its own tuned prompt for the model and appends the file as `Instructions from: …`. An agent `prompt` would replace opencode's prompt, so none is set.
  - `agent.build.steps = limits.steps`. At the limit, opencode's last step is a forced text-only reply.
  - `autoupdate: false`, `share: "disabled"`, and `snapshot`, `formatter` and `lsp` all `false`. No MCP servers or plugins are configured.
  - `experimental.continue_loop_on_deny: true`, so a refused tool call is feedback to the model rather than the end of the run.
- **Permissions.** Every key opencode 1.18.32 has is named, and none is left to ask:
  - allowed: `read`, `glob`, `grep`, `list`, `edit`, `bash`, `todowrite` and `doom_loop`;
  - denied: `external_directory` (`"*"`), `task`, `question`, `webfetch`, `websearch`, `lsp` and `skill`.

  opencode keeps its own truncated tool output readable after these rules. `--auto` is not passed, so a question nothing here foresaw is refused, never approved. 1.18.32 has no `codesearch` tool, and it offers `websearch` only for opencode's own provider.
- **Environment.** `gatewayEnvironment()`, the XDG folders, `OPENCODE_CONFIG`, and these flags set to 1: `OPENCODE_DISABLE_PROJECT_CONFIG` (so the repository's opencode config is not loaded, and its AGENTS.md is not added to the system prompt), `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_PURE`, `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_DISABLE_EXTERNAL_SKILLS`. opencode's dependencies include no analytics. It exports OpenTelemetry only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and the box never sets it.
- **Run.** `env … /opt/bench/bin/opencode --print-logs --log-level WARN run --agent build --model openrouter/<id> --title bench --format json`.
  - The prompt goes on stdin with no message argument. opencode 1.18.32 appends piped stdin to a message argument, so only the prompt alone arrives byte for byte.
  - `--title` skips the title request.
  - Its limit is `limits.timeMs` plus 10 s, which falls between the gateway's deadline and the runner's abort.
- **Outcome.** The JSON events are read as unknown:
  - steps are `step_finish` events;
  - the summary is the last step's text;
  - `reproduced` uses the product's rule on completed bash commands that exited non-zero (or were killed) before any `edit`, `write` or `apply_patch` completed;
  - `frameworkCost` is opencode's own estimate from its catalog prices, reported only when positive.

  The reason is, in order: `time` (its own limit), then `context`, `provider` or `error` for an error the session reported (a gateway 402 included), then `steps`, then `error` for a crash with the stderr tail. Otherwise the reason is `done` when the last step stopped with a final message, else `idle`. The token is replaced in everything kept.
- **Checked only by the Docker smoke test**, which has not been run yet:
  - that Bun honours `NO_PROXY` for `gateway` (if it does not, the proxy refuses `gateway` and the attempt fails closed as `provider`);
  - that the prompt is read from stdin;
  - that only the attempt's model is asked for;
  - that `/workspace` holds nothing but the fix.
- **Deviations from the earlier plan for this adapter:**
  - The provider is opencode's own bundled OpenRouter provider, not a `bench` provider through `@ai-sdk/openai-compatible`. It is what opencode users run, and it keeps opencode's OpenRouter handling, such as usage accounting and reasoning variants.
  - The token is in the 0600 config file, not in an environment variable the config references. Such a variable would put the token in `docker exec`'s argv, and in every command's environment through the bash tool.
  - The binaries are fetched and verified lazily by `prepare()`, not by `setup`.

## miniswe

Implemented in `adapters/miniswe/`: `index.ts` is the adapter, and `driver.py`, `bench_env.py` and `bench_model.py` are mini's side.

- **Packages** (verified on PyPI on 2026-09-25):
  - `mini-swe-agent` 2.4.6 (MIT, published 2026-07-23, Python ≥ 3.10), still the latest release, pinned in `pyproject.toml`.
  - `uv.lock` is committed and pins all 79 dependencies for Python 3.12 (`.python-version`). `.venv/` is git-ignored.
  - What the driver loads from the lock: requests 2.34.2 (Apache-2.0), tenacity 9.1.4 (Apache-2.0), Jinja2 3.1.6 (BSD-3-Clause), pydantic 2.13.5 (MIT), PyYAML 6.0.3 (MIT), rich 15.0.0 (MIT), python-dotenv 1.2.3 (BSD-3-Clause) and platformdirs 4.11.14 (MIT).
  - `litellm` 1.102.1 (MIT) is installed as mini's dependency but never imported, because mini's OpenRouter model speaks HTTP through requests. mini's constraint excludes litellm 1.82.7 and 1.82.8.
  - uv 0.8.22 locks and syncs it.
- **Setup.** `available()` runs `uv sync --frozen` once per process and checks that `.venv` holds the locked mini. Without uv, the adapter is unavailable.
  - `node run.ts setup` and every run ask it before any attempt, so no attempt pays for the sync.
  - The first sync downloads from PyPI.
- **Process.** Each attempt runs one `.venv/bin/python -E -s -X utf8 driver.py` in its `scratch` folder. Bytecode is cached in `.cache/miniswe-pycache`.
  - **Its variables** are `PATH=/usr/bin:/bin`, `LANG` and `HOME=<scratch>`, plus mini's own switches:
    - `MSWEA_SILENT_STARTUP=1`;
    - `MSWEA_GLOBAL_CONFIG_DIR=<scratch>/mini-swe-agent`, so the user's mini config and `.env` are never read;
    - `MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT=3`.
  - **The job** goes over stdin as one JSON object: base URL, token, model id, prompt, appended instructions, limits, and the box's image, root and `uname`. It is never in argv or the environment, and the driver validates every field.
  - **Commands** come back over fd 3 as JSON lines, `{"type":"exec","id":…,"command":…,"timeout":…,"env":…,"interpreter":…}`. Replies go over fd 4, `{"id":…,"output":…,"returncode":…,"timedOut":…}` or `{"id":…,"error":…}`.
  - **The result** is the last line on fd 3: mini's exit status, submission, model calls and cost.
  - Both sides validate every line, and a malformed one ends the attempt. stdout and stderr stay free for mini's own logs, whose tail is logged.
  - mini has no telemetry, update check, web tool or MCP server to turn off.
- **Environment** (`bench_env.py`). `BoxEnvironment` is mini's `DockerEnvironment` with docker replaced by the bridge. It starts and removes nothing, because the runner owns the box.
  - Node runs each command with `box.exec(['env', …mini.yaml's variables, 'sh', '-c', 'exec 2>&1; exec "$@"', 'sh', 'bash', '-lc', command])` in `/workspace`. That is `DockerEnvironment`'s interpreter with stderr merged into stdout in order, under the product's timeout wrapper and disk watchdog.
  - mini gets the last 256 KB of output and elides long output to its head and tail itself.
  - The timeout is 300 s, the product's run default, capped at 900 s. mini.yaml sets none, so `DockerEnvironment`'s 30 s would otherwise apply.
  - A timeout, or a command that cannot run, comes back as `DockerEnvironment` reports an exception: return code -1 and `exception_info`.
  - The template variables carry the box's `uname`, not the host's. On a macOS host, mini.yaml would otherwise tell the model to use `sed -i ''` in a Linux box.
  - mini's own `_check_finished` detects the submit line.
- **Model** (`bench_model.py`). `BenchModel` is mini's `OpenRouterModel`, built by mini's `get_model`, so Anthropic models get mini's cache-control marks. Its request body is mini's: the model id, the messages with their reasoning details, its one `bash` tool, `usage.include`, and no stream. It differs in these ways:
  - the URL is `gateway.baseUrl` + `/chat/completions`, and the key is the token;
  - each request opens a fresh connection that ignores the host's proxy settings and `.netrc`;
  - the request timeout is 600 s instead of mini's hard-coded 60 s;
  - it retries only what the product's AI SDK loop retries (network errors, 408, 409, 429 and 5xx), 3 tries in all, and a 402 or any other 4xx ends the attempt at once;
  - cost is `usage.cost` plus `cost_details.upstream_inference_cost`, as the gateway counts it, and zero is tolerated, so mini's `cost_limit` stops on the gateway's dollars;
  - mini.yaml's `model_kwargs` (`drop_params`, a LiteLLM switch) is not sent.
- **Agent.** mini's `DefaultAgent` with mini.yaml's templates, minus `mode`, which belongs to the interactive agent.
  - The system template is mini's, then `appendedInstructions('miniswe', system)`, passed as a template variable so INSTRUCTIONS are never read as Jinja.
  - The instance template is mini's, with the task set to `prompt`.
  - `step_limit = limits.steps`, `cost_limit = limits.cost` and `wall_time_limit_seconds = limits.timeMs / 1000`.
  - The trajectory is saved in `scratch`, which the runner removes.
- **Outcome.**
  - `Submitted` is `done`, and the text after the submit line is the `summary`.
  - `LimitsExceeded` is `steps` once mini made `limits.steps` calls, else `cost`. `TimeExceeded` is `time`.
  - `RepeatedFormatError`, three replies in a row without a bash call, is `idle`.
  - A model endpoint error is `provider`, or `context` when it says the context window overflowed. Anything else is `error`.
  - An abort of `signal` kills the driver's process group.
  - `frameworkCost` is mini's own cost.
- **reproduced.** The product's rule: `reproduces(command, failing)` for a command that exited non-zero before the first change.
  - With only a shell, a change is the box's diff against its starting commit turning non-empty.
  - That diff is read before each command that runs a failing step's command, until one reproduced or a change was seen.
  - It is `null` when the box has no commit to compare against.
- **Tests.**
  - `test/miniswe.test.ts` covers the job, the environment, the box command, message validation and the outcome mapping. Once `.venv` is synced, it also runs whole attempts of the real driver through a real gateway, in a host-folder box double.
  - `test/miniswe.docker.test.ts` is the smoke test on `logic-tier-boundary`. It also checks that mini started no container of its own.
  - `test_bench_env.py` is a Python unittest with no Docker, and no network beyond a stub on 127.0.0.1. Run it with `cd adapters/miniswe && uv run --frozen python -B -m unittest -v test_bench_env`.

## openai-agents

Implemented in `adapters/openai-agents/`: `index.ts` is the adapter and `tools.ts` turns the product's tools into function tools. It runs on the host, in the runner's process (`inBox: false`), with no `prepare` and no `harnessPaths`. Its version, read from the installed packages, is `@openai/agents@0.18.0 + @openai/agents-extensions@0.18.0 + @openrouter/ai-sdk-provider@3.1.0`.

- **Packages.** Pinned exactly in the bench's `package.json`, verified on npm on 2026-09-25:

  | Package | Version | License | Role |
  | --- | --- | --- | --- |
  | `@openai/agents` | 0.18.0, published 2026-09-10, the latest | MIT | the SDK: `Agent`, `Runner`, `tool` |
  | `@openai/agents-extensions` | 0.18.0 | MIT | `aisdk()` from `./ai-sdk`, the SDK's AI SDK adapter |
  | `zod` | 4.6.5 | MIT | a required peer of the SDK; no zod schema is used |
  | `ai` | 7.0.114, the root's version | Apache-2.0 | the extensions' optional peer. It brings `@ai-sdk/provider` 4.0.18, whose types the adapter's declarations name, and the adapter reads `APICallError` from it |

  The lock pins the rest, among them:
  - `@openai/agents-core`, `-openai` and `-realtime` 0.18.0 (MIT);
  - `openai` 7.23.0 (Apache-2.0), which is never called;
  - `ws` 8.21.3 (MIT), a required peer of the extensions;
  - `debug` 4.4.3 (MIT);
  - `@modelcontextprotocol/client` 2.1.0 (MIT), an optional dependency of the core that is never started.

  The `./ai-sdk` entry imports nothing from `ai` at run time. The two copies of `ai` 7.0.114, the root's (behind the product's model and tools) and the bench's, meet only through duck-typed objects and `Symbol.for` error markers.
- **Model.** `aisdk(openrouterModels({ fetch: gatewayFetch(gateway.baseUrl) })(model.id, gateway.token))`, with `gatewayFetch` from `adapters/aisdk`.
  - The provider and wire format are the baseline's, and only the loop differs.
  - The adapter passes the provider's reasoning parts on with their metadata, so OpenRouter's `reasoning_details` go back to the model. `OpenAIChatCompletionsModel` would drop them.
  - No model setting is set (max tokens, temperature, tool choice or reasoning), as the baseline sets none. The gateway's reasoning policy applies.
- **Tools** (`tools.ts`). Each of `repairTools(box, { signal, events })` becomes `tool({ name, description, parameters, strict: false, execute })`:
  - The name, description and JSON schema are unchanged, so the model is offered exactly the baseline's tools. Strict mode would rewrite optional properties as required and nullable, so `strict` is `false`.
  - `execute` runs the product's tool and answers `JSON.stringify(result)`, the text the AI SDK sends for an object result. A refusal is an ordinary result, which the model reads and adapts to.
  - `done` answers `{"ok":true}`.
- **Agent and run.** `new Agent({ name: 'repair', instructions: system, model, tools, toolUseBehavior: { stopAtToolNames: ['done'] } })`, run by `new Runner({ modelProvider, tracingDisabled: true, toolNotFoundBehavior: 'return_error_to_model' }).run(agent, prompt, { maxTurns: limits.steps, signal, context })`:
  - The prompt is the first user message, byte for byte. INSTRUCTIONS are the system message, verbatim.
  - `signal` combines the runner's signal, the box's and a timer at `limits.timeMs`, as the product's loop does.
  - `reproduced` comes from the tools' `run` and `change` events, with the product's `reproduces` rule.
  - `steps` is the SDK's own count of model responses, `RunContext.usage.requests`.
- **Endings.**
  - `done`: the run stopped at a done call. The summary is its input's `summary`, up to 4000 characters, as the product reads it. A malformed input still stops the run, with no summary.
  - `idle`: the model answered with text and no tool call, which the SDK takes as its final output.
  - `steps`: `MaxTurnsExceededError`.
  - `time`: the timer fired. An abort of the runner's signal or of the box's is rethrown.
  - `context`: the error matches the product's context-window rule.
  - `provider`: any other error from the model endpoint, such as the gateway's 402, worded as the product words it (`{"code":…,"message":…}`).
  - `error`: an error of the SDK itself (`AgentsError`), such as a model behaving outside its rules.
  - `frameworkCost` is not reported, since the SDK counts tokens, not dollars. The attempt has no cost stop of its own: the gateway's 402 ends it, and the runner records `cost`.
- **Nothing reaches OpenAI.**
  - Importing `@openai/agents` registers OpenAI's trace exporter. The adapter calls `setTracingDisabled(true)`, removes the exporter with `setTraceProcessors([])`, and its runner disables tracing as well.
  - `OPENAI_AGENTS_DISABLE_TRACING` is not set: the SDK reads it once, on import, so setting it afterwards would change nothing.
  - The runner's model provider refuses every model name. So the default `OpenAIProvider` is never asked, no OpenAI client is made, and `OPENAI_API_KEY` is never read.
  - The token lives only in the provider's configuration, in memory.
- **Beyond the definition this section first gave:**
  - A `Runner` instance, rather than the `run()` helper, holds the provider, tracing and tool settings of one attempt.
  - `toolNotFoundBehavior: 'return_error_to_model'`: a call to an unknown tool, such as `bash`, answers the model with `Tool 'bash' not found.`, as the AI SDK loop answers such a call. The SDK's default would end the attempt.
  - Errors of the SDK itself end as `error`, not `provider`.
- **What this arm measures beyond the baseline:**
  - Retries: the SDK retries no model call by default, while `generateText` retries a retryable error, such as a 429 or 5xx response, twice.
  - Reasoning: the adapter replays reasoning as an assistant message of its own, before the one with the tool calls.
  - Tool choice: the SDK sends no `tool_choice`, where the baseline sends `auto`.
  - Replies: like `generateText`, the SDK runs a turn's tool calls in parallel and takes a reply with text and no tool call as final. A reply with neither text nor a tool call makes the SDK ask the model again, where `generateText` stops, idle.
- **Tests.**
  - `test/openai-agents.test.ts` checks the tool conversion (names, descriptions, schemas, strictness, refusals as results) and the agent and runner (INSTRUCTIONS, model, done, tracing, no named model). It checks that the first request equals the baseline's: model, messages and tools.
  - It then runs attempts through the gateway with the fake upstream in a host-folder box: done with `reproduced`, the turn limit, idle after a refusal and an unknown tool, a 402 refusal, a context-window error, the time limit, and a stopped runner.
  - `test/openai-agents.docker.test.ts` is the `logic-tier-boundary` smoke test.

## agents-openai

The OpenAI track's Agents SDK arm, declared as `providers: { openai: 'responses' }`. It gets the same box, prompt, INSTRUCTIONS, tools, change rules and judge as every framework. The loop is the Agents SDK's, on OpenAI's own Responses API rather than chat completions.

- **Packages** (verified on npm on 2026-09-25), pinned exactly in the bench's `package.json` and lockfile, the same install the openai-agents arm loads:
  - `@openai/agents` 0.18.0 (MIT), published 2026-09-10, with `@openai/agents-core`, `@openai/agents-openai` and `@openai/agents-realtime` 0.18.0 (MIT);
  - `openai` 7.23.0 (Apache-2.0), published 2026-09-23: the client the adapter builds, which the SDK's `^7.2.0` dedupes to;
  - `zod` 4.6.5 (MIT), published 2026-09-13: the SDK's required peer. The adapter defines no zod schema.

  The lockfile also holds agents-core's optional `@modelcontextprotocol/client` 2.1.0 (MIT) and realtime's `ws` 8.21.3 (MIT), which an attempt never loads.

  **Install** with the bench's `npm ci`. `available()` refuses until the installed `@openai/agents` and `openai` are the pinned versions, and the SDK loads only inside an attempt. The adapter first pinned them in a package of its own under `adapters/agents-openai`; merged beside openai-agents, that made a second install of the same SDK and client, whose classes (the client's private fields) no longer matched in the typecheck, so the two arms now share the bench's one install.
- **Model.** The SDK's native `OpenAIResponsesModel` for `model.id`, a bare OpenAI id such as `gpt-6-luna`, over `new OpenAI({ baseURL: gateway.baseUrl, apiKey: gateway.token })`:
  - `adminAPIKey`, `organization`, `project` and `webhookSecret` are null and logging is off, so no `OPENAI_*` variable adds a key or header. The client's fetch reaches `gateway.baseUrl` only and sends only the client's own headers, dropping any that `OPENAI_CUSTOM_HEADERS` adds.
  - The runner's model provider throws, so a model name never resolves through OpenAI's default provider.
  - Every request has `store: false`. OpenAI keeps nothing, the loop resends the conversation, and no request names `previous_response_id`.
  - When `model.reasoning`, requests include `reasoning.encrypted_content`, so each turn's reasoning items return to the next turn with their encrypted content. Only a reasoning model returns reasoning items, so the include is sent only then.
  - No reasoning effort, verbosity, temperature or output limit is set. A model instance gets none of the SDK's GPT-5 defaults, so the gateway's `--reasoning` policy alone decides.
  - Retries are the client's own: 2, for 408, 409, 429, 5xx and connection errors. A gateway 402 is never retried.
- **Tools.** The product's seven repair tools, `repairTools(box, { signal, events })`, as SDK function tools:
  - the same names, descriptions and JSON schemas (each tool's `inputSchema.jsonSchema`, read as unknown, as the openai-agents arm reads it, since the product's `ai` and the bench's copy type schemas against different zod versions), with `strict: false` because the product's schemas have optional properties;
  - each runs the product tool and returns its result as JSON, as the product's loop sends it;
  - `done` ends the run through `toolUseBehavior: { stopAtToolNames: ['done'] }`, and `summary` is the model's `done` call's;
  - `reproduced` comes from the tools' `run` and `change` events, by the product's rule;
  - a call of an unknown tool answers the model with the SDK's error (`toolNotFoundBehavior: 'return_error_to_model'`), as the product's tools answer theirs. The SDK's default would end the run.
- **Run.** `new Runner({ tracingDisabled: true, … }).run(agent, prompt, { maxTurns: limits.steps, signal })`, not streamed, as the product's loop is not. INSTRUCTIONS are the agent's instructions verbatim, and `prompt` is the one user message.
  - Tracing: before every attempt, `setTracingDisabled(true)` and `setTraceProcessors([])`, beside the runner's `tracingDisabled`. Nothing is traced, and no exporter is left to reach OpenAI's tracing endpoint.
  - Abort: the runner's signal, the attempt's own `limits.timeMs` and the box's signal, combined as the product's loop combines them. The model request and running tool commands stop with it.
  - Ends: `done`; `MaxTurnsExceededError` is `steps`; a final message without done is `idle`; the attempt's own time limit is `time`; `context_length_exceeded` is `context`; an SDK configuration error (`UserError`) is `error`; any other error, a gateway 402 included, is `provider` with its redacted message.
  - There is no cost stop inside the loop, since OpenAI reports no cost; the gateway's 402 enforces the cap. `frameworkCost` is not reported, because the SDK counts tokens, not dollars. `steps` counts completed model responses.
- **What it needs from the gateway.** The OpenAI track: `POST {baseUrl}/responses` as JSON, forwarded to OpenAI's `/v1/responses` with the real key under the gateway's store rule (every request here has `store: false` and no `previous_response_id`), and priced from `prices/openai.json`. The runner refuses this adapter under `--provider openrouter`, and `--frameworks all` there skips it.
- **Tests.** `adapters/agents-openai/fake-responses.ts` stands in for the gateway's `/responses` route. It is a Responses endpoint on 127.0.0.1 with scripted replies, and it also puts the dry-run solver behind Responses requests.
  - `test/agents-openai.test.ts` is pure: the fetch guard and readiness, then, once the bench's `npm ci` has run, the SDK loop in the product's host-folder box double. It checks the request (model, token, instructions, prompt, `store`, the include, the seven tools and their schemas), reasoning passed back encrypted, done, steps, idle, an unknown tool, provider, context, time and abort, and that nothing but the gateway is reached whatever `OPENAI_*` variables are set.
  - `test/agents-openai.docker.test.ts` runs with `BENCH_DOCKER=1`: the solver behind the fake drives four steps on logic-tier-boundary in a bench box, and the judge passes the diff.

## codex

The OpenAI Codex CLI on the OpenAI track: OpenAI's own agent loop, tools, base instructions and compaction, run inside the bench box as headless `codex exec --json`. It is implemented in `adapters/codex/` and declares `providers: { openai: 'responses' }`. Codex 0.157.0 speaks only the Responses API (`wire_api = "chat"` was removed), so it never runs on the OpenRouter track.

- **Package** (Apache-2.0, verified on npm on 2026-09-25): `@openai/codex` 0.157.0, the `latest` dist-tag, published 2026-09-25 from the tag `rust-v0.157.0`. No npm dependency is added to bench/repair. Its Linux builds are versions of the same package, the optional dependencies its launcher resolves:
  - `@openai/codex@0.157.0-linux-arm64` (`aarch64-unknown-linux-musl`): a 143 MB download, 345 MB unpacked, integrity `sha512-67Y2HL4s…Wi8fLA==`;
  - `@openai/codex@0.157.0-linux-x64` (`x86_64-unknown-linux-musl`): a 150 MB download, 391 MB unpacked, integrity `sha512-3TEPslRa…37rLJQ==`.

  Each carries Codex's package directory under `package/vendor/<triple>`:
  - `bin/codex`;
  - `bin/codex-code-mode-host`, the V8 host of code mode, which the catalog entries of the gpt-6 and gpt-5.6 families use (`tool_mode = "code_mode_only"`);
  - `codex-path/rg`, ripgrep 15.2.0 (MIT or Unlicense), which Codex puts on its PATH;
  - `codex-resources/`, bubblewrap (LGPL-2.0-or-later) and a patched zsh, both unused here.
- **Release, fetched lazily** (`release.ts`). The product box accepts only official `node:`, `python:`, `golang:` and `buildpack-deps:` images, so there is no baked image. `prepare()` does four things, untimed:
  1. It reads the box's `uname -m`: `aarch64` or `x86_64`.
  2. Once per run and platform, it downloads the tarball from the registry and streams it through sha512. Anything but the pinned integrity is refused before a byte is unpacked. It then unpacks `package/vendor/<triple>` into the git-ignored `.cache/codex/0.157.0/<platform>/` and marks it verified. Later runs reuse it.
  3. It copies it into the box at `/opt/bench/codex` (root-owned) and creates Codex's home, `/opt/bench/codex-home`, both outside `/workspace`.
  4. It checks that `codex --version` names 0.157.0.

  `harnessPaths` is empty: Codex keeps its sessions, logs, state database and `apply_patch` alias in its home.
- **Run.** One `box.exec` per attempt, with stdin `<token>\n<prompt>`, under the box's time limit of `limits.timeMs`:
  ```
  env CODEX_HOME=/opt/bench/codex-home NO_PROXY=…,gateway no_proxy=…,gateway \
    sh -c 'IFS= read -r BENCH_TOKEN || exit 2; export BENCH_TOKEN; unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; exec "$@"' sh \
    /opt/bench/codex/bin/codex exec --json --color never --strict-config --skip-git-repo-check --cd /workspace -
  ```
  - **The token.** Stdin's first line becomes `BENCH_TOKEN`, in Codex's own process only. It is never in argv, config.toml, a file or a log, but Codex 0.157 passes it to every command it runs: its `exec_command` ignores `shell_environment_policy`, whether the token is excluded by name, by Codex's own `*TOKEN*` default or by `inherit = "core"` (checked in the Docker smoke test, which records it as a diagnostic). The config still names it in `exclude`, in case a later Codex honours the policy. For a product adoption this matters: Codex's provider key is visible to the commands it runs. Codex does not make itself non-dumpable, so a command in the box could still read it from `/proc/<pid>/environ`, as opencode's plan leaves its token in a config file. It is only the attempt's token, capped by the gateway and revoked when the attempt ends.
  - **The task.** The rest of stdin. `codex exec -` reads it to its end without trimming, so the prompt is the first user message, byte for byte.
  - **The instructions.** `developer_instructions` is `appendedInstructions('codex', system)`: INSTRUCTIONS verbatim, then `harnessNote('codex')`. Codex sends it as a developer message after its own base instructions for the model, which stay. The `instructions` key would replace those, so it is not used.
  - **The network.** Codex's own process runs without `HTTP(S)_PROXY`, so it can reach `gateway` (the relay) and nothing else, whatever feature might phone home. `shell_environment_policy.set` gives the commands it runs the box's proxy settings back, so package installs work as in the product box.
- **config.toml** (`configToml` in `codex.ts`). It is read with `--strict-config`, so a key 0.157.0 does not know fails the attempt instead of being ignored.

  | Key | Value | Why |
  | --- | --- | --- |
  | `model`, `model_provider` | `model.id`, `bench` | the one model slot, at the one provider |
  | `[model_providers.bench]` | `base_url` = `gateway.boxUrl`, `env_key = "BENCH_TOKEN"`, `wire_api = "responses"`, `requires_openai_auth = false`, `supports_websockets = false` | the gateway over HTTP, keyed by the token. As a custom provider, Codex fetches no model catalog, compacts through `/responses` rather than `/responses/compact`, and sends no zstd bodies |
  | `model_context_window` | `model.contextWindow` | the bench's limit; Codex caps it at its catalog's maximum for the model |
  | `service_tier` | `"default"` | never the catalog's priority tier, which the gateway does not price |
  | `approval_policy`, `sandbox_mode` | `"never"`, `"danger-full-access"` | see below |
  | `web_search` | `"disabled"` | |
  | `[features]` | `apps`, `plugins`, `image_generation` off | ChatGPT connectors and plugins, and a hosted image tool outside token pricing |
  | `[agents] enabled` | `false` | no sub-agents, as opencode's `task` tool is denied: one agent and one count of steps |
  | `[skills]`, `project_doc_max_bytes` | bundled skills and their instructions off; `0` | no skills or AGENTS.md, as for pi and opencode |
  | `[analytics]`, `[feedback]`, `[otel]`, `check_for_update_on_startup`, `[history]` | off; off; every exporter `"none"`; `false`; `"none"` | no telemetry, which includes metrics to Statsig by default; no update check and no history file |

  Everything else stays Codex's default. That covers its base instructions and tools (for the gpt-6 and gpt-5.6 families, code mode: a JavaScript `exec` tool, and `wait`, that call Codex's tools), the reasoning effort and verbosity from its catalog, compaction and retries. A model missing from 0.157.0's bundled catalog runs on Codex's fallback metadata, with a warning.
- **Sandbox and approvals.** The box itself is the sandbox, so Codex runs with `sandbox_mode = "danger-full-access"` and `approval_policy = "never"`. The reasons:
  - The box is the product's repair box. It has an internal network whose only exits are the egress proxy and the relay, the product's capabilities with no-new-privileges, memory, CPU and process limits, no mounts and no socket. Every framework's commands run inside it, the product's `run` tool included.
  - Codex's own Linux sandbox is bubblewrap with seccomp and Landlock. It needs namespaces that the box's dropped capabilities and no-new-privileges do not grant. A nested `workspace-write` sandbox would therefore fail commands, or confine them differently from every other framework.
  - Nobody answers approvals in a headless run. Under `on-request` a command the model wanted escalated would come back refused, and auto-review (`approvals_reviewer`) would call another model. `never` returns every failure to the model directly. It is also `codex exec`'s own default.
  - `--dangerously-bypass-approvals-and-sandbox` sets the same two values. The adapter sets them in config.toml instead, where `--strict-config` checks them and the unit test reads them.
- **Outcome** (`readRun` in `codex.ts`), from the JSONL events, validated as unknown:
  - **steps**: completed `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call` and `web_search` items, code mode's nested calls included. Codex has no turn limit of its own, so the gateway's request limit (1.2 × `limits.steps`) ends a long attempt, and the runner records that as `steps`.
  - **done**: `turn.completed` with a non-empty last agent message, which is the `summary`. A completed turn without one is `idle`.
  - **context** or **provider**: `turn.failed`. It is `context` for a context-window error, else `provider` with Codex's message. A gateway refusal reads `unexpected status 402 Payment Required: Bench limit: …`. Codex retries such a request up to `stream_max_retries` (5) times with backoff, each refused again at no cost, before the turn fails.
  - **time**: the box's `timeout` stopped Codex at `limits.timeMs`. The events it wrote before that are still read.
  - **error**: no terminal event at all, such as a config error. The error holds stderr's last lines.
  - **reproduced**: the product's `reproduces()`, on the script inside Codex's `/bin/bash -lc '…'` wrapper, for a command that exited non-zero before the first applied `file_change`.

  Each item is logged compactly: the command, its exit code and a 2 KB output tail; file paths; messages; usage. There is no `frameworkCost`, since Codex reports tokens only.
- **The OpenAI track's rules.** Codex keeps them as it runs:
  - It is stateless on Responses. It always sends `stream: true`, `store: false` and `include: ["reasoning.encrypted_content"]`, replays whole items with their encrypted reasoning, and never chains with `previous_response_id` over HTTP.
  - With web search and image generation off, its tools are function and custom tools only. `tool_search` is registered only beside deferred MCP or app tools, and there are none.
  - The gateway forwards one header for it, `x-openai-internal-codex-responses-lite: true`, besides `content-type` and `accept` (`PASSED_HEADERS` in `gateway.ts`); it carries no credential. The catalog entries of the gpt-6 and gpt-5.6 families set Responses Lite. Codex then sends its instructions and tools as input items (`additional_tools`) and marks the request with this header, and OpenAI may refuse such a body without it. Codex also sends `originator`, `session_id` and `x-codex-*` headers. gpt-5.5 does not use Responses Lite.
- **Tests.**
  - `test/codex.test.ts` (pure). It covers:
    - config.toml, parsed as TOML, and TOML escaping;
    - the argv, and the launch shell's stdin handoff, run with the local `sh`;
    - the wrapper parsing, every end and the reproduced rule;
    - the release's integrity refusal, shared download and disk cache, with a synthetic tarball;
    - an attempt against a box double, and the registration.
  - `test/codex.docker.test.ts` (`BENCH_DOCKER=1`). It runs logic-tier-boundary with the real release in a real box, driven by a scripted Responses API reached through the relay. The script stands in for the gateway's Responses route and checks the token itself. It checks:
    - the request: the prompt byte for byte, the developer instructions, Codex's own base instructions, and no web search, image or sub-agent tool;
    - that commands keep the proxy and never see the token;
    - that Codex asked the host for nothing else, and wrote nothing of its own in `/workspace`;
    - that the judge passes the diff.
  - **Not yet possible:** the dry run (`--provider openai --dry-run --frameworks codex`). The dry-run solver finds a shell tool named `run` or `bash`, but Codex's is `exec_command` (`cmd`). It needs `yield_time_ms: 30000` and `write_stdin` polls while a command runs, as `next()` in the smoke test does.
- **Things to verify** in the smoke test and the first paid run:
  - that the relay route works with Codex's HTTP client and no proxy;
  - that `--strict-config` accepts every key;
  - that commands get the proxy back through the shell snapshot;
  - that OpenAI accepts Codex's Responses Lite requests as the gateway forwards them.
