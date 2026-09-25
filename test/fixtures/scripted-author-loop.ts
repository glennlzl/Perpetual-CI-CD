// Stands in for the author loop's process in tests: runs the real loop (src/twin/author-loop.ts) exactly as its harness
// does, with a scripted model in place of OpenRouter's (./scripted-model.ts) and the twin core's fixture services. Each
// call the model receives is logged, one JSON line per step.
// Usage: node scripted-author-loop.ts <script.json> <log.jsonl> <workspace> <model id> <prompt>
import { appendFileSync, readFileSync } from 'node:fs';
import { runLoopProcess } from '../../src/twin/author-loop.ts';
import { scriptedModel, type ScriptedStep } from './scripted-model.ts';
import { services } from './twin/services.ts';

const [script, log, ...args] = process.argv.slice(2);
const steps = JSON.parse(readFileSync(script, 'utf8')) as ScriptedStep[];
const model = scriptedModel(steps, { id: args[1], onCall: ({ prompt, toolChoice, tools }) => appendFileSync(log, `${JSON.stringify({ model: args[1], prompt, toolChoice, tools: tools?.map(item => item.name) })}\n`) });
await runLoopProcess({ args, model: () => model, services });
