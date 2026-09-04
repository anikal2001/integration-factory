// The deterministic bits that surround the model for the "scaffold an integration" task:
// render the profile's scaffold, run the verify command, build the playbook. The model
// only makes judgment calls; everything here is plain code so it is cheap, repeatable,
// and identical across providers.

import type { Sandbox } from '../sandbox/sandbox.js';
import { nameTokens, renderRegistration, renderScaffold, renderTemplate, scaffoldRelPath, type ResolvedProfile } from '../profile.js';

export interface ScaffoldPlan {
  integrationName: string;
  relPath: string;
  content: string;
  registration: string[];
}

/** What the deterministic path (and the MockModel) would write. */
export async function planScaffold(profile: ResolvedProfile, integrationName: string, sandbox: Pick<Sandbox, 'readFile'>): Promise<ScaffoldPlan> {
  return {
    integrationName,
    relPath: scaffoldRelPath(profile, integrationName),
    content: await renderScaffold(profile, integrationName, (rel) => sandbox.readFile(rel)),
    registration: renderRegistration(profile, integrationName),
  };
}

/** Render the playbook (built-in or profile override) with the profile's facts filled in. */
export function renderPlaybook(template: string, profile: ResolvedProfile, integrationName: string): string {
  const tokens = nameTokens(integrationName);
  const registration = renderRegistration(profile, integrationName);
  return renderTemplate(template, {
    ...tokens,
    codebase: profile.name,
    kind: profile.kind ?? 'third-party',
    contractFiles: profile.contractFiles.map((f) => `- \`${f}\``).join('\n') || '- (the profile lists no contract files — inspect the repo layout first)',
    scaffoldPath: scaffoldRelPath(profile, integrationName),
    registration: registration.map((s) => `- ${s}`).join('\n') || '- (none listed — look for a registry, enum, or factory map and record what you find as a TODO)',
    verify: profile.verify ?? '(none configured)',
  });
}

/** Verify the produced change. Configurable so real runs can use `npm run build`. */
export async function verify(sandbox: Sandbox, verifyCmd: string): Promise<{ ok: boolean; output: string }> {
  const res = await sandbox.exec(verifyCmd, { timeoutMs: 600_000 });
  return { ok: res.code === 0, output: `${res.stdout}\n${res.stderr}`.trim() };
}

/** The default verify when neither env nor profile sets one: prove a diff exists. */
export const DEFAULT_VERIFY_CMD = 'git add -A && git diff --cached --stat';
