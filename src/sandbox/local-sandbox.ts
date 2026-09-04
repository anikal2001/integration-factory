// LocalSandbox — runs the loop in a git worktree of a local repo, via child_process.
// This makes the whole orchestrator runnable with zero cloud credentials, so the
// end-to-end loop (sandbox → agent → tools → verify → PR prep) is demonstrable now.
// The cloud implementations (DaytonaSandbox, etc.) satisfy the same interface.

import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ExecResult, Sandbox, SandboxCreateInput, SandboxFactory } from './sandbox.js';

function run(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
  });
}

class LocalSandbox implements Sandbox {
  readonly kind = 'local';
  constructor(
    readonly root: string,
    private readonly sourceRepo: string,
    private readonly branch: string,
  ) {}

  async exec(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    return run(command, this.root, opts.timeoutMs ?? 120_000);
  }

  async readFile(relPath: string): Promise<string> {
    return fs.readFile(path.join(this.root, relPath), 'utf8');
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(this.root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  async listDir(relPath: string): Promise<string[]> {
    return fs.readdir(path.join(this.root, relPath));
  }

  async dispose(): Promise<void> {
    // A linked node_modules is a junction/symlink: unlink it first so `worktree remove`
    // never descends into the source repo's dependencies.
    await fs.unlink(path.join(this.root, 'node_modules')).catch(() => {});
    // Remove the worktree without touching the source repo's branches/commits.
    await run(`git worktree remove "${this.root}" --force`, this.sourceRepo, 30_000);
  }
}

export class LocalSandboxFactory implements SandboxFactory {
  /**
   * Bind a Sandbox to an existing directory without creating a worktree. Used by the
   * demo/tests to run git commands in a repo they own; `dispose()` is a no-op.
   */
  async attach(root: string): Promise<Sandbox> {
    const abs = path.resolve(root);
    const sandbox = new LocalSandbox(abs, abs, '');
    sandbox.dispose = async () => {};
    return sandbox;
  }

  async create(input: SandboxCreateInput): Promise<Sandbox> {
    const sourceRepo = path.resolve(input.repo);
    const wt = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-factory-'));
    const worktreePath = path.join(wt, 'repo');
    const res = await run(
      `git worktree add -b "${input.branch}" "${worktreePath}" "${input.baseRef}"`,
      sourceRepo,
      60_000,
    );
    if (res.code !== 0) {
      throw new Error(`git worktree add failed: ${res.stderr || res.stdout}`);
    }
    if (input.linkNodeModules) await linkNodeModules(sourceRepo, worktreePath);
    return new LocalSandbox(worktreePath, sourceRepo, input.branch);
  }
}

/**
 * Share the source checkout's installed dependencies with the worktree instead of
 * re-installing them: a directory junction on Windows, a symlink elsewhere. Only for
 * local iteration — CI and cloud sandboxes should run the profile's `setup` command.
 */
async function linkNodeModules(sourceRepo: string, worktreePath: string): Promise<void> {
  const source = path.join(sourceRepo, 'node_modules');
  const target = path.join(worktreePath, 'node_modules');
  if (!existsSync(source) || existsSync(target)) return;
  if (process.platform === 'win32') {
    const res = await run(`cmd /c mklink /J "${target}" "${source}"`, worktreePath, 30_000);
    if (res.code !== 0) throw new Error(`could not junction node_modules: ${res.stderr || res.stdout}`);
    return;
  }
  await fs.symlink(source, target, 'dir');
}
