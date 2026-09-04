// Provider-agnostic sandbox abstraction. The orchestrator only ever talks to this
// interface, so the execution backend (local worktree, Daytona, E2B, Modal, …) is a
// config swap and never a code change. That is the whole point: not locked to any one
// sandbox vendor, the same way we are not locked to any one model.

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  /** Human label for logs, e.g. "local" or "daytona". */
  readonly kind: string;
  /** Absolute working directory of the checked-out repo inside the sandbox. */
  readonly root: string;
  /** Run a shell command in `root`. Never throws on non-zero exit — inspect `.code`. */
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /** Read a repo-relative file as UTF-8. */
  readFile(relPath: string): Promise<string>;
  /** Write a repo-relative file (creates parent dirs). */
  writeFile(relPath: string, content: string): Promise<void>;
  /** List entries of a repo-relative directory. */
  listDir(relPath: string): Promise<string[]>;
  /** Tear down the sandbox / worktree. Best-effort. */
  dispose(): Promise<void>;
}

export interface SandboxCreateInput {
  /** Local path (worktree providers) or git URL (cloud providers). */
  repo: string;
  baseRef: string;
  branch: string;
  /**
   * Local-only hint: share the source checkout's node_modules with the sandbox instead
   * of installing. Cloud providers ignore it and rely on the profile's `setup` command.
   */
  linkNodeModules?: boolean;
}

export interface SandboxFactory {
  /**
   * Provision a sandbox with `repo` checked out on a fresh `branch`.
   * Local implementations may use a git worktree of a path; cloud implementations
   * clone the URL.
   */
  create(input: SandboxCreateInput): Promise<Sandbox>;
}
