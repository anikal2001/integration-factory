// An IntegrationTarget is the third party being integrated: where its web UI lives, how
// to log in, which discovery plan applies, and whether it sits behind an anti-bot layer.
// Targets are JSON files (targets/<name>.json, or any path via --target) so a login
// selector tweak never requires a code change. A bare --url also works.

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { LoginRecipe } from './auth/login.js';
import { assertPlan, BUILTIN_PLANS, type DiscoveryPlan } from './discovery/plan.js';

export interface IntegrationTarget {
  name: string;
  /** Page to start discovery from. A public seller/home page is fine; login is followed from it. */
  startUrl: string;
  /** Host suffix that counts as first-party (api + app subdomains). Derived from startUrl if omitted. */
  host?: string;
  /** Dedicated login page. Defaults to startUrl (adaptive login follows a visible Sign in link). */
  loginUrl?: string;
  /** Confirmed selectors. Semantic discovery is the fallback; leave empty for unknown DOMs. */
  login?: Omit<LoginRecipe, 'loginUrl'>;
  /**
   * True when a headless datacenter browser is blocked (Cloudflare Turnstile, DataDome…).
   * Discovery then refuses to run without a residential egress and defaults to a headed
   * browser that a human can help.
   */
  requiresResidentialBrowser?: boolean;
  /** Built-in plan id or a JSON file path (relative to the target file). */
  plan?: string;
  /** Informational: API docs URL for API-first targets. */
  docsUrl?: string;
}

export interface ResolvedTarget extends IntegrationTarget {
  host: string;
  loginUrl: string;
  loginRecipe: LoginRecipe;
}

export function resolveTarget(raw: IntegrationTarget): ResolvedTarget {
  if (!raw.name) throw new Error('target.name is required');
  const parsed = parseHttpUrl(raw.startUrl, 'target.startUrl');
  const loginUrl = raw.loginUrl ? parseHttpUrl(raw.loginUrl, 'target.loginUrl').toString() : parsed.toString();
  return {
    ...raw,
    startUrl: parsed.toString(),
    host: raw.host ?? parsed.hostname.replace(/^www\./i, ''),
    loginUrl,
    loginRecipe: { loginUrl, ...(raw.login ?? {}) },
  };
}

export function targetFromUrl(name: string, startUrl: string, opts: { host?: string; loginUrl?: string; plan?: string } = {}): ResolvedTarget {
  return resolveTarget({ name, startUrl, host: opts.host, loginUrl: opts.loginUrl, plan: opts.plan });
}

/** Load targets/<name>.json from `targetsDir`, or an explicit file path. */
export async function loadTarget(nameOrPath: string, targetsDir = 'targets'): Promise<ResolvedTarget | undefined> {
  const candidates = [nameOrPath, path.join(targetsDir, `${nameOrPath}.json`)];
  for (const candidate of candidates) {
    if (!candidate.endsWith('.json') || !existsSync(candidate)) continue;
    const raw = JSON.parse(await fs.readFile(candidate, 'utf8')) as IntegrationTarget;
    const resolved = resolveTarget({ ...raw, name: raw.name ?? path.basename(candidate, '.json') });
    if (resolved.plan && !BUILTIN_PLANS[resolved.plan]) {
      resolved.plan = path.resolve(path.dirname(candidate), resolved.plan);
    }
    return resolved;
  }
  return undefined;
}

/** Resolve a plan reference: built-in id, or a JSON file. */
export async function loadPlan(ref: string | undefined, fallback: DiscoveryPlan): Promise<DiscoveryPlan> {
  if (!ref) return fallback;
  const builtin = BUILTIN_PLANS[ref];
  if (builtin) return builtin;
  if (!existsSync(ref)) {
    throw new Error(`unknown discovery plan "${ref}". Built-ins: ${Object.keys(BUILTIN_PLANS).join(', ')}; or pass a JSON file path.`);
  }
  return assertPlan(JSON.parse(await fs.readFile(ref, 'utf8')));
}

function parseHttpUrl(value: string | undefined, label: string): URL {
  if (!value) throw new Error(`${label} is required`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${label} must be http(s)`);
  return parsed;
}
