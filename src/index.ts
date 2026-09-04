// CLI: build an integration scaffold into a target repo.
//
//   tsx src/index.ts <integration-name> [--repo <path>] [--profile <file>] [--open-pr]
//
// The target repo declares what an integration looks like in `integration-factory.json`
// (see examples/sample-target-repo). Without MODEL_API_KEY the offline MockModel runs;
// without OPEN_PR=true / --open-pr the PR is a dry run and the worktree is kept.

import { flag, hasFlag, loadConfig } from './config.js';
import { loadEnvFile, MODEL_KEYS } from './env-file.js';
import { orchestrate } from './orchestrate.js';

loadEnvFile('.env', MODEL_KEYS);

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name || name.startsWith('--')) {
    throw new Error('usage: tsx src/index.ts <integration-name> [--repo <path>] [--profile <file>] [--open-pr]');
  }
  const config = loadConfig();
  if (hasFlag('--open-pr')) config.openPr = true;
  const profile = flag('--profile');
  if (profile) config.profilePath = profile;

  const result = await orchestrate({
    integrationName: name,
    config,
    targetRepo: flag('--repo') ?? config.targetRepo,
    log: (m) => process.stdout.write(`${m}\n`),
  });
  process.stdout.write(`\n■ branch ${result.branch}${result.pr.url ? ` → ${result.pr.url}` : result.pr.dryRun ? ' (dry-run)' : ''}\n`);
  if (!result.verify.ok) process.exitCode = 2;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
