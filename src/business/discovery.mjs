import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../providers.mjs';

const MAX_FILES = 200;
const MAX_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_MODEL_BYTES = 180 * 1024;
const SECRET_PATH = /(?:^|\/)(?:\.env[^/]*|\.git|\.ssh|\.aws|\.npmrc|\.netrc|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|keys?(?:\.[^/]*)?)(?:\/|$)|\.(?:pem|key|p12|pfx|jks)$/i;
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', 'out', 'target', '__pycache__', '__tests__', 'test', 'tests', 'fixtures', '.next', '.nuxt', '.cache', '.perpetual']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.rb', '.java', '.cs', '.php', '.html', '.htm', '.md', '.mdx']);
// Generic journey vocabulary shared by most products; nothing product-specific.
const BILLING_PATH = /billing|payment|stripe|checkout|subscription|credit|wallet|refund/i;
const ACTION_PATH = /(?:^|\/)(?:new|create|edit|run|submit|result)(?:\/|\.|-|$)/i;
const STRUCTURAL = new Set(['src', 'app', 'apps', 'lib', 'libs', 'utils', 'util', 'hooks', 'types', 'components', 'component', 'ui', 'pages', 'page', 'routes', 'route', 'api', 'layout', 'index', 'main', 'frontend', 'backend', 'client', 'server', 'web', 'shared', 'common', 'core', 'services', 'service', 'store', 'stores', 'styles', 'public', 'assets', 'config', 'providers', 'provider', 'context', 'models', 'model', 'schema', 'schemas', 'helpers', 'middleware', 'dashboard', 'functions', 'supabase', 'packages', 'modules', 'features', 'views', 'screens', 'docs', 'readme']);

/** The repository's own domain nouns: route and module names spread across
 * several directories (list, detail, create, API). Bulk files in one folder do
 * not count. Derived per repository, never hard-coded. */
export function domainTerms(names, limit = 5) {
  const spread = new Map();
  const ignored = term => !/^[a-z][a-z0-9]{2,30}$/.test(term) || STRUCTURAL.has(term) || BILLING_PATH.test(term) || ACTION_PATH.test(`/${term}/`) || /^(?:login|signin|signup|auth|settings|preferences|profile|test|spec|mock)s?$/.test(term);
  const singular = term => term.endsWith('ies') ? `${term.slice(0, -3)}y` : term.endsWith('ss') ? term : term.replace(/s$/, '');
  const ancestors = new Map(), leaves = new Map();
  for (const name of names) {
    const lower = name.toLowerCase(), directory = lower.includes('/') ? lower.slice(0, lower.lastIndexOf('/')) : '';
    // Route parameters ([id]) and groups ((app)) are not nouns. Only the last two
    // meaningful segments count; a term mostly seen above them is a package root.
    const segments = lower.replace(/\.[a-z0-9]+$/, '').split('/').filter(part => part && !/^[[(@]/.test(part)).map(part => part.split(/[-_.]/).filter(term => !ignored(term)).map(singular)).filter(part => part.length);
    for (const term of new Set(segments.slice(0, -2).flat())) ancestors.set(term, (ancestors.get(term) || 0) + 1);
    for (const term of new Set(segments.slice(-2).flat())) {
      leaves.set(term, (leaves.get(term) || 0) + 1);
      if (!spread.has(term)) spread.set(term, new Set());
      spread.get(term).add(directory);
    }
  }
  return [...spread].filter(([term]) => (ancestors.get(term) || 0) <= 2 * leaves.get(term)).map(([term, directories]) => [term, directories.size]).filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([term]) => term);
}
const termPattern = terms => terms.length ? new RegExp(`(?:${terms.map(term => term.replace(/[^a-z0-9]/g, '')).join('|')})`, 'i') : null;

function safeSource(text) {
  const withoutKeys = text.replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----/g,
    block => block.split('\n').map(() => '[REDACTED]').join('\n'));
  return withoutKeys.split('\n').map(line => redact(line)
    .replace(/\b(?:sbp_[\w-]+|sk_(?:live|test)_[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:token|secret|password|api[_-]?key|access_token|authorization)=)[^&\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*)(["'])(.*?)\2/gi, '$1$2[REDACTED]$2')).join('\n');
}

/** Browser discovery selects metadata before reading: a large first subtree must
 * not spend the entire content budget before UI/product evidence is considered. */
async function balancedBrowserSources(repoPath, scope) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) throw new Error('Choose an explicit absolute repository path.');
  const rootStat = await lstat(repoPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Repository source must be a regular directory.');
  const root = await realpath(repoPath), candidates = [], files = [], warnings = [];
  const historicalDirectories = new Set(['archive', 'archives', 'archived', 'graveyard', 'deprecated', 'superpowers', 'agents', 'scripts', 'eval', 'evals']);
  const tokens = [...new Set(String(scope || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])].filter(token => !['the', 'and', 'for', 'with', 'test', 'tests', 'case', 'cases', 'user', 'users', 'work', 'from', 'this', 'that', 'should', 'through', 'using', 'into', 'when', 'then'].includes(token)).slice(0, 30);
  const score = name => {
    const normalized = name.toLowerCase();
    return Math.min(60, tokens.reduce((value, token) => value + (normalized.includes(token) ? 20 : 0), 0))
      + (BILLING_PATH.test(normalized) ? 60 : 0)
      + (/(?:settings|preferences|profile)/.test(normalized) ? 35 : 0)
      + (ACTION_PATH.test(normalized) ? 25 : 0)
      + (/(?:^|\/)(?:page|index|route|app|main)\.[^/]+$/.test(normalized) ? 15 : 0)
      + (/(?:^|\/)(?:login|sign-?in|auth)(?:\/|\.)/.test(normalized) ? 10 : 0)
      + (/(?:^|\/)(?:readme|prd|product|requirements)\.mdx?$/.test(normalized) ? 80 : 0)
      + (/(?:^|\/)docs\/(?:user|product)\//.test(normalized) ? 100 : 0)
      - (/(?:^|\/)(?:plans|changelog|history)(?:\/|\.)/.test(normalized) ? 30 : 0);
  };
  const category = name => {
    if (/\.mdx?$/i.test(name)) return 'product';
    if (/(?:^|\/)(?:api|backend|server|routes)(?:\/|$)/i.test(name)) return 'api';
    if (/\.(?:jsx|tsx|html|htm)$/i.test(name) || /(?:^|\/)(?:frontend|client|web|pages|components)(?:\/|$)/i.test(name)) return 'ui';
    return 'other';
  };
  let visited = 0, total = 0, limited = false;
  const queue = [{ relative: '', depth: 0 }];
  while (queue.length && visited < 5000) {
    const { relative, depth } = queue.shift();
    if (depth > 8) { limited = true; continue; }
    let entries;
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => score(`${relative}/${b.name}`) - score(`${relative}/${a.name}`) || a.name.localeCompare(b.name));
    // A single generated/very wide directory cannot consume all traversal slots.
    if (entries.length > 512) limited = true;
    for (const entry of entries.slice(0, 512)) {
      if (++visited > 5000) { limited = true; break; }
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || SECRET_PATH.test(name) || entry.name.startsWith('.') || /^(?:AGENTS|CLAUDE|GEMINI|SKILL)\.md$/i.test(entry.name)) continue;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && !historicalDirectories.has(entry.name.toLowerCase())) queue.push({ relative: name, depth: depth + 1 }); continue; }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !/(?:\.min\.|\.d\.ts$|\.test\.|\.spec\.)/.test(entry.name)) candidates.push(name);
    }
  }
  if (queue.length) limited = true;
  // The primary area is derived from this repository's own route vocabulary,
  // never from product-specific names.
  const primary = termPattern([...new Set([...tokens.slice(0, 5), ...domainTerms(candidates.filter(name => category(name) !== 'product'))])]);
  const businessArea = name => BILLING_PATH.test(name) ? 'billing'
    : /(?:login|sign-?in|sign-?up|auth)(?:[/.\-]|$)/i.test(name) ? 'account'
      : /settings|preferences|profile/i.test(name) ? 'settings'
        : ACTION_PATH.test(name) || primary?.test(name) ? 'primary' : 'other';
  const balanced = names => {
    const areas = ['primary', 'billing', 'account', 'settings', 'other'].map(area => names.filter(name => businessArea(name) === area).sort((a, b) => score(b) - score(a) || a.localeCompare(b)));
    const result = [];
    while (areas.some(area => area.length)) for (const area of areas) if (area.length) result.push(area.shift());
    return result;
  };
  const groups = ['ui', 'api', 'product', 'other'].map(kind => balanced(candidates.filter(name => category(name) === kind)));
  const ordered = [];
  while (groups.some(group => group.length)) for (const group of groups) if (group.length) ordered.push(group.shift());
  for (const name of ordered) {
    if (files.length >= MAX_FILES || total >= MAX_BYTES) { limited = true; break; }
    let handle;
    try {
      const resolved = await realpath(path.join(root, name));
      if (!resolved.startsWith(`${root}${path.sep}`) || resolved !== path.join(root, name)) continue;
      handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size > MAX_BYTES - total) { limited = true; continue; }
      const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES, MAX_BYTES - total) + 1);
      let size = 0;
      while (size < buffer.length) {
        const chunk = await handle.read(buffer, size, buffer.length - size, size);
        if (!chunk.bytesRead) break;
        size += chunk.bytesRead;
      }
      if (size >= buffer.length) { limited = true; continue; }
      total += size;
      const raw = buffer.subarray(0, size).toString('utf8');
      if (raw.includes('\0')) continue;
      const text = safeSource(raw);
      files.push({ path: name, text, lines: text.split('\n') });
    } catch { /* Unreadable and changing source files are omitted. */ }
    finally { await handle?.close(); }
  }
  if (limited) warnings.push('Browser source discovery used a balanced sample bounded to 200 files, 1 MiB, eight directory levels and 5,000 entries; some files were omitted.');
  if (!files.length) warnings.push('No supported source files were available for discovery.');
  return { files, warnings };
}

/** Share the prompt budget across business areas before adding detail. Prefer
 * useful interior implementation lines over spending the whole budget on imports
 * or the first few large files. Citations always retain original line numbers. */
function browserModelSources(files) {
  let auxiliary = 0;
  const selected = files.filter(file => !/\.mdx?$/i.test(file.path) &&
    (/(?:^|\/)(?:api|backend|server|routes|frontend|client|web|pages|components)(?:\/|$)/i.test(file.path) || ++auxiliary <= 6)).slice(0, 56);
  selected.push(...files.filter(file => /\.mdx?$/i.test(file.path)).slice(0, 4));
  if (!selected.length) return [];
  let remaining = MAX_MODEL_BYTES;
  const terms = domainTerms(selected.map(file => file.path)), primary = termPattern(terms);
  const weight = file => BILLING_PATH.test(file.path) ? 6
    : ACTION_PATH.test(file.path) || primary?.test(file.path) || /(?:^|\/)(?:settings|login|sign-?in)(?:\/|\.)/i.test(file.path) ? 4 : 1;
  let remainingWeight = selected.reduce((sum, file) => sum + weight(file), 0);
  const result = [];
  const signals = new RegExp(`\\b(?:credits?|wallet|balance|billing|payment|checkout|subscription|refund|upgrade|downgrade|settings|preferences|sign-?in|sign-?up|login|create|save|submit|run|execute|publish|update|delete${terms.map(term => `|${term}`).join('')})`, 'i');
  for (const file of selected) {
    const budget = Math.min(24000, Math.floor(remaining * weight(file) / remainingWeight));
    remainingWeight -= weight(file);
    const picked = new Map();
    let spent = 0;
    const add = index => {
      if (index < 0 || index >= file.lines.length || picked.has(index)) return;
      const numbered = `${index + 1}: ${file.lines[index]}`;
      const size = Buffer.byteLength(numbered) + 1;
      if (spent + size > budget) return;
      picked.set(index, numbered); spent += size;
    };
    // Keep a small entry section for module/product identity, then spread useful
    // windows through the file so an early helper cannot hide checkout or debit.
    for (let index = 0; index < Math.min(8, file.lines.length); index++) add(index);
    const hits = file.lines.flatMap((line, index) => signals.test(line) && !/^\s*(?:import\b|\/\/|\*)/.test(line) ? [index] : []);
    const windows = [];
    for (const hit of hits) if (!windows.some(previous => Math.abs(previous - hit) < 12)) windows.push(hit);
    const distributed = windows.length <= 12 ? windows : Array.from({ length: 12 }, (_, index) => windows[Math.floor(index * (windows.length - 1) / 11)]);
    for (let radius = 0; radius <= 20; radius++) for (const center of distributed) {
      add(center + radius);
      if (radius) add(center - radius);
    }
    for (let index = 0; index < file.lines.length && spent < budget; index++) add(index);
    if (picked.size) result.push({ path: file.path, source: [...picked.entries()].sort(([a], [b]) => a - b).map(([, line]) => line).join('\n') });
    remaining -= spent;
  }
  return result;
}

/** Bounded, balanced and redacted browser evidence with original source lines. */
export async function businessSourceContext(repoPath, { scope = '' } = {}) {
  const { files, warnings } = await balancedBrowserSources(repoPath, scope);
  return { files: browserModelSources(files), warnings };
}

export const redactBusinessText = text => safeSource(text);
