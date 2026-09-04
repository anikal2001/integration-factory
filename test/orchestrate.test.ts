import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { orchestrate } from '../src/orchestrate.js';
import { LocalSandboxFactory } from '../src/sandbox/local-sandbox.js';
import { materializeSampleRepo } from '../scripts/demo.js';

test('the offline loop scaffolds, registers TODOs, verifies, and prepares a dry-run PR', async (t) => {
  const { repo, cleanup } = await materializeSampleRepo();
  t.after(cleanup);

  const log: string[] = [];
  const config = loadConfig({ SANDBOX_PROVIDER: 'local', OPEN_PR: 'false', MAX_STEPS: '8' });
  config.baseRef = 'main';
  const result = await orchestrate({ integrationName: 'Acme Pay', config, targetRepo: repo, log: (m) => log.push(m) });
  t.after(async () => {
    const source = await new LocalSandboxFactory().attach(repo);
    await source.exec(`git worktree remove "${result.sandboxRoot}" --force`);
  });

  assert.equal(result.branch, 'integrations/acme-pay');
  assert.equal(result.agent.finished, true);
  assert.equal(result.verify.command, 'node scripts/check-providers.mjs');
  assert.equal(result.verify.ok, true, result.verify.output);
  assert.equal(result.pr.dryRun, true);
  assert.equal(result.pr.committed, true);
  assert.equal(result.worktreeKept, true);

  const scaffold = path.join(result.sandboxRoot, 'src/payments/providers/AcmePayProvider.js');
  assert.ok(existsSync(scaffold), 'scaffold file written in the worktree');
  const content = await fs.readFile(scaffold, 'utf8');
  assert.match(content, /export class AcmePayProvider extends BaseProvider/);
  assert.match(content, /name = 'acme-pay'/);
  assert.match(content, /Add 'acme-pay' to PROVIDER_IDS/);
  assert.match(result.agent.summary, /Registration TODOs/);
  assert.ok(log.some((line) => line.includes('verify (node scripts/check-providers.mjs) → PASS')));
  assert.ok(!existsSync(path.join(repo, 'src/payments/providers/AcmePayProvider.js')), 'source checkout untouched');
});

test('a profile is required and the error says where to put it', async () => {
  const { repo, cleanup } = await materializeSampleRepo();
  try {
    await fs.rm(path.join(repo, 'integration-factory.json'));
    const config = loadConfig({ OPEN_PR: 'false' });
    config.baseRef = 'main';
    await assert.rejects(orchestrate({ integrationName: 'x', config, targetRepo: repo }), /integration-factory\.json/);
  } finally {
    await cleanup();
  }
});
