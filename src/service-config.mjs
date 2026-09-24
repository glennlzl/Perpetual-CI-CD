import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { redact } from './providers.mjs';

const MAX_BYTES = 512 * 1024;
const SECRET_PATH = /(^|\/)(?:\.env[^/]*|\.git|\.ssh|\.aws|\.npmrc|\.netrc|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i;
const scalar = value => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
const text = value => redact(String(value)
  .replace(/(\b[\w-]*(?:token|secret|password|api[-_]?key|access[-_]?key|authorization)[\w-]*\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
  .replace(/(--?[\w-]*(?:token|secret|password|api[-_]?key|access[-_]?key|authorization)[\w-]*(?:\s*=\s*|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]')
  .replace(/\b(?:sbp_[\w-]+|sk_(?:live|test)_[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[REDACTED]'))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 2048);

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !path.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !/[\\\0]/.test(value) &&
    !value.split('/').some(part => !part || part === '.' || part === '..') && !SECRET_PATH.test(value);
}

async function readConfig(root, relative) {
  if (!safePath(relative)) return null;
  let location = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    location = path.join(location, part);
    let stat;
    try { stat = await lstat(location); } catch { return null; }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) ||
      (index === parts.length - 1 && (!stat.isFile() || stat.size > MAX_BYTES))) return null;
  }
  let handle;
  try {
    handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    return size > MAX_BYTES ? null : buffer.subarray(0, size).toString('utf8');
  } catch { return null; }
  finally { await handle?.close(); }
}

function field(key, label, value) {
  if (Array.isArray(value)) {
    const values = value.filter(scalar).slice(0, 100).map(text);
    return values.length ? { key, label, type: 'list', value: values, readOnly: true } : null;
  }
  if (!scalar(value) || value === '') return null;
  return { key, label, type: typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'text', value: typeof value === 'string' ? text(value) : value, readOnly: true };
}

function addSection(sections, id, title, fields) {
  const actual = fields.filter(Boolean);
  if (actual.length) sections.push({ id, title: text(title), fields: actual });
}

function workflowSections(sections, file, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const triggers = typeof data.on === 'string' ? [data.on] : Array.isArray(data.on) ? data.on : Object.keys(data.on || {});
  addSection(sections, 'workflow', 'Workflow', [
    field('file', 'Workflow file', file), field('name', 'Name', data.name), field('triggers', 'Triggers', triggers),
  ]);
  const filters = [];
  if (data.on && !Array.isArray(data.on) && typeof data.on === 'object') {
    for (const [event, config] of Object.entries(data.on).slice(0, 40)) {
      if (!config || typeof config !== 'object') continue;
      for (const key of ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore']) {
        filters.push(field(`${event}.${key}`, `${event} · ${key}`, config[key]));
      }
    }
  }
  addSection(sections, 'triggers', 'Trigger filters', filters);
  addSection(sections, 'concurrency', 'Concurrency', [
    field('group', 'Group', typeof data.concurrency === 'string' ? data.concurrency : data.concurrency?.group),
    field('cancel-in-progress', 'Cancel in progress', data.concurrency?.['cancel-in-progress']),
  ]);
  for (const [id, job] of Object.entries(data.jobs || {}).slice(0, 100)) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) continue;
    const runner = job['runs-on'];
    const runnerFields = runner && typeof runner === 'object' && !Array.isArray(runner)
      ? [field('runner-group', 'Runner group', runner.group), field('runner-labels', 'Runner labels', runner.labels)]
      : [field('runs-on', 'Runner', runner)];
    addSection(sections, `job:${text(id)}`, scalar(job.name) ? job.name : id, [
      field('id', 'Job', id), ...runnerFields,
      field('needs', 'Needs', Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []),
      field('timeout-minutes', 'Timeout (minutes)', job['timeout-minutes']),
      field('working-directory', 'Working directory', job.defaults?.run?.['working-directory'] ?? data.defaults?.run?.['working-directory']),
    ]);
  }
}

// Intentionally accepts only literal scalar values in exact [build] / [deploy] tables.
// Multiline strings, inline tables and environment overrides are not approximated.
function literalToml(raw) {
  const result = { build: {}, deploy: {} };
  const seen = new Set();
  let section = '';
  let multiline = null;
  for (const line of raw.split(/\r?\n/)) {
    if (multiline) {
      if (line.includes(multiline)) multiline = null;
      continue;
    }
    const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table) { section = ['build', 'deploy'].includes(table[1].trim()) ? table[1].trim() : ''; continue; }
    if (/^\s*\[/.test(line)) { section = ''; continue; }
    const entry = line.match(/^\s*([A-Za-z][\w-]*)\s*=\s*(.*?)\s*$/);
    if (!entry) continue;
    const [, key, literal] = entry;
    if (literal.startsWith('"""') || literal.startsWith("'''")) {
      const delimiter = literal.slice(0, 3);
      if (!literal.slice(3).includes(delimiter)) multiline = delimiter;
      continue;
    }
    if (!section) continue;
    const qualified = `${section}.${key}`;
    if (seen.has(qualified)) { delete result[section][key]; continue; }
    seen.add(qualified);
    let value;
    const quoted = literal.match(/^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if (quoted) {
      if (quoted[1].startsWith("'")) value = quoted[1].slice(1, -1);
      else { try { value = JSON.parse(quoted[1]); } catch { continue; } }
    } else if (/^(true|false)\s*(?:#.*)?$/.test(literal)) value = literal.startsWith('true');
    else {
      const number = literal.match(/^([+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(?:#.*)?$/);
      if (number && Number.isFinite(Number(number[1]))) value = Number(number[1]);
    }
    if (scalar(value)) result[section][key] = value;
  }
  return result;
}

function railwaySections(sections, data) {
  for (const [section, title, entries] of [
    ['build', 'Build', [['builder', 'Builder'], ['dockerfilePath', 'Dockerfile'], ['buildCommand', 'Build command']]],
    ['deploy', 'Deploy', [['startCommand', 'Start command'], ['healthcheckPath', 'Healthcheck path'], ['healthcheckTimeout', 'Healthcheck timeout (seconds)'], ['restartPolicyType', 'Restart policy'], ['restartPolicyMaxRetries', 'Maximum retries']]],
  ]) addSection(sections, section, title, entries.map(([key, label]) => {
    const value = data?.[section]?.[key];
    return scalar(value) ? field(key, label, value) : null;
  }));
}

function vercelProject(raw, name, expectedAlias) {
  for (const match of raw.matchAll(/\{[^{}]{0,1500}\}/g)) {
    const projectName = match[0].match(/\bname\s*:\s*["']([\w.-]+)["']/)?.[1];
    const alias = match[0].match(/\bpreviewAlias\s*:\s*["']([\w.-]+\.vercel\.app)["']/)?.[1];
    if (projectName === name && alias && (!expectedAlias || alias === expectedAlias)) return { name: projectName, alias };
  }
  return null;
}

export async function readServiceConfig(scan, nodeId) {
  const node = scan?.nodes?.find(item => item.id === nodeId);
  if (!node) throw new Error('This service is no longer in the pipeline.');
  const root = scan?.repo?.path;
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Repository configuration is unavailable.');
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Repository configuration is unavailable.');
  const paths = [...new Set((node.evidence || []).map(item => item.file).filter(safePath))].slice(0, 40);
  const result = { nodeId, provider: node.provider || null, files: paths.map(file => ({ path: file })), sections: [] };

  if (node.kind === 'workflow' || node.kind === 'job') {
    const file = paths.find(file => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
    const raw = file ? await readConfig(root, file) : null;
    if (raw !== null) {
      let data;
      try { data = parse(raw, { maxAliasCount: 20 }); }
      catch { throw new Error('Could not read this workflow configuration.'); }
      workflowSections(result.sections, file, data);
    }
  } else if (node.provider === 'Railway') {
    const file = paths.find(file => /(?:^|\/)railway\.(toml|json)$/.test(file));
    const raw = file ? await readConfig(root, file) : null;
    if (raw !== null) {
      let data;
      try { data = file.endsWith('.json') ? JSON.parse(raw) : literalToml(raw); }
      catch { throw new Error('Could not read this Railway configuration.'); }
      railwaySections(result.sections, data);
    }
  } else if (node.provider === 'Vercel') {
    let name = typeof node.projectName === 'string' ? node.projectName : '';
    if (!Object.hasOwn(node, 'projectName')) {
      try { if (nodeId.startsWith('vercel:')) name = decodeURIComponent(nodeId.slice(7)); } catch { /* Legacy node has no project association. */ }
    }
    for (const file of paths) {
      if (!/^scripts\/vercel[\w/-]*alias[\w-]*\.m?js$/.test(file) && !/(?:^|\/)vercel\.json$/.test(file)) continue;
      const raw = await readConfig(root, file);
      if (raw === null) continue;
      if (file.endsWith('.json')) {
        let data;
        try { data = JSON.parse(raw); } catch { throw new Error('Could not read this Vercel configuration.'); }
        // A scanned config path is authoritative; legacy names need an explicit match.
        if (node.configFile !== file && name && name !== 'Vercel' && data?.name !== name) continue;
        addSection(result.sections, `vercel:${file}`, 'Build', [
          field('framework', 'Framework', data?.framework), field('buildCommand', 'Build command', data?.buildCommand),
          field('installCommand', 'Install command', data?.installCommand), field('outputDirectory', 'Output directory', data?.outputDirectory),
          field('devCommand', 'Development command', data?.devCommand),
        ]);
      } else {
        const project = vercelProject(raw, name, node.previewAlias);
        if (project) addSection(result.sections, `project:${file}`, 'Project', [field('name', 'Project', project.name), field('previewAlias', 'Preview alias', project.alias)]);
      }
    }
  }

  if (!result.sections.length) {
    const service = scan.services?.find(item => item.id === nodeId);
    if (service) {
      addSection(result.sections, 'service', 'Service', [field('path', 'Root directory', service.path), field('framework', 'Framework', service.framework)]);
      addSection(result.sections, 'commands', 'Commands', Object.entries(service.commands || {}).map(([key, value]) => field(key, key, value)));
    }
  }
  return result;
}

function actionName(value, fallback = 'Action') {
  if (typeof value !== 'string') return fallback;
  // Action references are identifiers, never shell commands or arbitrary URLs.
  const isAction = /^[\w.-]+\/[\w./-]+@[\w./-]+$/.test(value);
  const isLocal = /^\.\/[\w./-]+$/.test(value) && !value.split('/').includes('..');
  const isImage = /^docker:\/\/[\w./:-]+(?:@sha256:[a-fA-F0-9]+)?$/.test(value);
  return isAction || isLocal || isImage ? text(value) : fallback;
}

export async function readGitHubActions(scan) {
  const root = scan?.repo?.path;
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Repository configuration is unavailable.');
  let rootStat;
  try { rootStat = await lstat(root); } catch { throw new Error('Repository configuration is unavailable.'); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Repository configuration is unavailable.');
  const workflows = [];
  const seen = new Set();
  for (const known of Array.isArray(scan.workflows) ? scan.workflows : []) {
    if (!known || typeof known.file !== 'string' || seen.has(known.file)) continue;
    seen.add(known.file);
    const workflow = {
      file: known.file,
      name: text(typeof known.name === 'string' && known.name.trim() ? known.name : path.posix.basename(known.file)),
      jobs: [],
    };
    workflows.push(workflow);
    if (!safePath(known.file) || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(known.file)) {
      workflow.error = 'Workflow file is unavailable.';
      continue;
    }
    const raw = await readConfig(root, known.file);
    if (raw === null) {
      workflow.error = 'Could not read this workflow file.';
      continue;
    }
    let data;
    try { data = parse(raw, { maxAliasCount: 20 }); }
    catch {
      workflow.error = 'Could not parse this workflow file.';
      continue;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.jobs || typeof data.jobs !== 'object' || Array.isArray(data.jobs)) {
      workflow.error = 'Workflow jobs are unavailable.';
      continue;
    }
    if (typeof data.name === 'string' && data.name.trim()) workflow.name = text(data.name);
    for (const [id, config] of Object.entries(data.jobs)) {
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        workflow.error = 'Some jobs could not be read.';
        continue;
      }
      const job = { id: text(id), name: text(typeof config.name === 'string' && config.name.trim() ? config.name : id), steps: [] };
      workflow.jobs.push(job);
      if (Array.isArray(config.steps)) {
        for (const [index, step] of config.steps.entries()) {
          if (!step || typeof step !== 'object' || Array.isArray(step)) {
            workflow.error = 'Some steps could not be read.';
            continue;
          }
          const name = typeof step.name === 'string' && step.name.trim()
            ? text(step.name)
            : typeof step.uses === 'string' ? actionName(step.uses)
              : typeof step.run === 'string' ? 'Run command' : 'Step';
          job.steps.push({ id: typeof step.id === 'string' && step.id.trim() ? text(step.id) : `step-${index + 1}`, name });
        }
      } else if (typeof config.uses === 'string') {
        job.steps.push({ id: 'reusable-workflow', name: actionName(config.uses, 'Reusable workflow') });
      } else if (config.steps !== undefined) {
        workflow.error = 'Some steps could not be read.';
      }
    }
  }
  return { workflows };
}
