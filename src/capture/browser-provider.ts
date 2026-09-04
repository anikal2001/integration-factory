// Browser source, behind an interface — same pattern as model + sandbox. The capture
// runner does not care whether Chromium is local or in the cloud; swap by config.
//
// - LocalBrowserProvider: launches Chromium on this machine (needs `npx playwright
//   install chromium`). Good for dev.
// - BrowserbaseProvider: connects to cloud Chromium over CDP. Gives residential
//   proxies (avoids datacenter-IP flagging on legitimate authenticated sessions) and
//   managed sessions. Same Playwright API downstream.
//
// Neither is for defeating signup/captcha/bot-detection — capture runs on an
// already-authenticated session or public pages only.

import { chromium, type Browser } from 'playwright';
import net from 'node:net';
import type { ProxyConfig } from './proxy.js';

export interface BrowserHandle {
  browser: Browser;
  /** Existing Chrome DevTools endpoint used by the read-only visual adviser. */
  cdpUrl?: string;
  dispose: () => Promise<void>;
}

export interface BrowserProvider {
  readonly kind: string;
  connect(): Promise<BrowserHandle>;
}

export class LocalBrowserProvider implements BrowserProvider {
  readonly kind = 'local';
  constructor(
    private readonly headed: boolean,
    private readonly proxy?: ProxyConfig,
    private readonly exposeCdp = false,
  ) {}
  async connect(): Promise<BrowserHandle> {
    if (this.proxy) process.stdout.write(`  local browser via proxy ${this.proxy.server}\n`);
    const debugPort = this.exposeCdp ? await availableLoopbackPort() : undefined;
    const browser = await chromium.launch({
      headless: !this.headed,
      ...(debugPort ? { args: [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'] } : {}),
      ...(this.proxy
        ? { proxy: { server: this.proxy.server, username: this.proxy.username, password: this.proxy.password } }
        : {}),
    });
    return {
      browser,
      ...(debugPort ? { cdpUrl: `http://127.0.0.1:${debugPort}` } : {}),
      dispose: async () => void (await browser.close()),
    };
  }
}

export class BrowserbaseProvider implements BrowserProvider {
  readonly kind = 'browserbase';
  constructor(
    private readonly apiKey: string,
    private readonly projectId: string,
    // Prefer an EXTERNAL residential proxy (e.g. superproxy) — Browserbase stealth +
    // your IP, no paid managed-proxy add-on. Falls back to managed proxies only if
    // BROWSERBASE_PROXIES=true and no external proxy is given (that needs a paid plan).
    private readonly externalProxy?: ProxyConfig,
    private readonly useManagedProxies = (process.env.BROWSERBASE_PROXIES ?? 'false') !== 'false',
  ) {}

  async connect(): Promise<BrowserHandle> {
    const proxies = this.externalProxy
      ? [{ type: 'external', server: this.externalProxy.server, username: this.externalProxy.username, password: this.externalProxy.password }]
      : this.useManagedProxies
        ? true
        : undefined;
    if (this.externalProxy) process.stdout.write(`  browserbase via external proxy ${this.externalProxy.server}\n`);
    const res = await fetch('https://api.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: { 'X-BB-API-Key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: this.projectId, ...(proxies !== undefined ? { proxies } : {}) }),
    });
    if (!res.ok) {
      throw new Error(`browserbase session create failed: ${res.status} ${await res.text()}`);
    }
    const session = (await res.json()) as { id: string; connectUrl: string };
    // Surface where to watch it — the #1 "I can't find my session" fix.
    process.stdout.write(
      `  browserbase session ${session.id}\n  live view: https://www.browserbase.com/sessions/${session.id}\n`,
    );
    const browser = await chromium.connectOverCDP(session.connectUrl);
    return { browser, cdpUrl: session.connectUrl, dispose: async () => void (await browser.close()) };
  }
}

async function availableLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('could not reserve a local Chrome debugging port'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
