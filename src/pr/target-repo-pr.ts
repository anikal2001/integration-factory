// Commit the sandbox's changes and prepare a PR against the target repo. Dry-run by
// default: it prints the exact commands and leaves the branch for a human. With
// openPr=true and a passing verify it pushes and opens the PR via the GitHub CLI.

import type { Sandbox } from '../sandbox/sandbox.js';

export interface PrInput {
  sandbox: Sandbox;
  branch: string;
  /** e.g. origin/main — the PR base is derived by stripping the remote prefix. */
  baseRef: string;
  title: string;
  body: string;
  openPr: boolean;
  verifyOk: boolean;
  log?: (msg: string) => void;
}

export interface PrResult {
  branch: string;
  base: string;
  committed: boolean;
  dryRun: boolean;
  opened: boolean;
  url?: string;
  error?: string;
}

export async function preparePr(input: PrInput): Promise<PrResult> {
  const log = input.log ?? (() => {});
  const { sandbox, branch } = input;
  const base = prBaseFromRef(input.baseRef);

  await sandbox.exec(`git add -A && git commit -q -m ${shellQuote(input.title)} --no-verify`);
  const committed = (await sandbox.exec('git log -1 --pretty=%s')).stdout.trim() === input.title;

  if (!input.openPr) {
    log('\n■ PR (dry-run). To open it:');
    log(`    git push -u origin ${branch}`);
    log(`    gh pr create --base ${base} --head ${branch} --title ${shellQuote(input.title)}`);
    return { branch, base, committed, dryRun: true, opened: false };
  }
  if (!input.verifyOk) {
    log('\n■ verify failed — NOT opening a PR. Fix and re-run.');
    return { branch, base, committed, dryRun: false, opened: false, error: 'verify failed' };
  }
  const push = await sandbox.exec(`git push -u origin ${branch}`);
  if (push.code !== 0) {
    log(`\n■ push failed:\n${push.stderr}`);
    return { branch, base, committed, dryRun: false, opened: false, error: push.stderr.trim() };
  }
  const pr = await sandbox.exec(`gh pr create --base ${base} --head ${branch} --title ${shellQuote(input.title)} --body ${shellQuote(input.body)}`);
  if (pr.code !== 0) {
    log(`\n■ gh pr create failed:\n${pr.stderr}`);
    return { branch, base, committed, dryRun: false, opened: false, error: pr.stderr.trim() };
  }
  const url = pr.stdout.trim();
  log(`\n■ opened ${url}`);
  return { branch, base, committed, dryRun: false, opened: true, url };
}

/**
 * `origin/main` → `main`; a local branch such as `integrations/foo` is left intact. Only
 * the conventional `origin` remote is stripped — anything else is ambiguous with a
 * slash-containing branch name.
 */
export function prBaseFromRef(baseRef: string): string {
  return baseRef.replace(/^origin\//, '');
}

/** Quote for both POSIX sh and Git Bash; double quotes with the dangerous characters escaped. */
export function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1').replace(/\r?\n/g, ' ')}"`;
}
