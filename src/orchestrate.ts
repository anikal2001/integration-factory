// The build loop, as a library function: provision a sandbox with the target repo checked
// out, run the scaffold playbook through a model-agnostic agent, verify, prepare a PR.
// `src/index.ts` is the CLI wrapper; tests and the demo call this directly.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent/loop.js';
import type { OrchestratorConfig } from './config.js';
import { MockModel } from './model/mock-model.js';
import type { ModelClient } from './model/model-client.js';
import { OpenAICompatibleModel } from './model/openai-compatible.js';
import { loadProfile, nameTokens, type ResolvedProfile } from './profile.js';
import { DaytonaSandboxFactory } from './sandbox/daytona-sandbox.js';
import { LocalSandboxFactory } from './sandbox/local-sandbox.js';
import type { Sandbox, SandboxFactory } from './sandbox/sandbox.js';
import { DEFAULT_VERIFY_CMD, planScaffold, renderPlaybook, verify } from './tasks/scaffold.js';
import { preparePr, type PrResult } from './pr/target-repo-pr.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface OrchestrateInput {
  integrationName: string;
  config: OrchestratorConfig;
  /** Overrides config.targetRepo. */
  targetRepo?: string;
  log?: (msg: string) => void;
  /** Test seam: inject a model instead of choosing from config. */
  model?: ModelClient;
  /** Test seam: inject a sandbox factory. */
  sandboxFactory?: SandboxFactory;
}

export interface OrchestrateResult {
  profile: ResolvedProfile;
  branch: string;
  sandboxRoot: string;
  agent: { finished: boolean; steps: number; summary: string };
  verify: { ok: boolean; output: string; command: string };
  pr: PrResult;
  /** True when the worktree was left on disk for inspection. */
  worktreeKept: boolean;
}

export async function orchestrate(input: OrchestrateInput): Promise<OrchestrateResult> {
  const log = input.log ?? (() => {});
  const { config } = input;
  const targetRepo = input.targetRepo ?? config.targetRepo;
  if (!targetRepo) throw new Error('TARGET_REPO (or --repo) is required: the codebase that receives the integration');

  const profile = await loadProfile(targetRepo, config.profilePath);
  const tokens = nameTokens(input.integrationName);
  const branch = `${profile.branchPrefix}${tokens.kebab}`;
  const baseRef = config.baseRef ?? profile.baseRef;
  const verifyCmd = config.verifyCmd ?? profile.verify ?? DEFAULT_VERIFY_CMD;

  const factory: SandboxFactory = input.sandboxFactory ?? (
    config.sandboxProvider === 'daytona'
      ? new DaytonaSandboxFactory({ apiKey: requireValue(config.daytona.apiKey, 'DAYTONA_API_KEY'), apiUrl: config.daytona.apiUrl })
      : new LocalSandboxFactory());

  log(`▶ integrating "${input.integrationName}" into ${profile.name}${profile.kind ? ` (${profile.kind})` : ''}`);
  const sandbox = await factory.create({ repo: targetRepo, baseRef, branch });
  log(`  sandbox=${sandbox.kind} root=${sandbox.root} base=${baseRef} openPr=${config.openPr}`);

  let keep = !config.openPr;
  try {
    const scaffold = await planScaffold(profile, input.integrationName, sandbox);
    const model: ModelClient = input.model ?? (
      config.model.apiKey && config.model.baseUrl
        ? new OpenAICompatibleModel(config.model.baseUrl, config.model.apiKey, config.model.name)
        : new MockModel(scaffold, profile.contractFiles));
    log(`  model=${model.name}`);

    const template = profile.playbook
      ? await sandbox.readFile(profile.playbook)
      : await readFile(path.join(here, 'playbooks', 'scaffold-integration.md'), 'utf8');
    const system = renderPlaybook(template, profile, input.integrationName);
    const task =
      `Integrate "${input.integrationName}" into ${profile.name} by scaffolding it at ${scaffold.relPath} following the playbook. ` +
      `Read the contract files before writing. Definition of done: the file exists, it satisfies the contract, and you have staged and reviewed the diff.`;

    const agent = await runAgent({ model, sandbox, system, task, maxSteps: config.maxSteps, log });
    log(`\n■ agent ${agent.finished ? 'finished' : 'stopped'} in ${agent.steps} step(s): ${agent.summary}`);

    const v = await verify(sandbox, verifyCmd);
    log(`\n■ verify (${verifyCmd}) → ${v.ok ? 'PASS' : 'FAIL'}`);
    if (v.output) log(v.output);

    const pr = await preparePr({
      sandbox,
      branch,
      baseRef,
      title: `feat(${tokens.kebab}): scaffold ${input.integrationName} integration`,
      body: `Scaffolded by integration-factory for ${profile.name}.${scaffold.registration.length ? `\n\nRegistration TODOs:\n${scaffold.registration.map((s) => `- ${s}`).join('\n')}` : ''}`,
      openPr: config.openPr,
      verifyOk: v.ok,
      log,
    });
    if (pr.opened) keep = false;

    return {
      profile,
      branch,
      sandboxRoot: sandbox.root,
      agent: { finished: agent.finished, steps: agent.steps, summary: agent.summary },
      verify: { ...v, command: verifyCmd },
      pr,
      worktreeKept: keep,
    };
  } finally {
    if (!keep) await disposeQuietly(sandbox, log);
    else log(`\n(worktree left at ${sandbox.root} for inspection — set OPEN_PR=true to push + open the PR and clean up)`);
  }
}

async function disposeQuietly(sandbox: Sandbox, log: (m: string) => void): Promise<void> {
  try {
    await sandbox.dispose();
  } catch (error) {
    log(`(sandbox dispose failed: ${error instanceof Error ? error.message : String(error)})`);
  }
}

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required for this provider`);
  return value;
}
