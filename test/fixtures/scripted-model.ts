// A scripted language model for the twin author loop's and the repair agent's tests (the AI SDK's MockLanguageModelV4):
// no network, no model. The loop's nth step is the script's nth entry, or the function's answer for it, and a step past
// its end answers with text alone, which ends the loop.
import { fileURLToPath } from 'node:url';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { loopHarness } from '../../src/twin/authoring.ts';
import type { Harness } from '../../src/agents/opencode.ts';

/** What the model receives for a step: its prompt, tools, tool choice and provider options. */
export type ModelCall = Parameters<MockLanguageModelV4['doGenerate']>[0];

/** OpenRouter's reasoning details, as its provider attaches them to a step's reasoning and first tool call. */
export type ReasoningDetail = { type: string; text?: string; signature?: string; data?: string; format?: string };
/**
 * One step of the model: its tool calls with their input, reasoning with its details, text, the cost OpenRouter reports,
 * or an error of OpenRouter's HTTP API. `hang` waits until the loop is stopped.
 */
export type ScriptedStep = {
  calls?: { tool: string; input: unknown }[]; reasoning?: { text: string; details: ReasoningDetail[] }; text?: string; cost?: number;
  error?: { status: number; message: string; data?: unknown }; hang?: boolean;
};

export function scriptedModel(script: ScriptedStep[] | ((index: number, call: ModelCall) => ScriptedStep), { id = 'scripted/model', onCall = () => {} }: { id?: string; onCall?: (call: ModelCall) => void } = {}) {
  let step = 0;
  return new MockLanguageModelV4({
    provider: 'openrouter.chat', modelId: id,
    async doGenerate(options) {
      onCall(options);
      const { calls = [], reasoning, text, cost, error, hang } = (typeof script === 'function' ? script(step, options) : script[step]) ?? { text: 'Finished.' };
      step += 1;
      // A request in flight keeps its process alive, as an open connection would.
      if (hang) {
        const pending = setInterval(() => {}, 1000);
        await new Promise((_resolve, reject) => {
          if (options.abortSignal?.aborted) reject(options.abortSignal.reason);
          options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason), { once: true });
        }).finally(() => clearInterval(pending));
      }
      if (error) throw new APICallError({ message: error.message, url: 'https://openrouter.ai/api/v1/chat/completions', requestBodyValues: {}, statusCode: error.status, data: error.data, isRetryable: false });
      const metadata = reasoning ? { openrouter: { reasoning_details: reasoning.details } } : undefined;
      return {
        content: [
          ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning.text, providerMetadata: metadata }] : []),
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...calls.map((call, index) => ({ type: 'tool-call' as const, toolCallId: `call-${step}-${index + 1}`, toolName: call.tool, input: JSON.stringify(call.input),
            ...(index === 0 && metadata ? { providerMetadata: metadata } : {}) })),
        ],
        finishReason: { unified: calls.length ? 'tool-calls' as const : 'stop' as const, raw: undefined },
        usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 20, text: 20, reasoning: undefined } },
        ...(cost === undefined ? {} : { providerMetadata: { openrouter: { usage: { cost } } } }),
        warnings: [],
      };
    },
  });
}

const LOOP_FIXTURE = fileURLToPath(new URL('./scripted-author-loop.ts', import.meta.url));
/**
 * The loop's own harness with the scripted model in place of OpenRouter's: the loop's command, with the fixture that
 * runs the loop process in place of its module, reading `script` and logging each call the model receives to `log`.
 */
export const scriptedLoopHarness = (script: string, log: string): Harness => input => {
  const { args: [, ...args], ...command } = loopHarness(input);
  return { ...command, args: [LOOP_FIXTURE, script, log, ...args] };
};
