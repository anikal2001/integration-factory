// login CLI → produces storageState.json for discovery.
//
//   npm run login -- <target> [--url https://app.example/login] [--out storageState.json] [--headless]
//
// Headed by default: a human finishes the login (captcha, MFA, passkeys). With
// --headless, TARGET_EMAIL/TARGET_PASSWORD are typed in and an emailed code is read via
// IMAP_HOST/IMAP_USER/IMAP_APP_PASSWORD or prompted for. Credentials come from env and
// are never written anywhere but the browser form.

import { flag, hasFlag, required } from './config.js';
import { login, ManualVerificationProvider, type VerificationProvider } from './auth/login.js';
import { ImapVerificationProvider } from './auth/imap-verification.js';
import { BrowserbaseProvider, LocalBrowserProvider, type BrowserProvider } from './capture/browser-provider.js';
import { proxyFromEnv } from './capture/proxy.js';
import { BROWSER_KEYS, loadEnv } from './env-file.js';
import { loadTarget, targetFromUrl } from './target.js';

loadEnv(BROWSER_KEYS);

async function main(): Promise<void> {
  const name = process.argv[2];
  const url = flag('--url');
  if (!name || name.startsWith('--')) throw new Error('usage: npm run login -- <target> [--url https://app.example/login] [--out storageState.json] [--headless]');
  const target = (await loadTarget(name)) ?? (url ? targetFromUrl(name, url) : undefined);
  if (!target) throw new Error(`no targets/${name}.json found — pass --url for adaptive login`);
  const recipe = url ? { ...target.loginRecipe, loginUrl: url } : target.loginRecipe;

  const env = process.env;
  const headed = !hasFlag('--headless');
  if (!headed && (!env.TARGET_EMAIL || !env.TARGET_PASSWORD)) throw new Error('headless login requires TARGET_EMAIL and TARGET_PASSWORD');
  const proxy = proxyFromEnv();
  const provider: BrowserProvider =
    (env.BROWSER_PROVIDER ?? 'local') === 'browserbase'
      ? new BrowserbaseProvider(required(env.BROWSERBASE_API_KEY, 'BROWSERBASE_API_KEY'), required(env.BROWSERBASE_PROJECT_ID, 'BROWSERBASE_PROJECT_ID'), proxy)
      : new LocalBrowserProvider(headed, proxy);
  const verification: VerificationProvider = env.IMAP_HOST
    ? new ImapVerificationProvider({ host: env.IMAP_HOST, user: required(env.IMAP_USER, 'IMAP_USER'), appPassword: required(env.IMAP_APP_PASSWORD, 'IMAP_APP_PASSWORD'), fromContains: env.IMAP_FROM })
    : new ManualVerificationProvider();

  const result = await login({
    recipe,
    email: env.TARGET_EMAIL,
    password: env.TARGET_PASSWORD,
    provider,
    storageStatePath: flag('--out') ?? 'storageState.json',
    verification,
    manualAssist: headed,
    log: (m) => process.stdout.write(`  ${m}\n`),
  });
  process.stdout.write(`\n■ session saved to ${result.storageStatePath} (never commit it)\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
