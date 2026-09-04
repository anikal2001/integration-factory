// Produces the discovery PR from onboard artifacts: a git worktree of the target repo on
// a fresh branch, the discovery doc + sanitized endpoints report (+ the capture scaffold
// when the profile defines one) written in, committed, and the PR prepared. Dry-run by
// default. The HAR is never written into the repo.

import { LocalSandboxFactory } from '../sandbox/local-sandbox.js';
import { nameTokens, type ResolvedProfile } from '../profile.js';
import { preparePr, type PrResult } from './target-repo-pr.js';

export interface DiscoveryPrInput {
  targetName: string;
  profile: ResolvedProfile;
  docMarkdown: string;
  endpointsJson: string;
  captureScaffold?: { relPath: string; content: string };
  targetRepo: string;
  baseRef: string;
  openPr: boolean;
  log?: (msg: string) => void;
}

export interface DiscoveryPrResult extends PrResult {
  worktreePath: string;
  files: string[];
}

export async function prepareDiscoveryPr(input: DiscoveryPrInput): Promise<DiscoveryPrResult> {
  const log = input.log ?? (() => {});
  const tokens = nameTokens(input.targetName);
  const branch = `${input.profile.branchPrefix}${tokens.kebab}-discovery`;
  const sandbox = await new LocalSandboxFactory().create({ repo: input.targetRepo, baseRef: input.baseRef, branch });
  log(`pr: worktree at ${sandbox.root} (base ${input.baseRef})`);

  const files = [
    `${input.profile.docsDir}/${tokens.kebab}.md`,
    `${input.profile.docsDir}/${tokens.kebab}-endpoints.json`,
  ];
  await sandbox.writeFile(files[0], input.docMarkdown);
  await sandbox.writeFile(files[1], input.endpointsJson);
  if (input.captureScaffold) {
    await sandbox.writeFile(input.captureScaffold.relPath, input.captureScaffold.content);
    files.push(input.captureScaffold.relPath);
  }
  log(`pr: wrote ${files.join(', ')}`);

  const pr = await preparePr({
    sandbox,
    branch,
    baseRef: input.baseRef,
    title: `docs(${tokens.kebab}): browser-discovered integration scaffold`,
    body:
      `Browser discovery for ${input.targetName} (integration-factory onboard). ` +
      `Docs + sanitized endpoints only — no HAR, no cookies, no secrets. See ${files[0]} for the capability candidates and the registration TODOs.`,
    openPr: input.openPr,
    verifyOk: true,
    log,
  });
  if (pr.opened) await sandbox.dispose();
  else log(`pr: worktree left at ${sandbox.root}`);
  return { ...pr, worktreePath: sandbox.root, files };
}
