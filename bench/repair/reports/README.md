# Repair-agent framework bake-off: summary (2026-09-25)

The question: which agent framework should the build repair agent (`src/repair/`) use? Keep the loop written on the Vercel AI SDK 7, or switch to pi, OpenCode, mini-swe-agent, the OpenAI Agents SDK or Codex?

The answer: **keep the loop.** Every framework produces a correct change about as often; what separates them is whether they end cleanly. The product loop lost on the ending, and with a verified ending (21f3a2e) it matches the strongest framework at one of the lowest costs. Three rounds, 1264 attempts, $6.20 in all.

Details: [round 1](2026-09-25-round1.md) · [round 2](2026-09-25-round2.md) · [round 3](2026-09-25-round3.md) · the bench itself in [../README.md](../README.md).

## Method

- **The same conditions.** Every framework uses the product's own repair box (Docker, network only through the egress proxy, no route to the host), the same failure context and prompt, the same change rules and the same judge.
- **The judge.** The framework's diff is applied in a fresh box, hidden tests are added, and CI runs again. A fix counts only when CI is green, no change rule was broken, and no test or CI file was changed.
- **The model gateway.** Every framework reaches the model through a gateway on the host. The real key lives only in the gateway process; the gateway sends `data_collection: deny`, does all the accounting and enforces the caps ($0.50 per attempt, a budget per round). A framework that runs inside the box (OpenCode, Codex) holds only a token valid for one attempt.
- **The cases.** 20 general repair cases, each with a reference patch, hidden tests and trap fixes (changing tests, disabling rules, forcing UTC, hard-coding), all passing their self-check before the run. Round 1 had 8 of them.
- **Two readings.**
  - **strict:** the judge passed and the agent called `done`, the product's rule at the time;
  - **lenient:** the judge passed, whether or not `done` was called.

## Frameworks

| Framework | Version | Runs | Model access |
| --- | --- | --- | --- |
| AI SDK (the product loop, the baseline) | ai 7.0.114 + @openrouter/ai-sdk-provider 3.1.0 | on the host, tools through docker exec | OpenRouter |
| pi | @earendil-works/pi-coding-agent 0.87.1 | on the host, tools through docker exec | OpenRouter |
| OpenCode | opencode-ai 1.18.32 | inside the box | OpenRouter |
| mini-swe-agent | 2.4.6 | on the host (uv), commands through docker exec | OpenRouter |
| OpenAI Agents JS | @openai/agents 0.18.0 (AI SDK adapter) | on the host | OpenRouter |
| AI SDK + Responses | ai 7.0.114 + @ai-sdk/openai 4.0.77 | on the host | OpenAI directly |
| Agents SDK native | @openai/agents 0.18.0 + openai 7.23.0 | on the host | OpenAI directly |
| Codex | @openai/codex 0.157.0 | inside the box | OpenAI directly |

Not entered: the Claude Agent SDK (a proprietary licence, which conflicts with the AGPL, and Anthropic models only); Mastra (the AI SDK underneath); LangGraph and Deep Agents (reasoning content is lost through OpenRouter); OpenHands (the key must enter the box).

## The three rounds

| Round | Cases | Models | Attempts | Cost | Purpose |
| --- | --- | --- | --- | --- | --- |
| 1 | 8 | GPT-6 Luna | 64 | $0.16 | Run the whole pipeline; 7–8 of 8 everywhere, so the cases were too easy to separate the frameworks |
| 2 | 20 | GPT-6 Luna, GPT-5 nano | 960 | $5.08 | Harder cases and a weaker model to separate them |
| 3 | 20 | the same | 240 | $0.96 | Measure the product loop with the verified ending |

## Round 2 (60 attempts per cell: 20 cases × 3 seeds)

| Framework | Luna strict | Luna lenient | nano strict | nano lenient | Luna cost per attempt |
| --- | --- | --- | --- | --- | --- |
| OpenCode | 95% | 95% | 60% | 60% | $0.0057 |
| OpenAI Agents JS | 87% | 92% | 3% | 62% | $0.0032 |
| Agents SDK native | 87% | 92% | 0% | 68% | $0.0015 |
| AI SDK + Responses | 83% | 93% | 0% | 65% | $0.0015 |
| pi | 85% | 87% | 13% | 53% | $0.0032 |
| mini-swe-agent | 85% | 85% | 57% | 57% | $0.0036 |
| AI SDK (the product loop) | 80% | 85% | 0% | 67% | $0.0031 |
| Codex | 80% | 80% | 13% | 15% | $0.0028 |

## Round 3: the product loop with a verified ending

The rule: when the model has changed files and stops without calling `done`, the failing step's own script runs again in the box as CI runs it (`bash -e`, pipefail, the original working directory); all passing counts as done, and the pull request description says so.

| The product loop | Before (strict) | After (strict) |
| --- | --- | --- |
| OpenRouter + GPT-6 Luna | 80% | **92%** |
| OpenRouter + GPT-5 nano | 0% | **53%** |
| OpenAI directly + GPT-6 Luna | 83% | **93%** |
| OpenAI directly + GPT-5 nano | 0% | **58%** |

Against round 2's strongest, OpenCode (Luna 95%, nano 60%): level within noise, at about half its cost with Luna, and the loop, its permissions and its security boundary stay in Perpetual's hands.

## Findings

1. **Correct changes come about as often.** Lenient: Luna 80–93%, nano 53–68% (Codex only 15%).
2. **The gap is the ending.** OpenCode and mini-swe-agent have their own completion protocol, so strict equals lenient; every loop that relies on the model calling `done` leaks results. In round 2 the product loop with nano made a correct change in 40 of 60 attempts and never once called `done`.
3. **Codex needs a strong model.** With nano it changed nothing in 42 of 60 attempts, at 3–6 times the cost per attempt of the others.
4. **The hardest thing is a complete fix.** The monorepo case passed 1 attempt in 48: the agent fixed the package that failed and missed the other one the same API change broke, which had no test.

## Decisions

- **Keep the AI SDK 7**; the verified ending is in the product (21f3a2e).
- **Exclude Codex**: poor with a small model, expensive, and the security finding below.
- **Stay on OpenRouter.** With the same GPT-6 Luna, OpenAI directly costs about half per attempt at the same success rate, but the two cost figures are not the same kind (OpenRouter's is the bill, OpenAI's is computed from the price list), and going direct would change the OpenRouter-only rule in AGENTS.md. An option for later.

## Security findings

- **Codex 0.157**: `exec_command` ignores `shell_environment_policy`, so the key it uses for the model appears in the environment of every command it runs (excluding by name, the default `*TOKEN*` exclusion and `inherit = "core"` all had no effect). In the bench that was a one-attempt token, so the exposure was small; in the product it would leak the real key.
- **mini-swe-agent** changed test files 5 times with Luna, the most of any framework; the change rules caught every one.
- **The local Docker credential helper** (docker-credential-desktop) makes `docker pull` hang. The bench pulls images with a temporary empty `DOCKER_CONFIG`; the product's repair box would hang for the full 15 minutes on its first pull, then hand the repair to a person.

## Next

1. Change the verified ending to run **every step of the failed job**, not only the failing step. In round 3 some changes fixed the failing step and missed another step of the same job (the hidden second failure in go-vet-and-test, the Smoke step in python-circular-import).
2. Instruct the agent to find and fix every caller after changing an API, for the incomplete-fix cases such as the monorepo.
3. Rerun round 2 when the model or the framework changes: 20 cases × 3 seeds × 2 models, about $5.

## Reproducing

```bash
cd bench/repair && npm ci && node run.ts setup && node run.ts corpus-check --cases all
node run.ts run --provider openrouter --key-file <browser-model.json> --frameworks all --models openai/gpt-6-luna,openai/gpt-5-nano --cases all --seeds 3 --budget 12 --out results/<name>
node run.ts report --out results/<name>
```

OpenAI directly: `--provider openai --key-file <a JSON file with apiKey>`, with model ids without the `openai/` prefix.
