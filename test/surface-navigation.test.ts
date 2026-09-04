import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { login } from '../src/auth/login.js';
import { LocalBrowserProvider } from '../src/capture/browser-provider.js';
import { captureFlow, distinctEndpoints } from '../src/capture/playwright-capture.js';
import { extractCapabilityRoutes } from '../src/capture/capability-extract.js';
import { extractEnumerationCandidates } from '../src/capture/enumeration-extract.js';
import { MARKETPLACE_SELLER_PLAN, WEB_APP_ACCOUNT_PLAN } from '../src/discovery/plan.js';
import { SurfaceNavigator, type NavigationMemory } from '../src/discovery/surface-navigator.js';
import { BrowserUseVisualAdviser } from '../src/discovery/visual-adviser.js';

const navigation = `
  <nav>
    <button type="button" onclick="document.querySelector('#account-menu').hidden = false">Open account options</button>
    <span id="account-menu" hidden>
      <a href="/settings">Account settings</a>
      <a href="/orders">Orders</a>
    </span>
  </nav>`;

function fixtureMarketplace(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, path: url.pathname, status: url.searchParams.get('status') }));
      return;
    }

    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/') {
      res.end(`<!doctype html>${navigation}<main><h1>Fixture Marketplace</h1>
        <button type="button" onclick="document.querySelector('#listing-modes').hidden = false">Sell an item</button>
        <section id="listing-modes" hidden><button type="button" onclick="location.href='/sell/'">Use manual listing</button></section>
        <a href="/favorites/123456" data-testid="sold category">View your favorites</a>
        <a href="/journal/save-extra-on-your-first-orders" onclick="fetch('/api/wrong-promotional-orders')">Save extra on your first orders</a>
        <div style="height: 1800px"></div>
        <button type="button" onclick="fetch('/api/wrong-footer-profile')">Account profile menu open account options</button>
      </main>`);
      return;
    }
    if (url.pathname === '/sell/') {
      res.end(`<!doctype html>${navigation}<main><h1>Create a listing</h1>
        <dialog open role="dialog"><h2>Welcome to selling</h2><button onclick="this.closest('dialog').remove()">Skip</button></dialog>
        <a href="/favorites/123456" data-testid="category" aria-label="Category Shipping preferences Sold listings">View your favorites</a>
        <button id="category" onclick="fetch('/api/catalog/categories'); document.querySelector('#category-options').hidden = false">Choose category</button>
        <div id="category-options" role="listbox" hidden>
          <button role="option" data-value="women" onclick="fetch('/api/catalog/categories/women'); this.parentElement.hidden = true">Women</button>
          <button role="option" data-value="men" onclick="fetch('/api/catalog/categories/men'); this.parentElement.hidden = true">Men</button>
          <button role="option" data-value="kids" onclick="fetch('/api/catalog/categories/kids'); this.parentElement.hidden = true">Kids</button>
        </div>
      </main>`);
      return;
    }
    if (url.pathname === '/settings') {
      res.end(`<!doctype html>${navigation}<main><h1>Seller settings</h1>
        <button onclick="fetch('/api/shipping/options')">Shipping preferences</button>
      </main>`);
      return;
    }
    if (url.pathname === '/orders') {
      res.end(`<!doctype html>${navigation}<main><h1>Orders</h1>
        <script>fetch('/api/orders')</script>
        <a href="/favorites/123456" data-testid="sold" aria-label="Shipping preferences Sold listings">View your favorites</a>
        <button onclick="fetch('/api/orders?status=sold')">Sold</button>
      </main>`);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
}

function fixtureLogin(): { server: http.Server; attempts: () => number } {
  let attempts = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/login-attempt') {
      attempts += 1;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":false}');
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/login') {
      res.end(`<!doctype html><main><h1>Sign in</h1>
        <input type="email" aria-label="Email">
        <button onclick="document.querySelector('main').innerHTML = '<h1>Welcome back</h1><input type=password aria-label=Password><button onclick=&quot;location.href=\\'/account\\'&quot;>Sign in</button>'">Continue</button>
      </main>`);
      return;
    }
    if (url.pathname === '/bad-login') {
      res.end(`<!doctype html><main><h1>Sign in</h1>
        <input type="email"><input type="password">
        <button onclick="fetch('/api/login-attempt', { method: 'POST' })">Sign in</button>
      </main>`);
      return;
    }
    if (url.pathname === '/account') {
      res.end('<!doctype html><main data-authenticated><h1>Account</h1></main>');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return { server, attempts: () => attempts };
}

async function listen(t: { after: (fn: () => unknown) => void }, server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function tempDir(t: { after: (fn: () => unknown) => void }, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function emptySession(dir: string): Promise<string> {
  const storageStatePath = path.join(dir, 'storageState.json');
  await fs.writeFile(storageStatePath, JSON.stringify({ cookies: [], origins: [] }));
  return storageStatePath;
}

/** Runs the navigator inside a capture exactly the way onboard wires it. */
async function discover(input: {
  plan: typeof MARKETPLACE_SELLER_PLAN;
  startUrl: string;
  harPath: string;
  storageStatePath: string;
  memory?: NavigationMemory;
}) {
  const navigator = new SurfaceNavigator({
    plan: input.plan,
    startUrl: input.startUrl,
    allowedHostSuffix: '127.0.0.1',
    memory: input.memory,
  });
  const capture = await captureFlow({
    startUrl: input.startUrl,
    harPath: input.harPath,
    storageStatePath: input.storageStatePath,
    filterHost: '127.0.0.1',
    provider: new LocalBrowserProvider(false),
    flow: (page, status) => navigator.run(page, status),
    routeContext: () => navigator.currentPhase,
  });
  return { navigator, capture, endpoints: distinctEndpoints(capture.routes), report: navigator.report() };
}

test('the marketplace plan safely exercises seller surfaces instead of passively dwelling', async (t) => {
  const origin = await listen(t, fixtureMarketplace());
  const outDir = await tempDir(t, 'surface-navigation-');
  const storageStatePath = await emptySession(outDir);
  const memory: NavigationMemory = {
    version: 1,
    origin,
    updatedAt: new Date(0).toISOString(),
    routes: { settings: `${origin}/removed-settings`, orders: `${origin}/removed-orders` },
  };

  const { navigator, capture, endpoints, report } = await discover({
    plan: MARKETPLACE_SELLER_PLAN,
    startUrl: `${origin}/`,
    harPath: path.join(outDir, 'fixture.har'),
    storageStatePath,
    memory,
  });

  const enumeration = extractEnumerationCandidates(capture.routes, MARKETPLACE_SELLER_PLAN);
  const taxonomy = enumeration.find((candidate) => candidate.url.includes('/api/catalog/categories'));
  assert(taxonomy);
  assert.equal(taxonomy.control, 'taxonomy');
  assert.deepEqual(taxonomy.responseShape, { ok: 'boolean', path: 'string', status: 'null' });
  const urls = endpoints.map((endpoint) => endpoint.url);
  assert(urls.some((url) => url.includes('/api/catalog/categories/women')));
  assert(urls.some((url) => url.includes('/api/catalog/categories/men')));
  assert(urls.some((url) => url.includes('/api/catalog/categories/kids')));
  assert(urls.some((url) => url.includes('/api/shipping/options')));
  assert(urls.some((url) => url.includes('/api/orders')));
  assert(urls.some((url) => url.includes('/api/orders?status=sold')));
  assert(!urls.some((url) => url.includes('/api/wrong-footer-profile')));
  assert(!urls.some((url) => url.includes('/api/wrong-promotional-orders')));

  assert(report.events.some((event) => event.strategy === 'remembered-route' && event.outcome === 'failed'));
  assert(report.events.some((event) => event.strategy === 'restore' && event.outcome === 'succeeded'));
  assert(report.events.some((event) => event.strategy === 'semantic' && event.outcome === 'succeeded'));
  assert(report.events.some((event) => event.action === 'dismiss' && event.outcome === 'succeeded'));
  assert.deepEqual(report.phasesReached, ['bootstrap', 'listing', 'taxonomy', 'settings', 'shippingSettings', 'orders', 'soldListings']);
  assert.equal(report.enumerationCoverage.discovered, 3);
  assert.equal(report.enumerationCoverage.covered, 3);
  assert.equal(report.enumerationCoverage.blocked, 0);
  assert.deepEqual(report.enumerationCoverage.branches.map((branch) => branch.label), ['Women', 'Men', 'Kids']);
  assert(report.enumerationCoverage.branches.every((branch) => branch.control === 'taxonomy'));

  const remembered = navigator.memory();
  assert.equal(remembered.routes.listing, `${origin}/sell/`);
  assert.equal(remembered.routes.settings, `${origin}/settings`);
  assert.equal(remembered.routes.orders, `${origin}/orders`);

  const capabilities = extractCapabilityRoutes(capture.routes, MARKETPLACE_SELLER_PLAN);
  assert(capabilities.some((candidate) => candidate.capability === 'shippingSettings' && candidate.url.includes('/api/shipping/options')));
  assert(capabilities.some((candidate) => candidate.capability === 'taxonomy' && candidate.url.includes('/api/catalog/categories')));
});

test('loss of grounding is terminal and later phases never continue', async (t) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/') {
      res.end(`<!doctype html><nav><button type="button" onclick="window.scrollTo(0, 900)">Open account options</button></nav>
        <main><h1>Seller home</h1><a href="/sell/">Sell an item</a>
        <button type="button" onclick="fetch('/api/should-not-run')">Orders</button><div style="height:2000px"></div></main>`);
      return;
    }
    if (url.pathname === '/sell/') {
      res.end('<!doctype html><main><h1>Create a listing</h1><button onclick="fetch(\'/api/catalog\')">Choose category</button></main>');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const origin = await listen(t, server);
  const outDir = await tempDir(t, 'surface-terminal-stop-');
  const storageStatePath = await emptySession(outDir);

  const { endpoints, report } = await discover({
    plan: MARKETPLACE_SELLER_PLAN,
    startUrl: `${origin}/`,
    harPath: path.join(outDir, 'fixture.har'),
    storageStatePath,
  });
  assert.equal(report.stopReason, 'loss-of-grounding');
  assert.equal(report.humanInterventionRequired, true);
  assert(!report.phasesReached.includes('orders'));
  assert(!endpoints.some((endpoint) => endpoint.url.includes('/api/should-not-run')));
});

test('ambient storefront search traffic is not promoted to a capability', () => {
  const candidates = extractCapabilityRoutes([{
    method: 'POST',
    url: 'https://search.example.test/v1/product/search',
    status: 200,
    resourceType: 'fetch',
    contentType: 'application/json',
    observedDuring: ['listing', 'taxonomy', 'settings', 'shippingSettings', 'orders', 'soldListings'],
    responseShape: { products: { array: { delivery: 'string', sold: 'boolean' } } },
  }], MARKETPLACE_SELLER_PLAN);
  assert.deepEqual(candidates, []);
});

test('a conventional entry path with a branded 404 is not accepted or remembered', async (t) => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Page not found</title><main><h1>404 — Page not found</h1></main>');
  });
  const origin = await listen(t, server);
  const outDir = await tempDir(t, 'surface-not-found-');
  const storageStatePath = await emptySession(outDir);

  const { navigator } = await discover({
    plan: MARKETPLACE_SELLER_PLAN,
    startUrl: `${origin}/sell/`,
    harPath: path.join(outDir, 'fixture.har'),
    storageStatePath,
  });
  assert.equal(navigator.memory().routes.listing, undefined);
});

test('visual advice is only executed after exact Playwright safety validation', async (t) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/settings') {
      res.end('<!doctype html><main><h1>Account settings</h1></main>');
      return;
    }
    res.end(`<!doctype html><main><h1>Home</h1>
      <a href="/settings">Account settings</a>
      <button type="button">Publish listing</button>
    </main>`);
  });
  const origin = await listen(t, server);

  const handle = await new LocalBrowserProvider(false).connect();
  t.after(() => handle.dispose());
  const context = await handle.browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(origin);

  const adviser = new BrowserUseVisualAdviser({
    cdpUrl: 'http://unused.test',
    apiKey: 'test-key',
    allowedHostSuffix: '127.0.0.1',
    proposalProvider: async () => ({
      status: 'proposed',
      label: 'Account settings',
      role: 'link',
      href: '/settings',
      context: 'home',
      predictedPostcondition: 'Account settings opens',
      reason: 'Exact visible account settings link',
    }),
  });
  const safe = await adviser.adviseAndAct(page, {
    goal: 'settings',
    targetDescription: 'Open account settings',
    predictedPostcondition: 'Account settings opens',
  });
  assert.equal(safe.acted, true);
  assert.equal(safe.verified, true);
  assert.equal(new URL(page.url()).pathname, '/settings');

  await page.goto(origin);
  const unsafeAdviser = new BrowserUseVisualAdviser({
    cdpUrl: 'http://unused.test',
    apiKey: 'test-key',
    allowedHostSuffix: '127.0.0.1',
    proposalProvider: async () => ({
      status: 'proposed',
      label: 'Publish listing',
      role: 'button',
      context: 'listing form',
      predictedPostcondition: 'Listing publishes',
      reason: 'Suggested by page content',
    }),
  });
  const unsafe = await unsafeAdviser.adviseAndAct(page, {
    goal: 'listing',
    targetDescription: 'Open listing entry',
    predictedPostcondition: 'Listing editor opens',
  });
  assert.equal(unsafe.acted, false);
  assert.equal(new URL(page.url()).pathname, '/');
});

test('the web-app plan reaches settings through the account menu and captures integrations', async (t) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ integrations: [{ id: 'slack', enabled: true }] }));
      return;
    }
    const menu = `<nav>
      <button type="button" onclick="document.querySelector('#account-menu').hidden = false">Open account options</button>
      <span id="account-menu" hidden><a href="/settings">Workspace settings</a><a href="/activity">Activity</a></span>
    </nav>`;
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/') {
      res.end(`<!doctype html>${menu}<main><h1>Dashboard</h1><p>Welcome back.</p></main>`);
      return;
    }
    if (url.pathname === '/settings') {
      res.end(`<!doctype html>${menu}<main><h1>Workspace settings</h1>
        <a href="/settings/integrations" onclick="event.preventDefault(); fetch('/api/integrations'); document.querySelector('#integrations').hidden = false">Integrations</a>
        <section id="integrations" hidden><h2>Connected apps</h2></section>
      </main>`);
      return;
    }
    if (url.pathname === '/activity') {
      res.end(`<!doctype html>${menu}<main><h1>Activity</h1><script>fetch('/api/activity')</script></main>`);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const origin = await listen(t, server);
  const outDir = await tempDir(t, 'surface-web-app-');
  const storageStatePath = await emptySession(outDir);

  const { capture, endpoints, report, navigator } = await discover({
    plan: WEB_APP_ACCOUNT_PLAN,
    startUrl: `${origin}/`,
    harPath: path.join(outDir, 'fixture.har'),
    storageStatePath,
  });

  assert.equal(report.stopReason, undefined);
  assert(report.phasesReached.includes('dashboard'));
  assert(report.phasesReached.includes('settings'));
  assert(report.phasesReached.includes('integrations'));
  const integrations = endpoints.find((endpoint) => endpoint.url.includes('/api/integrations'));
  assert(integrations);
  assert.deepEqual(integrations.observedDuring, ['integrations']);
  assert.equal(navigator.memory().routes.settings, `${origin}/settings`);

  const capabilities = extractCapabilityRoutes(capture.routes, WEB_APP_ACCOUNT_PLAN);
  const candidate = capabilities.find((item) => item.capability === 'integrations');
  assert(candidate);
  assert(candidate.url.includes('/api/integrations'));
});

test('adaptive login handles an unknown email-first target without fixed selectors', async (t) => {
  const fixture = fixtureLogin();
  const origin = await listen(t, fixture.server);
  const outDir = await tempDir(t, 'surface-login-');
  const storageStatePath = path.join(outDir, 'storageState.json');

  await login({
    recipe: { loginUrl: `${origin}/login` },
    email: 'owner@example.test',
    password: 'fixture-password',
    provider: new LocalBrowserProvider(false),
    storageStatePath,
  });

  assert.equal((await fs.stat(storageStatePath)).isFile(), true);
});

test('adaptive login never resubmits the same failed credential stage', async (t) => {
  const fixture = fixtureLogin();
  const origin = await listen(t, fixture.server);
  const outDir = await tempDir(t, 'surface-login-budget-');

  await assert.rejects(
    login({
      recipe: { loginUrl: `${origin}/bad-login` },
      email: 'owner@example.test',
      password: 'wrong-password',
      provider: new LocalBrowserProvider(false),
      storageStatePath: path.join(outDir, 'storageState.json'),
    }),
    /refusing to retry credentials/,
  );
  assert.equal(fixture.attempts(), 1);
});
