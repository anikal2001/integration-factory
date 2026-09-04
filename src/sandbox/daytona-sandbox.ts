// DaytonaSandbox — real cloud implementation against the Daytona API. Key-gated and
// marked EXPERIMENTAL: the shapes follow Daytona's documented sandbox API, but this
// has not been run against a live account here. Swap in E2B/Modal/Fly by writing
// another class against the same Sandbox interface — nothing else changes.
//
// Requires: DAYTONA_API_KEY (and optionally DAYTONA_API_URL, default api.daytona.io).

import type { ExecResult, Sandbox, SandboxFactory } from './sandbox.js';

interface DaytonaConfig {
  apiKey: string;
  apiUrl: string;
  image?: string;
}

async function api<T>(cfg: DaytonaConfig, method: string, pathName: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cfg.apiUrl}${pathName}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Daytona ${method} ${pathName} -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

class DaytonaSandbox implements Sandbox {
  readonly kind = 'daytona';
  constructor(
    readonly root: string,
    private readonly cfg: DaytonaConfig,
    private readonly sandboxId: string,
  ) {}

  async exec(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const out = await api<{ exitCode: number; result: string; stderr?: string }>(
      this.cfg,
      'POST',
      `/sandbox/${this.sandboxId}/toolbox/process/execute`,
      { command, cwd: this.root, timeout: Math.ceil((opts.timeoutMs ?? 120_000) / 1000) },
    );
    return { code: out.exitCode, stdout: out.result ?? '', stderr: out.stderr ?? '' };
  }

  async readFile(relPath: string): Promise<string> {
    const out = await api<{ content: string }>(
      this.cfg,
      'GET',
      `/sandbox/${this.sandboxId}/toolbox/files/download?path=${encodeURIComponent(`${this.root}/${relPath}`)}`,
    );
    return out.content;
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    await api(this.cfg, 'POST', `/sandbox/${this.sandboxId}/toolbox/files/upload`, {
      path: `${this.root}/${relPath}`,
      content,
    });
  }

  async listDir(relPath: string): Promise<string[]> {
    const out = await api<Array<{ name: string }>>(
      this.cfg,
      'GET',
      `/sandbox/${this.sandboxId}/toolbox/files?path=${encodeURIComponent(`${this.root}/${relPath}`)}`,
    );
    return out.map((e) => e.name);
  }

  async dispose(): Promise<void> {
    await api(this.cfg, 'DELETE', `/sandbox/${this.sandboxId}`).catch(() => undefined);
  }
}

export class DaytonaSandboxFactory implements SandboxFactory {
  constructor(private readonly cfg: DaytonaConfig) {}

  async create(input: { repo: string; baseRef: string; branch: string }): Promise<Sandbox> {
    const sandbox = await api<{ id: string }>(this.cfg, 'POST', '/sandbox', {
      image: this.cfg.image ?? 'daytonaio/ai-node:latest',
    });
    const root = '/workspace/repo';
    const clone = new DaytonaSandbox(root, this.cfg, sandbox.id);
    // Clone the repo and check out a fresh branch inside the sandbox.
    const steps = [
      `git clone --depth 50 ${input.repo} ${root}`,
      `git -C ${root} checkout -b ${input.branch} ${input.baseRef}`,
    ];
    for (const step of steps) {
      const res = await clone.exec(step, { timeoutMs: 300_000 });
      if (res.code !== 0) throw new Error(`Daytona setup failed: ${step}\n${res.stderr}`);
    }
    return clone;
  }
}
