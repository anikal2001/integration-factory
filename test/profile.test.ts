import assert from 'node:assert/strict';
import test from 'node:test';
import { nameTokens, renderScaffold, renderScaffolds, renderTemplate, resolveProfile, scaffoldRelPaths } from '../src/profile.js';
import { assertPlan, MARKETPLACE_SELLER_PLAN, WEB_APP_ACCOUNT_PLAN, planPhases } from '../src/discovery/plan.js';
import { renderCaptureScaffold } from '../src/onboard.js';
import { shellQuote } from '../src/pr/target-repo-pr.js';

test('name tokens cover every casing an integration file needs', () => {
  assert.deepEqual(nameTokens('acme pay-2'), { name: 'acme pay-2', Pascal: 'AcmePay2', camel: 'acmePay2', kebab: 'acme-pay-2', CONSTANT: 'ACME_PAY_2' });
  assert.throws(() => nameTokens('---'), /no usable characters/);
});

test('templates replace known tokens and leave code braces alone', () => {
  const out = renderTemplate('class {{Pascal}} { run() { return {{ kebab }}; } } {{unknown}}', nameTokens('my-thing'));
  assert.equal(out, 'class MyThing { run() { return my-thing; } } {{unknown}}');
});

test('profiles get defaults and reject unsafe paths', () => {
  const profile = resolveProfile({ name: 'svc', contractFiles: ['src/a.ts'], scaffold: { path: 'src/{{Pascal}}.ts' } }, 'x.json');
  assert.equal(profile.docsDir, 'docs/integrations');
  assert.equal(profile.branchPrefix, 'integrations/');
  assert.equal(profile.baseRef, 'origin/main');
  assert.equal(profile.discoveryPlan, 'marketplace-seller');
  assert.throws(() => resolveProfile({ name: 'svc', contractFiles: [], scaffold: { path: '../escape.ts' } }, 'x.json'), /repo-relative/);
  assert.throws(() => resolveProfile({ contractFiles: [], scaffold: { path: 'a' } }, 'x.json'), /"name" is required/);
  assert.throws(() => resolveProfile({ name: 'svc', contractFiles: [], scaffold: [] }, 'x.json'), /"scaffold" must be/);
});

test('multi-file scaffolds render every file in profile order', async () => {
  const profile = resolveProfile({
    name: 'svc',
    contractFiles: ['src/IThing.ts'],
    scaffold: [
      { path: 'src/{{Pascal}}Adapter.ts', template: 'tpl/adapter.ts' },
      { path: 'src/services/{{kebab}}/index.ts' },
    ],
    setup: 'npm ci',
    referenceFiles: ['src/ExistingAdapter.ts'],
  }, 'x.json');
  assert.equal(profile.setup, 'npm ci');
  assert.deepEqual(profile.referenceFiles, ['src/ExistingAdapter.ts']);
  assert.deepEqual(scaffoldRelPaths(profile, 'fast ship'), ['src/FastShipAdapter.ts', 'src/services/fast-ship/index.ts']);
  const files = await renderScaffolds(profile, 'fast ship', async (rel) => `// ${rel} for {{Pascal}}`);
  assert.deepEqual(files.map((f) => f.relPath), ['src/FastShipAdapter.ts', 'src/services/fast-ship/index.ts']);
  assert.equal(files[0].content, '// tpl/adapter.ts for FastShip');
  assert.match(files[1].content, /export class FastShipIntegration/);
});

test('scaffold rendering uses the template when present and a generic stub otherwise', async () => {
  const base = { name: 'svc', contractFiles: ['src/IThing.ts'], registration: ['register {{Pascal}} in the map'] };
  const withTemplate = resolveProfile({ ...base, scaffold: { path: 'src/{{Pascal}}.ts', template: 'tpl.ts' } }, 'x.json');
  const rendered = await renderScaffold(withTemplate, 'fast-ship', async (rel) => `// ${rel}\nexport const id = '{{kebab}}';`);
  assert.equal(rendered, "// tpl.ts\nexport const id = 'fast-ship';");

  const generic = resolveProfile({ ...base, scaffold: { path: 'src/{{Pascal}}.ts' } }, 'x.json');
  const stub = await renderScaffold(generic, 'fast-ship', async () => { throw new Error('should not read'); });
  assert.match(stub, /export class FastShipIntegration/);
  assert.match(stub, /register FastShip in the map/);
  assert.match(stub, /src\/IThing\.ts/);
});

test('built-in plans validate and enumerate phases in traversal order', () => {
  assert.deepEqual(planPhases(MARKETPLACE_SELLER_PLAN), ['bootstrap', 'listing', 'taxonomy', 'settings', 'shippingSettings', 'orders', 'soldListings']);
  assert.deepEqual(planPhases(WEB_APP_ACCOUNT_PLAN), ['bootstrap', 'dashboard', 'settings', 'integrations', 'notifications', 'activity', 'exportHistory']);
  assert.equal(assertPlan(MARKETPLACE_SELLER_PLAN), MARKETPLACE_SELLER_PLAN);
  assert.throws(() => assertPlan({ id: 'x', surfaces: [{ id: 'a', hints: ['a'] }, { id: 'a', hints: ['b'] }] }), /duplicate phase id/);
  assert.throws(() => assertPlan({ id: 'x', surfaces: [{ id: 'a', hints: ['a'], pathPattern: '(' }] }), /not a valid regex/);
});

test('capture scaffold renders a template or a generic module and never includes values', () => {
  const endpoints = [{ method: 'GET', url: 'api.example.test/v1/services?{value}', status: 200, resourceType: 'fetch', observedDuring: ['serviceLevel'] }];
  const candidates = [{ control: 'serviceLevel', method: 'GET', url: 'api.example.test/v1/services', status: 200, score: 7, reason: 'url signal', responseShape: { services: { array: { code: 'string' } } } }];
  const generic = renderCaptureScaffold('fast-ship', candidates, endpoints);
  assert.match(generic, /export const fastShipCapturedEndpoints = \[/);
  assert.match(generic, /\[serviceLevel\] GET api\.example\.test\/v1\/services/);
  assert.match(generic, /export interface FastShipCapture/);
  const templated = renderCaptureScaffold('fast-ship', candidates, endpoints, '/* {{Pascal}} */\n{{endpointsComment}}\nexport const x = {{endpointsJson}};');
  assert.match(templated, /^\/\* FastShip \*\//);
  assert.match(templated, /"observedDuring": \[\n\s+"serviceLevel"/);
});

test('shell quoting survives quotes, dollars, backticks and newlines', () => {
  assert.equal(shellQuote('feat: "x" $y `z`\nnext'), '"feat: \\"x\\" \\$y \\`z\\` next"');
});
