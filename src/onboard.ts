// onboard — the single command that chains the non-API discovery flow for a target:
//   1. AUTH:      login (email+password+mailbox code, or a human in a headed browser) →
//                 storageState.json, OR reuse an existing session file.
//   2. DISCOVER:  drive the authenticated session over the plan's surfaces → HAR + a
//                 sanitized distinct-endpoints report + a navigation audit.
//   3. CLASSIFY:  correlate endpoints with capabilities and enumerated reference data,
//                 and render the profile's capture scaffold.
//   4. PR:        optionally write the doc + scaffold into a branch of the target repo.
//
// Every stage degrades honestly: an auth wall stops at step 1 with a clear message
// rather than pretending later steps succeeded.

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { login, type LoginRecipe, type VerificationProvider } from './auth/login.js';
import { captureFlow, distinctEndpoints, type CapturedRoute } from './capture/playwright-capture.js';
import { extractCapabilityRoutes, type CapabilityRouteCandidate } from './capture/capability-extract.js';
import { extractEnumerationCandidates, type EnumerationCandidate } from './capture/enumeration-extract.js';
import type { BrowserProvider } from './capture/browser-provider.js';
import type { DiscoveryPlan } from './discovery/plan.js';
import {
  SurfaceNavigator,
  passiveDiscoveryReport,
  type DiscoveryReport,
  type NavigationMemory,
} from './discovery/surface-navigator.js';
import type { VisualNavigationAdviser } from './discovery/visual-adviser.js';
import { nameTokens, renderRegistration, renderTemplate, scaffoldRelPath, type ResolvedProfile } from './profile.js';
import { buildDiscoveryDoc } from './pr/discovery-doc.js';
import { prepareDiscoveryPr, type DiscoveryPrResult } from './pr/discovery-pr.js';

export interface OnboardConfig {
  targetName: string;
  startUrl: string;
  host: string;
  plan: DiscoveryPlan;
  outDir: string;
  provider: BrowserProvider;
  storageStatePath: string;
  loginRecipe?: LoginRecipe;
  credentials?: { email?: string; password?: string };
  verification?: VerificationProvider;
  /** When true, refuse to run without a residential egress (proxy or managed). */
  requiresResidentialBrowser?: boolean;
  /** Whether a residential egress is actually configured (proxy or Browserbase managed proxies). */
  hasResidentialEgress?: boolean;
  /** Human completes login in a visible browser. */
  manualAssist?: boolean;
  /** Disable only for a deliberately passive capture. Adaptive safe discovery is on by default. */
  adaptiveDiscovery?: boolean;
  maxDiscoveryInteractions?: number;
  maxDiscoveryNavigations?: number;
  discoveryActionDelayMs?: number;
  /** Creates a one-action visual adviser after the browser exposes its CDP endpoint. */
  visualAdviserFactory?: (cdpUrl: string) => VisualNavigationAdviser;
  /** Profile of the codebase receiving the integration. Needed for the capture scaffold and the PR. */
  profile?: ResolvedProfile;
  /** After discovery, write a doc + scaffold branch into the target repo. Requires `profile` and `targetRepo`. */
  preparePr?: boolean;
  /** Actually push + open the PR (default false = dry-run). */
  openPr?: boolean;
  targetRepo?: string;
  prBaseRef?: string;
  /** Checkpoint pings surfaced to the operator (2 = code needed, 3 = captcha). */
  onVerificationRequired?: () => void;
  onChallenge?: (detail: string) => void;
  log?: (msg: string) => void;
}

export interface OnboardResult {
  storageStatePath: string;
  harPath: string;
  endpointCount: number;
  capabilityCandidates: number;
  enumerationCandidates: number;
  reportPath: string;
  navigationReportPath: string;
  navigationMemoryPath: string;
  captureScaffoldPath?: string;
  discovery: DiscoveryReport;
  failures: string[];
  pr?: DiscoveryPrResult;
}

export async function onboard(cfg: OnboardConfig): Promise<OnboardResult> {
  const log = cfg.log ?? (() => {});
  const failures: string[] = [];

  if (cfg.requiresResidentialBrowser && !cfg.hasResidentialEgress) {
    throw new Error(
      `${cfg.targetName} is behind anti-bot protection (residential egress required). ` +
        `Set PROXY_HOST/PROXY_PORT/PROXY_USER/PROXY_PASS — used by local Playwright or as a Browserbase external proxy. A plain datacenter IP is blocked.`,
    );
  }
  if (cfg.preparePr && (!cfg.profile || !cfg.targetRepo)) {
    throw new Error('preparePr needs a target repo with an integration profile (TARGET_REPO / --repo)');
  }

  await fs.mkdir(cfg.outDir, { recursive: true });

  // ── 1. AUTH ────────────────────────────────────────────────────────────────
  let loginAttempted = false;
  const canLogin = !!cfg.loginRecipe && (!!cfg.manualAssist || (!!cfg.credentials?.email && !!cfg.credentials?.password));
  const performLogin = async (): Promise<void> => {
    if (!cfg.loginRecipe || !canLogin) {
      throw new Error('login needs either a headed manual-assist session or TARGET_EMAIL/TARGET_PASSWORD');
    }
    loginAttempted = true;
    await login({
      recipe: cfg.loginRecipe,
      email: cfg.credentials?.email,
      password: cfg.credentials?.password,
      provider: cfg.provider,
      storageStatePath: cfg.storageStatePath,
      verification: cfg.verification,
      manualAssist: cfg.manualAssist,
      onVerificationRequired: () => {
        failures.push('login required an emailed verification code (checkpoint 2)');
        cfg.onVerificationRequired?.();
      },
      onChallenge: (d) => {
        failures.push(`login hit an anti-bot challenge: ${d} (checkpoint 3)`);
        cfg.onChallenge?.(d);
      },
      log,
    });
  };

  if (existsSync(cfg.storageStatePath)) {
    log(`auth: reusing existing session ${cfg.storageStatePath}`);
  } else if (canLogin) {
    log('auth: no session — logging in');
    await performLogin();
  } else {
    throw new Error(`no session at ${cfg.storageStatePath} and no login recipe/credentials — provide one`);
  }

  // ── 2. DISCOVER ────────────────────────────────────────────────────────────
  const stem = nameTokens(cfg.targetName).kebab;
  const harPath = path.join(cfg.outDir, `${stem}.har`);
  const navigationReportPath = path.join(cfg.outDir, `${stem}-navigation.json`);
  const navigationMemoryPath = path.join(cfg.outDir, `${stem}-navigation-memory.json`);
  const navigationMemory = await readNavigationMemory(navigationMemoryPath, failures);
  const runCapture = async (): Promise<{ routes: CapturedRoute[]; navigator: SurfaceNavigator; discovery: DiscoveryReport }> => {
    const navigator = new SurfaceNavigator({
      plan: cfg.plan,
      startUrl: cfg.startUrl,
      allowedHostSuffix: cfg.host,
      memory: navigationMemory,
      maxInteractions: cfg.maxDiscoveryInteractions,
      maxNavigations: cfg.maxDiscoveryNavigations,
      actionDelayMs: cfg.discoveryActionDelayMs,
      log,
    });
    log(`discover: driving ${cfg.startUrl} with plan "${cfg.plan.id}"`);
    const cap = await captureFlow({
      startUrl: cfg.startUrl,
      harPath,
      storageStatePath: cfg.storageStatePath,
      filterHost: cfg.host,
      provider: cfg.provider,
      ...(cfg.adaptiveDiscovery === false ? {} : {
        flow: (page, initialResponseStatus, browser) => {
          if (cfg.visualAdviserFactory && browser?.cdpUrl) {
            navigator.setVisualAdviser(cfg.visualAdviserFactory(browser.cdpUrl));
          } else if (cfg.visualAdviserFactory) {
            failures.push('visual adviser requested but browser did not expose a CDP endpoint');
          }
          return navigator.run(page, initialResponseStatus);
        },
        routeContext: () => navigator.currentPhase,
      }),
    });
    return {
      routes: cap.routes,
      navigator,
      discovery: cfg.adaptiveDiscovery === false ? passiveDiscoveryReport() : navigator.report(),
    };
  };

  let captured = await runCapture();
  if (captured.discovery.stopReason === 'authentication-required') {
    if (loginAttempted || !canLogin) {
      throw new Error('saved session is expired; login is required before discovery can continue');
    }
    log('auth: saved session expired — refreshing it once');
    await performLogin();
    captured = await runCapture();
    if (captured.discovery.stopReason === 'authentication-required') {
      throw new Error('target still requested login after one refresh; refusing another attempt');
    }
  }
  const { routes, navigator, discovery } = captured;
  await fs.writeFile(navigationReportPath, JSON.stringify(discovery, null, 2), 'utf8');
  if (cfg.adaptiveDiscovery !== false) {
    await fs.writeFile(navigationMemoryPath, JSON.stringify(navigator.memory(), null, 2), 'utf8');
  }
  const endpoints = distinctEndpoints(routes);
  log(`discover: ${routes.length} requests, ${endpoints.length} distinct endpoints`);
  if (endpoints.length === 0) failures.push('no API endpoints captured — the flow may not have exercised any first-party APIs');
  if (discovery.stopReason) failures.push(`adaptive discovery stopped: ${discovery.stopReason}`);

  // ── 3. CLASSIFY ────────────────────────────────────────────────────────────
  const capabilityCandidates: CapabilityRouteCandidate[] = extractCapabilityRoutes(routes, cfg.plan);
  const enumerationCandidates: EnumerationCandidate[] = extractEnumerationCandidates(routes, cfg.plan);
  const reportPath = path.join(cfg.outDir, `${stem}-endpoints.json`);
  const endpointsJson = JSON.stringify({ target: cfg.targetName, plan: cfg.plan.id, endpoints, capabilityCandidates, enumerationCandidates, discovery }, null, 2);
  await fs.writeFile(reportPath, endpointsJson, 'utf8');
  log(`classify: ${capabilityCandidates.length} capability candidates, ${enumerationCandidates.length} enumeration candidates → ${reportPath}`);
  const enumerating = cfg.plan.surfaces.some((s) => s.controls?.some((c) => c.enumerate));
  if (enumerating && enumerationCandidates.length === 0) failures.push('no enumerated reference-data endpoints flagged — map them manually from the endpoints report');

  let captureScaffold: { relPath: string; content: string } | undefined;
  let captureScaffoldPath: string | undefined;
  if (cfg.profile?.captureScaffold) {
    const template = cfg.profile.captureScaffold.template
      ? await fs.readFile(path.join(requireRepo(cfg), cfg.profile.captureScaffold.template), 'utf8')
      : undefined;
    captureScaffold = {
      relPath: renderTemplate(cfg.profile.captureScaffold.path, nameTokens(cfg.targetName)),
      content: renderCaptureScaffold(cfg.targetName, enumerationCandidates, endpoints, template),
    };
    captureScaffoldPath = path.join(cfg.outDir, path.basename(captureScaffold.relPath));
    await fs.writeFile(captureScaffoldPath, captureScaffold.content, 'utf8');
    log(`classify: capture scaffold → ${captureScaffoldPath}`);
  }

  // ── 4. PR ──────────────────────────────────────────────────────────────────
  let pr: DiscoveryPrResult | undefined;
  if (cfg.preparePr && cfg.profile) {
    const docMarkdown = buildDiscoveryDoc({
      targetName: cfg.targetName,
      codebaseName: cfg.profile.name,
      plan: cfg.plan,
      startUrl: cfg.startUrl,
      endpoints,
      capabilityCandidates,
      enumerationCandidates,
      discovery,
      captureScaffold,
      registration: renderRegistration(cfg.profile, cfg.targetName),
      scaffoldPath: scaffoldRelPath(cfg.profile, cfg.targetName),
      failures,
      generatedAtIso: new Date().toISOString(),
    });
    pr = await prepareDiscoveryPr({
      targetName: cfg.targetName,
      profile: cfg.profile,
      docMarkdown,
      endpointsJson,
      captureScaffold,
      targetRepo: requireRepo(cfg),
      baseRef: cfg.prBaseRef ?? cfg.profile.baseRef,
      openPr: cfg.openPr ?? false,
      log,
    });
  }

  return {
    storageStatePath: cfg.storageStatePath,
    harPath,
    endpointCount: endpoints.length,
    capabilityCandidates: capabilityCandidates.length,
    enumerationCandidates: enumerationCandidates.length,
    reportPath,
    navigationReportPath,
    navigationMemoryPath,
    captureScaffoldPath,
    discovery,
    failures,
    pr,
  };
}

function requireRepo(cfg: OnboardConfig): string {
  if (!cfg.targetRepo) throw new Error('TARGET_REPO (or --repo) is required to read profile templates');
  return cfg.targetRepo;
}

async function readNavigationMemory(filePath: string, failures: string[]): Promise<NavigationMemory | undefined> {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as NavigationMemory;
  } catch {
    failures.push('navigation memory was unreadable; semantic discovery rebuilt it');
    return undefined;
  }
}

/**
 * The capture scaffold: with a profile template, the rendered template (tokens plus
 * {{endpointsComment}} and {{endpointsJson}}); without one, a generic TypeScript module
 * that records the candidate endpoints so the next agent run starts from facts.
 */
export function renderCaptureScaffold(
  targetName: string,
  enumerationCandidates: EnumerationCandidate[],
  endpoints: CapturedRoute[],
  template?: string,
): string {
  const tokens = nameTokens(targetName);
  const top = enumerationCandidates.slice(0, 5).map((c) => {
    const shape = c.responseShape ? `; JSON shape ${JSON.stringify(c.responseShape).slice(0, 500)}` : '';
    return `//   [${c.control}] ${c.method} ${c.url}  (score ${c.score}: ${c.reason}${shape})`;
  });
  const endpointsComment = top.length ? top.join('\n') : '//   (none flagged — inspect the endpoints report manually)';
  const endpointsJson = JSON.stringify(
    endpoints.slice(0, 40).map((e) => ({ method: e.method, url: e.url, status: e.status, observedDuring: e.observedDuring ?? [] })),
    null,
    2,
  );
  if (template) return renderTemplate(template, { ...tokens, endpointsComment, endpointsJson });
  return `// ${tokens.Pascal} capture — SCAFFOLD generated by integration-factory onboard.
// Candidate reference-data endpoints found in the capture (confirm which is authoritative):
${endpointsComment}
//
// TODO: define the capture JSON shape to match the real response, then map it onto this
// codebase's contract.

export const ${tokens.camel}CapturedEndpoints = ${endpointsJson} as const;

export interface ${tokens.Pascal}Capture {
  capturedAt: string;
  // TODO: reference-data shape
}
`;
}
