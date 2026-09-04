// The deterministic bits that surround the model for the "scaffold an integration" task:
// render the profile's scaffold files, run the verify command, build the playbook. The
// model only makes judgment calls; everything here is plain code so it is cheap,
// repeatable, and identical across providers.

import type { Sandbox } from '../sandbox/sandbox.js';
import {
  nameTokens,
  renderRegistration,
  renderScaffolds,
  renderTemplate,
  scaffoldRelPaths,
  type RenderedScaffold,
  type ResolvedProfile,
} from '../profile.js';

export interface ScaffoldPlan {
  integrationName: string;
  files: RenderedScaffold[];
  registration: string[];
}

/** What the deterministic path (and the MockModel) would write. */
export async function planScaffold(profile: ResolvedProfile, integrationName: string, sandbox: Pick<Sandbox, 'readFile'>): Promise<ScaffoldPlan> {
  return {
    integrationName,
    files: await renderScaffolds(profile, integrationName, (rel) => sandbox.readFile(rel)),
    registration: renderRegistration(profile, integrationName),
  };
}

/** Render the playbook (built-in or profile override) with the profile's facts filled in. */
export function renderPlaybook(template: string, profile: ResolvedProfile, integrationName: string): string {
  const tokens = nameTokens(integrationName);
  const registration = renderRegistration(profile, integrationName);
  const bullets = (items: string[], empty: string): string => (items.length ? items.map((i) => `- ${i}`).join('\n') : `- ${empty}`);
  const paths = scaffoldRelPaths(profile, integrationName);
  return renderTemplate(template, {
    ...tokens,
    codebase: profile.name,
    kind: profile.kind ?? 'third-party',
    contractFiles: bullets(profile.contractFiles.map((f) => `\`${f}\``), '(the profile lists no contract files — inspect the repo layout first)'),
    referenceFiles: bullets(profile.referenceFiles.map((f) => `\`${f}\``), '(none listed — use `list_dir` next to the contract files to find one)'),
    scaffoldPath: paths[0],
    scaffoldFiles: bullets(paths.map((p) => `\`${p}\``), '(the profile lists no scaffold paths)'),
    registration: bullets(registration, '(none listed — look for a registry, enum, or factory map and record what you find as a TODO)'),
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
