import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// A journey spec is stage data: the actions of one reviewed case, approved by a person. It runs in the same process
// as the fixture that judges it, so it is an allowlisted grammar, not JavaScript with exceptions: one test of awaited
// milestones, each a list of awaited Playwright actions on page, its locators, keyboard and mouse, whose arguments
// are literals, options objects or locators. No other identifier, assignment, computed access or function exists,
// so checks, page scripts, routing, globals and the runtime stay out of reach. Playwright's bundled Babel parses it,
// the same parser that compiles it for the run.
const MAX_BYTES = 200 * 1024;
let parser = null;
const parse = code => (parser ??= createRequire(createRequire(import.meta.url).resolve('@playwright/test'))('playwright/lib/transform/babelBundle').babelParse)(code, 'journey.spec.mjs', true).program;

const LOCATE = ['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId'];
const of = (names, value) => Object.fromEntries(names.map(name => [name, value]));
// What each Playwright object may call: a string names the object the call returns; true ends an action.
const API = {
  page: { ...of(LOCATE, 'locator'), frameLocator: 'frame', ...of(['goto', 'reload', 'goBack', 'goForward', 'waitForURL', 'waitForLoadState', 'waitForTimeout'], true) },
  locator: { ...of([...LOCATE, 'first', 'last', 'nth', 'filter', 'and', 'or'], 'locator'), contentFrame: 'frame', ...of(['click', 'dblclick', 'tap', 'check', 'uncheck', 'setChecked', 'fill', 'clear', 'press', 'pressSequentially', 'type', 'selectOption', 'hover', 'focus', 'blur', 'dragTo', 'scrollIntoViewIfNeeded', 'waitFor'], true) },
  frame: { ...of(LOCATE, 'locator'), frameLocator: 'frame', owner: 'locator' },
  keyboard: of(['press', 'type', 'insertText', 'down', 'up'], true),
  mouse: of(['click', 'dblclick', 'move', 'down', 'up', 'wheel'], true),
};
const PROPERTIES = { page: { keyboard: 'keyboard', mouse: 'mouse' } };
const LITERALS = new Set(['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'RegExpLiteral']);
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const IMPORT = "Import only the fixture: import { test } from 'perpetual'.";
const TEST = 'A spec contains exactly one test: test(title, async ({ page, journey }) => { … }).';
const MILESTONES = "the test body only awaits journey.milestone('<step id>', async () => { … }) calls.";
const ACTION = "a milestone contains only awaited actions, such as await page.getByRole('button', { name: 'Save' }).click().";
const ARGUMENTS = 'action arguments are literals, options objects or locators.';

const fail = (node, message) => { throw new Error(`Line ${node?.loc?.start.line ?? 1}: ${message}`); };
const text = node => node?.type === 'StringLiteral' ? node.value : node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : null;
const named = (node, name) => node?.type === 'Identifier' && node.name === name;
const member = node => node?.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' ? node.property.name : null;
const label = node => node.type === 'Identifier' ? node.name : node.type === 'MemberExpression' ? `${label(node.object)}${member(node) ? `.${member(node)}` : '[…]'}` : node.type === 'CallExpression' ? `${label(node.callee)}()` : '…';
const awaited = statement => statement.type === 'ExpressionStatement' && statement.expression.type === 'AwaitExpression' && statement.expression.argument.type === 'CallExpression' ? statement.expression.argument : null;
const statements = block => block.body.filter(statement => statement.type !== 'EmptyStatement');
const allowed = (owner, name) => Boolean(owner) && Object.hasOwn(API[owner], name) ? API[owner][name] : null;

// The Playwright object an expression yields, or null; the arguments of every call on the way are checked.
function kind(node, scope) {
  if (named(node, 'page')) return scope.has('page') ? 'page' : null;
  if (node.type === 'MemberExpression') { const owner = member(node) && kind(node.object, scope); return owner && Object.hasOwn(PROPERTIES[owner] || {}, member(node)) ? PROPERTIES[owner][member(node)] : null; }
  if (node.type !== 'CallExpression' || !member(node.callee)) return null;
  const next = allowed(kind(node.callee.object, scope), member(node.callee));
  if (typeof next !== 'string') return null;
  node.arguments.forEach(item => value(item, scope));
  return next;
}
function value(node, scope) {
  if (LITERALS.has(node.type) || text(node) !== null || node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral') return;
  if (node.type === 'ArrayExpression') return node.elements.forEach(item => item ? value(item, scope) : fail(node, ARGUMENTS));
  if (node.type === 'ObjectExpression') return node.properties.forEach(item => {
    const key = item.key?.type === 'Identifier' ? item.key.name : item.key?.type === 'StringLiteral' ? item.key.value : null;
    if (item.type !== 'ObjectProperty' || item.computed || item.shorthand || key === null || RESERVED.has(key)) fail(item, ARGUMENTS);
    value(item.value, scope);
  });
  if (kind(node, scope) !== 'locator') fail(node, ARGUMENTS);
}
function action(statement, scope) {
  const call = awaited(statement), name = call && member(call.callee);
  if (!name) fail(statement, ACTION);
  if (named(call.callee.object, 'journey') && scope.has('journey')) return name === 'signIn' && !call.arguments.length || fail(call, 'journey.signIn() is the only journey call inside a milestone.');
  const owner = kind(call.callee.object, scope);
  if (allowed(owner, name) !== true) fail(call, `${label(call.callee)} is not an allowed journey action.`);
  if (owner === 'page' && name === 'goto' && !/^https?:$/.test(URL.parse(text(call.arguments[0]) ?? '', 'http://perpetual.invalid/')?.protocol)) fail(call, 'page.goto takes an http(s) URL or a path.');
  call.arguments.forEach(item => value(item, scope));
}

export const specHash = code => createHash('sha256').update(code).digest('hex');
/** The reviewed contract an approval binds to: editing the goal, steps, checks, assertions or outcomes makes it stale. */
export const caseHash = item => specHash(JSON.stringify([item.goal, item.preconditions || [], item.steps || [], item.expectedOutcomes || [], item.assertions || []]));

/** The spec's code, when it performs exactly the case's reviewed milestones, in order, in the allowed grammar. */
export function validateJourneySpec(code, item) {
  if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > MAX_BYTES || code.includes('\0')) throw new Error('Provide a spec of at most 200 KB.');
  let program;
  try { program = parse(code); } catch (error) { throw new Error(`The spec is not valid JavaScript${error.loc ? ` (line ${error.loc.line})` : ''}.`); }
  const [head, ...rest] = program.body;
  const fixture = head?.type === 'ImportDeclaration' && head.source.value === 'perpetual' && head.importKind !== 'type' && !head.phase && !head.attributes?.length && head.specifiers.length === 1
    && head.specifiers[0].type === 'ImportSpecifier' && named(head.specifiers[0].imported, 'test') && named(head.specifiers[0].local, 'test');
  if (!fixture || rest.some(node => /^(?:Import|Export)/.test(node.type))) throw new Error(IMPORT);
  const call = rest.length === 1 && !program.directives.length && rest[0].type === 'ExpressionStatement' ? rest[0].expression : null;
  const [title, body] = call?.type === 'CallExpression' && named(call.callee, 'test') && call.arguments.length === 2 ? call.arguments : [];
  const [fixtures, ...others] = body?.params || [];
  const valid = text(title) !== null && body.type === 'ArrowFunctionExpression' && body.async && body.body.type === 'BlockStatement' && !body.body.directives.length && !others.length
    && (!fixtures || fixtures.type === 'ObjectPattern' && fixtures.properties.every(item => item.type === 'ObjectProperty' && item.shorthand && !item.computed && ['page', 'journey'].includes(item.key.name) && named(item.value, item.key.name)));
  if (!valid) throw new Error(TEST);
  const scope = new Set((fixtures?.properties || []).map(item => item.key.name)), ids = [];
  for (const statement of statements(body.body)) {
    const milestone = awaited(statement), [id, actions] = milestone?.arguments || [];
    if (!milestone || !named(milestone.callee.object, 'journey') || member(milestone.callee) !== 'milestone' || !scope.has('journey') || milestone.arguments.length !== 2) fail(statement, MILESTONES);
    if (actions.type !== 'ArrowFunctionExpression' || !actions.async || actions.params.length || actions.body.type !== 'BlockStatement' || actions.body.directives.length) fail(actions, 'milestone actions are async () => { … }.');
    ids.push(text(id));
    for (const step of statements(actions.body)) action(step, scope);
  }
  const expected = (item.steps || []).map(step => step.id);
  if (ids.length !== expected.length || ids.some((id, index) => id !== expected[index])) throw new Error(`Call journey.milestone once per reviewed step, in order, with its literal ID: ${expected.join(', ') || 'none'}.`);
  return code;
}

/** A spec that signs in needs the run's test account; a valid spec calls journey.signIn only as an action. */
export function signsIn(code) {
  const search = node => Array.isArray(node) ? node.some(search) : Boolean(node) && typeof node === 'object'
    && (named(node.object, 'journey') && member(node) === 'signIn' || Object.entries(node).some(([key, child]) => key !== 'loc' && typeof child === 'object' && search(child)));
  try { return search(parse(code)); } catch { return false; }
}
