// onboard CLI — one command: login → discover → classify → (optional) PR.
//
//   npm run onboard -- <target> [--url https://app.example/] [--login-url …] [--plan web-app-account]
//                              [--out out/<target>] [--repo ../my-backend] [--pr | --open-pr]
//                              [--headed | --headless] [--passive] [--visual]
//
// <target> is a targets/<name>.json file, a path to one, or any name when --url is given.
// If a session file already exists (from a prior human login) it skips auth and goes
// straight to discovery — the recommended path for anti-bot-gated sites.

import path from 'node:path';
import { flag, hasFlag, required } from './config.js';
import { onboard } from './onboard.js';
import { ManualVerificationProvider, type VerificationProvider } from './auth/login.js';
import { ImapVerificationProvider } from './auth/imap-verification.js';
import { BrowserbaseProvider, LocalBrowserProvider, type BrowserProvider } from './capture/browser-provider.js';
import { proxyFromEnv } from './capture/proxy.js';
import { MARKETPLACE_SELLER_PLAN } from './discovery/plan.js';
import { BrowserUseVisualAdviser } from './discovery/visual-adviser.js';
import { BROWSER_KEYS, loadEnv } from './env-file.js';
import { loadProfile, type ResolvedProfile } from './profile.js';
import { loadPlan, loadTarget, targetFromUrl } from './target.js';

const sourced = loadEnv(BROWSER_KEYS);
if (sourced.length) process.stdout.write(`  sourced from .env: ${sourced.join(', ')}\n`);

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name || name.startsWith('--')) {
    throw new Error('usage: npm run onboard -- <target> [--url https://app.example/] [--login-url …] [--plan <id|file>] [--out dir] [--repo path] [--pr|--open-pr]');
  }
  const customUrl = flag('--url');
  const preset = await loadTarget(name);
  if (!preset && !customUrl) {
    throw new Error(`no targets/${name}.json found — pass --url <public or login URL> for adaptive discovery`);
  }
  const target = preset ?? targetFromUrl(name, required(customUrl, '--url'), { host: flag('--host'), loginUrl: flag('--login-url'), plan: flag('--plan') });

  const env = process.env;
  const repoPath = flag('--repo') ?? env.TARGET_REPO;
  const wantsPr = hasFlag('--pr') || hasFlag('--open-pr');
  let profile: ResolvedProfile | undefined;
  if (repoPath) profile = await loadProfile(repoPath, flag('--profile'));
  else if (wantsPr) throw new Error('--pr needs --repo <target repo with integration-factory.json> (or TARGET_REPO)');
  const plan = await loadPlan(flag('--plan') ?? target.plan ?? profile?.discoveryPlan, MARKETPLACE_SELLER_PLAN);

  const browserUseApiKey = env.BROWSER_USE_API_KEY ?? env.BROWSERUSE_API_KEY;
  const visualRequested = hasFlag('--visual');
  if (visualRequested && !browserUseApiKey) throw new Error('--visual requires BROWSER_USE_API_KEY');
  const visualEnabled = visualRequested && !!browserUseApiKey;
  const proxy = proxyFromEnv();
  const providerKind = env.BROWSER_PROVIDER ?? 'local';
  // Gated or unknown targets default to HEADED (a human can help); override with --headless.
  const headed = target.requiresResidentialBrowser || !preset ? !hasFlag('--headless') : hasFlag('--headed');
  const provider: BrowserProvider =
    providerKind === 'browserbase'
      ? new BrowserbaseProvider(required(env.BROWSERBASE_API_KEY, 'BROWSERBASE_API_KEY'), required(env.BROWSERBASE_PROJECT_ID, 'BROWSERBASE_PROJECT_ID'), proxy)
      : new LocalBrowserProvider(headed, proxy, visualEnabled);
  const hasResidentialEgress = !!proxy || (providerKind === 'browserbase' && (env.BROWSERBASE_PROXIES ?? 'false') !== 'false');

  const outDir = flag('--out') ?? path.join('out', target.name);
  const storageStatePath = flag('--storage') ?? path.join(outDir, 'storageState.json');

  const verification: VerificationProvider = env.IMAP_HOST
    ? new ImapVerificationProvider({ host: env.IMAP_HOST, user: required(env.IMAP_USER, 'IMAP_USER'), appPassword: required(env.IMAP_APP_PASSWORD, 'IMAP_APP_PASSWORD'), fromContains: env.IMAP_FROM })
    : new ManualVerificationProvider();
  const credentials = env.TARGET_EMAIL || env.TARGET_PASSWORD ? { email: env.TARGET_EMAIL, password: env.TARGET_PASSWORD } : undefined;

  const result = await onboard({
    targetName: target.name,
    startUrl: target.startUrl,
    host: target.host,
    plan,
    outDir,
    provider,
    storageStatePath,
    loginRecipe: target.loginRecipe,
    credentials,
    verification,
    requiresResidentialBrowser: target.requiresResidentialBrowser,
    hasResidentialEgress,
    manualAssist: headed,
    adaptiveDiscovery: !hasFlag('--passive'),
    maxDiscoveryInteractions: positiveIntFlag('--max-interactions'),
    maxDiscoveryNavigations: positiveIntFlag('--max-navigations'),
    visualAdviserFactory: visualEnabled
      ? (cdpUrl) => new BrowserUseVisualAdviser({
          cdpUrl,
          apiKey: required(browserUseApiKey, 'BROWSER_USE_API_KEY'),
          allowedHostSuffix: target.host,
          model: env.BROWSER_USE_MODEL,
          projectDir: process.cwd(),
        })
      : undefined,
    profile,
    preparePr: wantsPr,
    openPr: hasFlag('--open-pr'),
    targetRepo: repoPath,
    prBaseRef: env.PR_BASE_REF,
    onVerificationRequired: () =>
      process.stdout.write(`\n🔔 CHECKPOINT 2 — ${target.name}: emailed verification code required. Set IMAP_HOST/IMAP_USER/IMAP_APP_PASSWORD to auto-read it.\n`),
    onChallenge: (detail) =>
      process.stdout.write(`\n🔔 CHECKPOINT 3 — ${target.name}: ${detail}. Needs a human at a visible browser.\n`),
    log: (m) => process.stdout.write(`  ${m}\n`),
  });

  process.stdout.write(`\n■ onboard complete for ${target.name} (plan ${plan.id})\n`);
  process.stdout.write(`  session:   ${result.storageStatePath}\n`);
  process.stdout.write(`  har:       ${result.harPath}  (never commit this)\n`);
  process.stdout.write(`  endpoints: ${result.endpointCount}  capabilities: ${result.capabilityCandidates}  enumerations: ${result.enumerationCandidates}\n`);
  process.stdout.write(`  report:    ${result.reportPath}\n`);
  process.stdout.write(`  navigate:  ${result.navigationReportPath}\n`);
  if (result.captureScaffoldPath) process.stdout.write(`  scaffold:  ${result.captureScaffoldPath}\n`);
  if (result.failures.length) process.stdout.write(`  notes:\n${result.failures.map((f) => `    - ${f}`).join('\n')}\n`);
  if (result.pr) {
    process.stdout.write(`  pr:        branch ${result.pr.branch}${result.pr.dryRun ? ` (dry-run — worktree ${result.pr.worktreePath})` : result.pr.url ? ` → ${result.pr.url}` : ''}\n`);
  }
}

function positiveIntFlag(name: string): number | undefined {
  const value = flag(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
