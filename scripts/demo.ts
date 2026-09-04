// Offline demo: copy the sample target repo into a temp git repo, then run the full loop
// (sandbox → MockModel agent → verify → dry-run PR) against it. No API keys, no network.
//
//   npm run demo               # integrates "acme-pay" into the sample repo
//   npm run demo -- stripe-like

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { orchestrate } from '../src/orchestrate.js';
import { LocalSandboxFactory } from '../src/sandbox/local-sandbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = path.join(here, '..', 'examples', 'sample-target-repo');

export async function materializeSampleRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-factory-demo-'));
  const repo = path.join(root, 'acme-billing');
  await fs.cp(sample, repo, { recursive: true });
  const sandbox = await new LocalSandboxFactory().attach(repo);
  for (const cmd of [
    'git init -q -b main',
    'git config user.email demo@example.invalid',
    'git config user.name "integration-factory demo"',
    'git add -A',
    'git commit -q -m "sample target repo" --no-verify',
  ]) {
    const res = await sandbox.exec(cmd);
    if (res.code !== 0) throw new Error(`${cmd} failed: ${res.stderr}`);
  }
  return {
    repo,
    cleanup: async () => {
      await sandbox.exec('git worktree prune');
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function main(): Promise<void> {
  const name = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'acme-pay';
  const { repo, cleanup } = await materializeSampleRepo();
  try {
    const config = loadConfig({ ...process.env, OPEN_PR: 'false' });
    config.baseRef = 'main'; // the temp repo has no remote
    const result = await orchestrate({ integrationName: name, config, targetRepo: repo, log: (m) => process.stdout.write(`${m}\n`) });
    process.stdout.write(`\n■ demo done — verify ${result.verify.ok ? 'PASSED' : 'FAILED'}; scaffold on branch ${result.branch}\n`);
    process.stdout.write(`  inspect: ${result.sandboxRoot}\n  (temp repo: ${repo}; delete it whenever you like)\n`);
    if (!result.verify.ok) process.exitCode = 2;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
}
