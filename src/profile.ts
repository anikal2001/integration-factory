// An IntegrationProfile tells the orchestrator what "an integration" looks like inside a
// particular codebase: which contract files define it, where the new module(s) go, how it
// is registered, and how the change is verified. It lives in the TARGET repo as
// `integration-factory.json`, so the orchestrator itself stays generic — a marketplace
// adapter, a payment provider, a shipping carrier, a CRM connector, or an SSO plugin are
// all just different profiles.

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

export const PROFILE_FILENAME = 'integration-factory.json';

export interface ScaffoldSpec {
  /** Repo-relative output path. Supports name tokens (see `renderTemplate`). */
  path: string;
  /** Repo-relative template file. Optional — without it a generic stub is generated. */
  template?: string;
}

export interface CaptureScaffoldSpec {
  /** Repo-relative output path for the scaffold emitted from browser discovery. */
  path: string;
  /** Repo-relative template. Extra tokens: {{endpointsComment}}, {{endpointsJson}}. */
  template?: string;
}

export interface IntegrationProfile {
  /** Human name of the codebase, used in logs and PR text. */
  name: string;
  /** Free-form kind of integration this codebase takes: marketplace, payments, shipping, crm, sso… */
  kind?: string;
  /** Repo-relative files the agent must read before writing anything. */
  contractFiles: string[];
  /** Existing integrations the agent should imitate (read-only examples). */
  referenceFiles?: string[];
  /** One file or several — an integration is often an adapter + client + types. */
  scaffold: ScaffoldSpec | ScaffoldSpec[];
  /** Registration steps recorded as TODOs (or performed when trivially safe). Name tokens allowed. */
  registration?: string[];
  /** Command run once in the fresh sandbox before the agent starts, e.g. "npm ci". Must exit 0. */
  setup?: string;
  /** Command that must exit 0 before a PR is opened, e.g. "npm run build". */
  verify?: string;
  /** Repo-relative markdown playbook overriding the built-in one. Same tokens as templates. */
  playbook?: string;
  /** Where discovery docs are written. Default: docs/integrations */
  docsDir?: string;
  /** Branch prefix for generated branches. Default: integrations/ */
  branchPrefix?: string;
  /** Default git base ref. Default: origin/main */
  baseRef?: string;
  /** Default discovery plan: a built-in id or a repo-relative JSON file. Default: marketplace-seller */
  discoveryPlan?: string;
  captureScaffold?: CaptureScaffoldSpec;
}

export interface ResolvedProfile {
  name: string;
  kind?: string;
  contractFiles: string[];
  referenceFiles: string[];
  scaffolds: ScaffoldSpec[];
  registration: string[];
  setup?: string;
  verify?: string;
  playbook?: string;
  docsDir: string;
  branchPrefix: string;
  baseRef: string;
  discoveryPlan: string;
  captureScaffold?: CaptureScaffoldSpec;
  /** Absolute path of the file the profile was loaded from. */
  sourcePath: string;
}

export function resolveProfile(raw: unknown, sourcePath: string): ResolvedProfile {
  if (!raw || typeof raw !== 'object') throw new Error(`${sourcePath}: profile must be a JSON object`);
  const profile = raw as IntegrationProfile;
  if (!profile.name || typeof profile.name !== 'string') throw new Error(`${sourcePath}: "name" is required`);
  if (!Array.isArray(profile.contractFiles) || profile.contractFiles.some((f) => typeof f !== 'string')) {
    throw new Error(`${sourcePath}: "contractFiles" must be an array of repo-relative paths`);
  }
  if (profile.referenceFiles !== undefined && (!Array.isArray(profile.referenceFiles) || profile.referenceFiles.some((f) => typeof f !== 'string'))) {
    throw new Error(`${sourcePath}: "referenceFiles" must be an array of repo-relative paths`);
  }
  const scaffolds = Array.isArray(profile.scaffold) ? profile.scaffold : profile.scaffold ? [profile.scaffold] : [];
  if (scaffolds.length === 0 || scaffolds.some((s) => !s || typeof s.path !== 'string')) {
    throw new Error(`${sourcePath}: "scaffold" must be one object or an array of objects, each with a "path"`);
  }
  for (const [key, value] of Object.entries({ docsDir: profile.docsDir, branchPrefix: profile.branchPrefix, baseRef: profile.baseRef, setup: profile.setup, verify: profile.verify, playbook: profile.playbook, discoveryPlan: profile.discoveryPlan })) {
    if (value !== undefined && typeof value !== 'string') throw new Error(`${sourcePath}: "${key}" must be a string`);
  }
  for (const rel of [
    ...profile.contractFiles,
    ...(profile.referenceFiles ?? []),
    ...scaffolds.flatMap((s) => [s.path, s.template]),
    profile.playbook,
    profile.captureScaffold?.path,
    profile.captureScaffold?.template,
  ]) {
    if (rel !== undefined) assertRepoRelative(rel, sourcePath);
  }
  return {
    name: profile.name,
    kind: profile.kind,
    contractFiles: profile.contractFiles,
    referenceFiles: profile.referenceFiles ?? [],
    scaffolds,
    registration: profile.registration ?? [],
    setup: profile.setup,
    verify: profile.verify,
    playbook: profile.playbook,
    docsDir: profile.docsDir ?? 'docs/integrations',
    branchPrefix: profile.branchPrefix ?? 'integrations/',
    baseRef: profile.baseRef ?? 'origin/main',
    discoveryPlan: profile.discoveryPlan ?? 'marketplace-seller',
    captureScaffold: profile.captureScaffold,
    sourcePath,
  };
}

/** Load `<repo>/integration-factory.json`, or an explicit profile path. */
export async function loadProfile(repoPath: string, explicitPath?: string): Promise<ResolvedProfile> {
  const file = explicitPath ? path.resolve(explicitPath) : path.join(path.resolve(repoPath), PROFILE_FILENAME);
  if (!existsSync(file)) {
    throw new Error(
      `no integration profile at ${file}. Add ${PROFILE_FILENAME} to the target repo (see examples/sample-target-repo) or pass --profile <path>.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return resolveProfile(raw, file);
}

function assertRepoRelative(rel: string, sourcePath: string): void {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    throw new Error(`${sourcePath}: "${rel}" must be a repo-relative path without ".."`);
  }
}

// ── Name tokens ─────────────────────────────────────────────────────────────────

export interface NameTokens extends Record<string, string> {
  name: string;
  Pascal: string;
  camel: string;
  kebab: string;
  CONSTANT: string;
}

export function nameTokens(name: string): NameTokens {
  const words = name.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error(`"${name}" contains no usable characters for an integration name`);
  const Pascal = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return {
    name,
    Pascal,
    camel: Pascal.charAt(0).toLowerCase() + Pascal.slice(1),
    kebab: words.map((w) => w.toLowerCase()).join('-'),
    CONSTANT: words.map((w) => w.toUpperCase()).join('_'),
  };
}

/** Replace `{{token}}` placeholders. Unknown tokens are left untouched so code braces survive. */
export function renderTemplate(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : match,
  );
}

/** Every output path the profile produces for this integration, in profile order. */
export function scaffoldRelPaths(profile: ResolvedProfile, integrationName: string): string[] {
  const tokens = nameTokens(integrationName);
  return profile.scaffolds.map((s) => renderTemplate(s.path, tokens));
}

/** The primary (first) output path — used in PR titles and log lines. */
export function scaffoldRelPath(profile: ResolvedProfile, integrationName: string): string {
  return scaffoldRelPaths(profile, integrationName)[0];
}

export function renderRegistration(profile: ResolvedProfile, integrationName: string): string[] {
  const tokens = nameTokens(integrationName);
  return profile.registration.map((step) => renderTemplate(step, tokens));
}

export interface RenderedScaffold {
  relPath: string;
  content: string;
}

/**
 * The scaffold content the deterministic path writes. With a template file it is the
 * rendered template; without one it is a minimal stub whose header carries the contract
 * and registration TODOs so a reviewer (or the next agent run) knows what is missing.
 */
export async function renderScaffolds(
  profile: ResolvedProfile,
  integrationName: string,
  readRepoFile: (rel: string) => Promise<string>,
): Promise<RenderedScaffold[]> {
  const tokens = nameTokens(integrationName);
  const registration = renderRegistration(profile, integrationName);
  const rendered: RenderedScaffold[] = [];
  for (const spec of profile.scaffolds) {
    const relPath = renderTemplate(spec.path, tokens);
    if (spec.template) {
      rendered.push({ relPath, content: renderTemplate(await readRepoFile(spec.template), tokens) });
      continue;
    }
    rendered.push({
      relPath,
      content: [
        `// ${tokens.Pascal} integration — SCAFFOLD generated by integration-factory (${path.posix.basename(relPath)}).`,
        `// Contract: ${profile.contractFiles.join(', ') || '(none listed in the profile)'}`,
        ...(registration.length ? ['// Registration TODOs:', ...registration.map((s) => `//   - ${s}`)] : []),
        '',
        `export class ${tokens.Pascal}Integration {`,
        `  readonly name = '${tokens.kebab}';`,
        '  // TODO: implement the methods required by the contract files above.',
        '}',
        '',
      ].join('\n'),
    });
  }
  return rendered;
}

/** Single-file convenience over `renderScaffolds`. */
export async function renderScaffold(profile: ResolvedProfile, integrationName: string, readRepoFile: (rel: string) => Promise<string>): Promise<string> {
  return (await renderScaffolds(profile, integrationName, readRepoFile))[0].content;
}
