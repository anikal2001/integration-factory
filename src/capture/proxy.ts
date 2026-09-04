// Residential proxy config (e.g. superproxy), read from the same PROXY_* vars the
// backend uses. Used two ways: routed directly by local Playwright, or handed to
// Browserbase as an EXTERNAL proxy (their stealth browser + your residential IP,
// avoiding Browserbase's paid managed-proxy add-on).

export interface ProxyConfig {
  server: string; // e.g. http://host:port
  username?: string;
  password?: string;
}

/** Build a ProxyConfig from PROXY_HOST/PROXY_PORT/PROXY_USER/PROXY_PASS. */
export function proxyFromEnv(): ProxyConfig | undefined {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  if (!host || !port) return undefined;
  const scheme = /^\w+:\/\//.test(host) ? '' : 'http://';
  return {
    server: `${scheme}${host}:${port}`,
    username: process.env.PROXY_USER,
    password: process.env.PROXY_PASS,
  };
}
