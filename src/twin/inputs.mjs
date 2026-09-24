import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, plain } from './config.mjs';
import { services as registry } from './registry.mjs';

// User-supplied test credentials, stored once per machine and reused across twins.
// Views say only which inputs are set; values go to the twin runtime and nowhere else.

const FILE = 'twin-inputs.json';

const valid = (input, value) => typeof value === 'string' && value.length > 0 && (!input.pattern || new RegExp(input.pattern).test(value));

/** Names of the required inputs a service declares that have no valid value. */
export const missingInputs = (service, values = {}) => (service.inputs ?? []).filter(input => !input.optional && !valid(input, values[input.name])).map(input => input.name);

export function createTwinInputs({ dataDir, services = registry }) {
  const file = join(dataDir, FILE);
  const read = async () => {
    try { const stored = JSON.parse(await readFile(file, 'utf8')); return plain(stored) ? stored : {}; }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  };
  const service = id => Object.hasOwn(services, id) ? services[id] : fail(`Unknown service "${id}".`);

  async function view() {
    const stored = await read();
    return Object.values(services).filter(item => item.inputs?.length).map(item => ({ id: item.id, title: item.title,
      inputs: item.inputs.map(input => ({ name: input.name, label: input.label, secret: Boolean(input.secret), ...(input.help ? { help: input.help } : {}),
        set: valid(input, stored[item.id]?.[input.name]) })) }));
  }

  /** Valid values by service id, for the twin runtime only. */
  async function values() {
    const stored = await read();
    return Object.fromEntries(Object.values(services).filter(item => item.inputs?.length).map(item => [item.id,
      Object.fromEntries(item.inputs.filter(input => valid(input, stored[item.id]?.[input.name])).map(input => [input.name, stored[item.id][input.name]]))]));
  }

  /** Sets or, with null or '', clears inputs of one service. */
  async function set(id, entries) {
    const { inputs = [] } = service(id);
    if (!plain(entries)) fail('Inputs must map input names to values.');
    const stored = await read(), next = { ...stored[id] };
    for (const [name, value] of Object.entries(entries)) {
      const input = inputs.find(item => item.name === name) ?? fail(`${id} has no input named ${name}.`);
      if (value == null || value === '') { delete next[name]; continue; }
      if (!valid(input, value)) fail(`${input.label ?? name} does not have the expected format.`);
      next[name] = value;
    }
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify({ ...stored, [id]: next }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    return view();
  }

  return { view, values, set };
}
