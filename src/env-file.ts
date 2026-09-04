// Minimal .env loader (no dep). Pulls specific keys from a file into process.env
// without overriding anything already set. The CLIs read `.env` in the working directory
// and, optionally, EXTRA_ENV_FILE — so an operator can keep one secrets file elsewhere.

import { existsSync, readFileSync } from 'node:fs';

export function loadEnvFile(filePath: string, keys: string[]): string[] {
  if (!existsSync(filePath)) return [];
  const loaded: string[] = [];
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (!keys.includes(key) || process.env[key] !== undefined) continue;
    let val = rawVal.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
    loaded.push(key);
  }
  return loaded;
}

/** Keys the build loop reads. */
export const MODEL_KEYS = ['MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_NAME', 'SANDBOX_PROVIDER', 'DAYTONA_API_KEY', 'DAYTONA_API_URL', 'TARGET_REPO', 'BASE_REF', 'VERIFY_CMD', 'OPEN_PR', 'MAX_STEPS', 'SANDBOX_LINK_NODE_MODULES'];

/** Keys the browser CLIs read. */
export const BROWSER_KEYS = [
  'BROWSER_PROVIDER',
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'BROWSERBASE_PROXIES',
  'BROWSER_USE_API_KEY',
  'BROWSERUSE_API_KEY',
  'BROWSER_USE_MODEL',
  'PROXY_HOST',
  'PROXY_PORT',
  'PROXY_USER',
  'PROXY_PASS',
  'IMAP_HOST',
  'IMAP_USER',
  'IMAP_APP_PASSWORD',
  'IMAP_FROM',
  'TARGET_EMAIL',
  'TARGET_PASSWORD',
  'TARGET_REPO',
  'PR_BASE_REF',
];

/** Load `.env` from cwd plus EXTRA_ENV_FILE if set, for the given keys. Returns what was sourced. */
export function loadEnv(keys: string[]): string[] {
  const loaded = loadEnvFile('.env', keys);
  const extra = process.env.EXTRA_ENV_FILE;
  return extra ? [...loaded, ...loadEnvFile(extra, keys)] : loaded;
}
