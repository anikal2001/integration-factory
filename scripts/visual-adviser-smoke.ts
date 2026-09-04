import { once } from 'node:events';
import http from 'node:http';
import { LocalBrowserProvider } from '../src/capture/browser-provider.js';
import { BrowserUseVisualAdviser } from '../src/discovery/visual-adviser.js';
import { loadEnvFile } from '../src/env-file.js';

loadEnvFile('.env', ['BROWSERUSE_API_KEY', 'BROWSER_USE_API_KEY', 'BROWSER_USE_MODEL']);
const apiKey = process.env.BROWSER_USE_API_KEY ?? process.env.BROWSERUSE_API_KEY;
if (!apiKey) throw new Error('BROWSER_USE_API_KEY or BROWSERUSE_API_KEY is required');

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (req.url === '/settings') {
    res.end('<!doctype html><main><h1>Account settings</h1></main>');
    return;
  }
  res.end(`<!doctype html><header>
    <button type="button" aria-label="Open account options"
      onclick="document.querySelector('#account-menu').hidden=false">Profile avatar</button>
    <nav id="account-menu" hidden><a href="/settings">Account settings</a></nav>
  </header><main><h1>Fixture app</h1></main>`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');

const address = server.address();
if (!address || typeof address === 'string') throw new Error('fixture server did not start');
const origin = `http://127.0.0.1:${address.port}`;
const handle = await new LocalBrowserProvider(false, undefined, true).connect();

try {
  if (!handle.cdpUrl) throw new Error('local browser did not expose CDP');
  const context = await handle.browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);
  const adviser = new BrowserUseVisualAdviser({
    cdpUrl: handle.cdpUrl,
    apiKey,
    allowedHostSuffix: '127.0.0.1',
    model: process.env.BROWSER_USE_MODEL,
    projectDir: process.cwd(),
  });
  const advice = await adviser.adviseAndAct(page, {
    goal: 'accountMenu',
    targetDescription: 'Open the visible header account/profile/avatar menu without scrolling.',
    predictedPostcondition: 'A visible account menu reveals an Account settings link.',
  });
  const menuVisible = await page.getByRole('link', { name: 'Account settings' }).isVisible().catch(() => false);
  process.stdout.write(`${JSON.stringify({ advice, menuVisible })}\n`);
  if (!advice.verified || !menuVisible) process.exitCode = 1;
  await context.close();
} finally {
  await handle.dispose();
  server.close();
}
