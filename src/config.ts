// All environment wiring in one place. Every provider choice is config, never code:
// model gateway, sandbox backend, target repo, verify command, and whether to actually
// open a PR (default OFF — a fresh install must not spam anyone's repo).

export interface OrchestratorConfig {
  model: { baseUrl?: string; apiKey?: string; name: string };
  sandboxProvider: 'local' | 'daytona';
  daytona: { apiKey?: string; apiUrl: string };
  /** Local path (worktree) or git URL (cloud sandbox) of the codebase receiving the integration. */
  targetRepo?: string;
  /** Overrides the profile's baseRef when set. */
  baseRef?: string;
  /** Overrides the profile's verify command when set. */
  verifyCmd?: string;
  /** Explicit profile path; default is <targetRepo>/integration-factory.json. */
  profilePath?: string;
  openPr: boolean;
  maxSteps: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const provider = env.SANDBOX_PROVIDER ?? 'local';
  if (provider !== 'local' && provider !== 'daytona') {
    throw new Error(`SANDBOX_PROVIDER must be "local" or "daytona" (got "${provider}")`);
  }
  return {
    model: {
      baseUrl: env.MODEL_BASE_URL,
      apiKey: env.MODEL_API_KEY,
      name: env.MODEL_NAME ?? 'mock',
    },
    sandboxProvider: provider,
    daytona: { apiKey: env.DAYTONA_API_KEY, apiUrl: env.DAYTONA_API_URL ?? 'https://api.daytona.io' },
    targetRepo: env.TARGET_REPO,
    baseRef: env.BASE_REF,
    verifyCmd: env.VERIFY_CMD,
    profilePath: env.PROFILE,
    openPr: env.OPEN_PR === 'true',
    maxSteps: env.MAX_STEPS ? Number(env.MAX_STEPS) : 12,
  };
}

/** Tiny argv helper shared by the CLIs: `--flag value`. */
export function flag(name: string, argv: string[] = process.argv): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

export function hasFlag(name: string, argv: string[] = process.argv): boolean {
  return argv.includes(name);
}

export function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}
