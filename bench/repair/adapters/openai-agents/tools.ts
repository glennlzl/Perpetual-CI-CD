// The product's seven repair tools (src/repair/tools.ts) as OpenAI Agents SDK function tools. Each keeps the name,
// description and JSON schema the product sends, not strict (the SDK's strict mode would rewrite optional properties
// as required and nullable), so the model is offered exactly the baseline's tools. Each runs the product's own tool in
// the box and answers with its result as JSON, the text the AI SDK sends for it. The product's done has no execute,
// because its loop stops at a done call; here done answers {"ok":true}, and the agent stops at it (stopAtToolNames).
import { tool, type ToolInputParameters } from '@openai/agents';

/** The SDK types a non-strict schema with additionalProperties: true, but with strict: false it sends any JSON schema as it is. */
type Schema = Extract<ToolInputParameters, { additionalProperties: true }>;
type Execute = (input: unknown, options: { toolCallId: string; messages: never[]; abortSignal?: AbortSignal }) => unknown;
export const DONE = 'done';
export const FINISHED = JSON.stringify({ ok: true });

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Function tools for AI SDK tools, each read as unknown: its description, its schema's JSON schema and its execute. */
export async function agentTools(tools: Record<string, unknown>) {
  return Promise.all(Object.entries(tools).map(async ([name, value]) => {
    const source = isRecord(value) ? value : {}, schema: unknown = isRecord(source.inputSchema) ? await source.inputSchema.jsonSchema : undefined;
    if (typeof source.description !== 'string' || !isRecord(schema) || schema.type !== 'object') throw new Error(`The ${name} tool has no description or object schema.`);
    const execute = typeof source.execute === 'function' ? source.execute as Execute : null;
    if (!execute && name !== DONE) throw new Error(`The ${name} tool has no execute.`);
    return tool({
      name, description: source.description, parameters: schema as Schema, strict: false,
      async execute(input, _context, details) {
        if (!execute) return FINISHED;
        const output = await execute(input, { toolCallId: details?.toolCall?.callId ?? name, messages: [], ...(details?.signal ? { abortSignal: details.signal } : {}) });
        return JSON.stringify(output ?? null);
      },
    });
  }));
}
