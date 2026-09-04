// capture CLI — passive capture: open a URL with a saved session, dwell, and dump the
// distinct first-party endpoints + a HAR. No navigation, no discovery plan. Useful to
// sanity-check a session or to record one specific page by hand.
//
//   npm run capture -- https://app.example/some/page --storage storageState.json --host example.com --out page.har

import { flag, hasFlag, required } from './config.js';
import { captureFlow, distinctEndpoints } from './capture/playwright-capture.js';
import { BrowserbaseProvider, LocalBrowserProvider, type BrowserProvider } from './capture/browser-provider.js';
import { proxyFromEnv } from './capture/proxy.js';
import { BROWSER_KEYS, loadEnv } from './env-file.js';

loadEnv(BROWSER_KEYS);

async function main(): Promise<void> {
  const startUrl = process.argv[2];
  if (!startUrl || startUrl.startsWith('--')) {
    throw new Error('usage: npm run capture -- <startUrl> [--storage s.json] [--host h] [--out c.har] [--headed]');
  }
  const env = process.env;
  const proxy = proxyFromEnv();
  const provider: BrowserProvider =
    (env.BROWSER_PROVIDER ?? 'local') === 'browserbase'
      ? new BrowserbaseProvider(required(env.BROWSERBASE_API_KEY, 'BROWSERBASE_API_KEY'), required(env.BROWSERBASE_PROJECT_ID, 'BROWSERBASE_PROJECT_ID'), proxy)
      : new LocalBrowserProvider(hasFlag('--headed'), proxy);

  const harPath = flag('--out') ?? 'capture.har';
  process.stdout.write(`▶ capture via ${provider.kind}: ${startUrl}\n`);
  const result = await captureFlow({ startUrl, harPath, storageStatePath: flag('--storage'), filterHost: flag('--host'), provider });
  const endpoints = distinctEndpoints(result.routes);
  process.stdout.write(`\n■ ${result.routes.length} requests, ${endpoints.length} distinct API endpoints:\n`);
  for (const e of endpoints) process.stdout.write(`  ${e.method.padEnd(6)} ${e.status}  ${e.url}\n`);
  process.stdout.write(`\n■ HAR written to ${harPath} (holds cookies — never commit it)\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
