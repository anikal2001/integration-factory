// ImapVerificationProvider — reads the login/2FA code from a mailbox YOU control, over
// IMAP. This is what makes automated login fully hands-off: give it the mailbox's IMAP
// host + an APP PASSWORD (not the web password), and it polls for the verification email
// and extracts the code. For Gmail this means enabling IMAP + creating an app password
// for the mailbox that receives the codes. That app password is a different secret from
// the site login and must come from env, never from source.
//
// Optional dependency: `npm i imapflow`. Loaded dynamically so the rest of the
// orchestrator has no hard dep on it.

import type { VerificationProvider } from './login.js';

export interface ImapConfig {
  host: string; // e.g. imap.gmail.com
  port?: number; // 993
  user: string; // the mailbox address
  appPassword: string; // app-specific password, from env — never committed
  /** Only accept codes from emails whose From contains this (anti-spoof). */
  fromContains?: string;
  /** Regex that captures the code in group 1. Default: a 6-digit code. */
  codePattern?: RegExp;
  /** How long to poll for the email to arrive. */
  timeoutMs?: number;
}

export class ImapVerificationProvider implements VerificationProvider {
  constructor(private readonly cfg: ImapConfig) {}

  async getCode(): Promise<string> {
    const pattern = this.cfg.codePattern ?? /\b(\d{6})\b/;
    const deadline = Date.now() + (this.cfg.timeoutMs ?? 120_000);

    // Dynamic import so imapflow is only required when this provider is actually used.
    // Non-literal specifier keeps TS from statically resolving the optional dep.
    const spec = 'imapflow';
    const mod = (await import(spec).catch(() => {
      throw new Error('ImapVerificationProvider needs `npm i imapflow`');
    })) as any;
    const client = new mod.ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port ?? 993,
      secure: true,
      auth: { user: this.cfg.user, pass: this.cfg.appPassword },
      logger: false,
    });

    await client.connect();
    try {
      while (Date.now() < deadline) {
        const lock = await client.getMailboxLock('INBOX');
        try {
          // Newest first; scan the last handful of unseen messages.
          for await (const msg of client.fetch({ seen: false }, { envelope: true, source: true })) {
            const from = (msg.envelope?.from ?? []).map((a: any) => a.address).join(',');
            if (this.cfg.fromContains && !from.includes(this.cfg.fromContains)) continue;
            const body = msg.source?.toString('utf8') ?? '';
            const match = body.match(pattern);
            if (match) return match[1];
          }
        } finally {
          lock.release();
        }
        await new Promise((r) => setTimeout(r, 5_000));
      }
      throw new Error('verification code email did not arrive before timeout');
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}
