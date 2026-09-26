# aisdk-openai

The OpenAI track's AI SDK arm. It runs the product's own attempt loop, `runAttempt` in [`src/repair/agent.ts`](../../../../src/repair/agent.ts), called exactly as the `aisdk` baseline calls it. The loop is an AI SDK tool loop on the host, and the product's seven repair tools act only inside the bench box.

Only the model differs from the baseline: `@ai-sdk/openai`'s Responses model instead of the product's OpenRouter factory. The adapter declares `providers: { openai: 'responses' }`, so the runner pairs it only with `--provider openai`, over the gateway's Responses route.

## What goes over the wire

- **Endpoint.** `createOpenAI({ baseURL: gateway.baseUrl, apiKey: gateway.token })`, then `.responses(model.id)`. Every call is `POST {baseUrl}/responses` with `Authorization: Bearer <attempt token>`.
  - The model's fetch (`responsesOnly`) refuses every other method, path and host.
  - The key and base URL are passed explicitly, so `OPENAI_API_KEY` and `OPENAI_BASE_URL` are never read.
- **Model.** `model.id`, a bare OpenAI id such as `gpt-6-luna`.
- **Stateless.** The one setting the arm adds is `providerOptions.openai.store = false`, an AI SDK default setting (`defaultSettingsMiddleware`) on every call.
  - Each turn resends the whole conversation, and nothing is kept at OpenAI.
  - `previous_response_id` is never sent. The gateway's rule for setting `store` therefore never applies.
- **Reasoning.** For a model the provider knows reasons (o-series, and gpt-5 and later except `-chat` models, `gpt-6-luna` included), the provider adds `include: ['reasoning.encrypted_content']` whenever `store` is false. It sends each reasoning item back on the next turn with its id and encrypted content.
  - For any other model, it asks for no encrypted reasoning.
  - Reasoning effort and summaries are not set, so each model runs its default, as the product does.
- **Instructions and prompt.** INSTRUCTIONS verbatim as the system message. The provider sends it as a `developer` message for reasoning models and as `system` otherwise. The prompt is sent byte for byte as the first user message's `input_text`.
- **Tools.** The product's seven tools, with the same names, descriptions and JSON schemas.
  - `@ai-sdk/openai` 4.0.77 sends a Responses function tool that leaves strictness unset, as the product's do, with `strict: false`. So their optional parameters stay optional, as with chat completions.
  - Parallel tool calls, `max_output_tokens`, truncation and the service tier keep OpenAI's defaults, as the baseline keeps OpenRouter's.
- **Streaming.** None. `generateText` makes one JSON request per step.

## Cost, limits and endings

- **Cost.** OpenAI reports no dollar cost, so the gateway prices each request's usage from `prices/openai.json` and enforces the attempt's cap and the run's budget.
  - The loop's own cost stop reads OpenRouter's reported cost, so it never fires here.
  - The arm reports no `frameworkCost`.
- **Refusals.** A gateway refusal (HTTP 402) is not retried by the AI SDK. The loop ends with `provider`, and the runner reports the gateway's reason (`cost`, `budget`, `requests` → `steps`, `deadline` → `time`) first.
- **Other endings.** An error saying the input exceeds the context window ends with `context`, by the product's own pattern. The step limit, time limit, `done` and idle endings are the product loop's, as for the baseline.

## Running it

It needs the gateway's OpenAI provider:

```sh
cd bench/repair
npm ci
node run.ts run --provider openai --key-file /path/to/openai-key.json --frameworks aisdk-openai --models gpt-6-luna --seeds 1
```

## Packages (verified on npm on 2026-09-25)

| Package | Version | License | Where |
| --- | --- | --- | --- |
| @ai-sdk/openai | 4.0.77, published 2026-09-25 | Apache-2.0 | bench dependency |
| zod | 4.6.5, published 2026-09-13 | MIT | bench dependency; the required peer of @ai-sdk/openai |
| ai | 7.0.114 | Apache-2.0 | the product's, from the root node_modules, runs the loop. `wrapLanguageModel` and `defaultSettingsMiddleware`, imported here, resolve from the bench's copy of the same version, which the openai-agents arm pins |

**Through the bench lockfile:**
- @ai-sdk/provider 4.0.18 (Apache-2.0), the same version the product's `ai` 7.0.114 uses;
- @ai-sdk/provider-utils 5.0.49 (Apache-2.0);
- @standard-schema/spec 1.1.0 (MIT);
- @workflow/serde 4.1.0 (Apache-2.0);
- eventsource-parser 3.1.1 (MIT);
- json-schema 0.4.0 (AFL-2.1 OR BSD-3-Clause);
- undici 7.30.0 (MIT).

**Why 4.0.77.** 4.0.75 is the release published with the product's `ai` 7.0.114, and it shares its provider-utils 5.0.47. But 4.0.75 sends function tools without `strict`, which leaves strictness to the Responses API's default. 4.0.77 defaults them to `strict: false`. Its only other changes are provider-utils patches this arm does not use: ES2022 output, file URL handling and an opt-in fetch helper. Both releases implement the V4 model specification the product's `ai` 7 calls.

## Tests

- **`test/aisdk-openai.test.ts`**: pure, with no Docker, network or model. The product's loop runs in the product's host-folder box double against `fake-responses.ts`, a stand-in for the gateway's Responses route. The test checks:
  - the registration (providers, host) and the pinned provider;
  - that the fetch reaches only `POST <gateway>/responses`;
  - a repair that reproduces, edits, verifies and ends at `done`, with the token as the only credential;
  - the model id, `store: false`, the encrypted reasoning include, and no `previous_response_id`;
  - the developer message and the prompt, byte for byte;
  - the seven tools, sent with `strict: false` and their optional parameters;
  - the second turn resending the first turn's reasoning item with its encrypted content, its call and the call's output;
  - that a model the provider does not know reasons gets no include;
  - that a 402 ends at `provider` without a retry.
- **`test/aisdk-openai.docker.test.ts`**: runs only with `BENCH_DOCKER=1`. On `logic-tier-boundary`, the dry-run `solver` answers through the stand-in: each Responses request is shown to it as the chat body it reads. It drives the loop's tools in a real bench box, and the judge passes the diff.

## Deviations and what to verify on the first paid run

- **The gateway hop.** The unit and smoke tests reach the stand-in directly; they were written before the gateway's OpenAI track was merged. The gateway now serves `POST /api/v1/responses` and `fake-openai.ts` speaks the Responses API, so the next step is to put the gateway in between as `aisdk.docker.test.ts` does. The dry run (`--dry-run --provider openai --frameworks aisdk-openai`) goes through both and has not been run.
- **Runner pairing.** The runner refuses this arm on the OpenRouter track, and `--frameworks all` there skips it, since it declares only `openai`.
- **Verify with the first real requests:**
  - OpenAI accepts reasoning input items that carry both their `rs_` id and their encrypted content under `store: false`;
  - the gateway's 402 reaches the loop as a provider error;
  - long reasoning turns answer within the gateway's upstream timeout. The call is non-streaming, so OpenAI sends nothing until the response is complete.
