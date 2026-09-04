// Playwright capture runner — the programmatic browser-automation path.
//
// It drives a real Chromium and records ALL network traffic (native HAR + a route
// summary of XHR/fetch/document requests with method, URL, status). This is what the
// integration agent uses to (a) capture a target's reference-data endpoints and (b)
// discover read-only account routes with adaptive UI navigation once a session
// exists. Human assistance remains the boundary for login challenges and mutating flows.
//
// AUTH BOUNDARY (important): this tool operates on an ALREADY-AUTHENTICATED session
// (a Playwright `storageState` a human produced by logging in once) or on public
// pages. It deliberately does NOT attempt to defeat login challenges, captcha, or
// bot-detection, and it does not create accounts. Produce the session once with:
//   npx playwright codegen <target-url> --save-storage=storageState.json
// (log in by hand, solving captcha + email verification), then reuse it here.

import type { Page } from 'playwright';
import type { BrowserHandle, BrowserProvider } from './browser-provider.js';

export type JsonShape = string | { [key: string]: JsonShape };

export interface CapturedRoute {
  method: string;
  url: string;
  status: number;
  resourceType: string;
  contentType?: string;
  /** Discovery phase active when the request fired. */
  phase?: string;
  /** Populated by distinctEndpoints when the same route appeared in several phases. */
  observedDuring?: string[];
  /** Keys/types only; values are never copied into the sanitized endpoint report. */
  requestShape?: JsonShape;
  responseShape?: JsonShape;
}

export interface CaptureResult {
  harPath: string;
  routes: CapturedRoute[];
}

export interface CaptureOptions {
  /** Where to start; must already be reachable with the given session. */
  startUrl: string;
  /** HAR output path (includes request/response bodies via content:'embed'). */
  harPath: string;
  /** Path to a Playwright storageState.json from a prior human login. */
  storageStatePath?: string;
  /** Restrict the route summary to URLs containing this host substring. */
  filterHost?: string;
  /** Where Chromium comes from — local or Browserbase. */
  provider: BrowserProvider;
  /**
   * The flow to exercise against the authenticated page (e.g. open the listing
   * form, walk the category picker). Defaults to a dwell so lazy XHRs fire.
   */
  flow?: (page: Page, initialResponseStatus?: number, browser?: Pick<BrowserHandle, 'cdpUrl'>) => Promise<void>;
  /** Correlates a request with the discovery phase currently being exercised. */
  routeContext?: () => string | undefined;
}

export async function captureFlow(opts: CaptureOptions): Promise<CaptureResult> {
  const handle = await opts.provider.connect();
  const { browser, dispose } = handle;
  const context = await browser.newContext({
    recordHar: { path: opts.harPath, content: 'embed' },
    ...(opts.storageStatePath ? { storageState: opts.storageStatePath } : {}),
  });

  const routes: CapturedRoute[] = [];
  const shapeTasks = new Set<Promise<void>>();
  const page = await context.newPage();
  page.on('response', (res) => {
    const req = res.request();
    const type = req.resourceType();
    if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
    const url = req.url();
    if (opts.filterHost) {
      try {
        const hostname = new URL(url).hostname.toLowerCase();
        const allowed = opts.filterHost.toLowerCase().replace(/^www\./, '');
        if (hostname !== allowed && !hostname.endsWith(`.${allowed}`)) return;
      } catch {
        return;
      }
    }
    const contentType = res.headers()['content-type'];
    const phase = opts.routeContext?.();
    const captured: CapturedRoute = {
      method: req.method(),
      url,
      status: res.status(),
      resourceType: type,
      ...(contentType ? { contentType } : {}),
      ...(phase ? { phase } : {}),
    };
    const requestData = req.postData();
    if (requestData && /json/i.test(req.headers()['content-type'] ?? '')) {
      try { captured.requestShape = jsonShape(JSON.parse(requestData)); } catch { /* not valid JSON */ }
    }
    routes.push(captured);

    if (/json/i.test(contentType ?? '')) {
      const contentLength = Number(res.headers()['content-length'] ?? 0);
      if (!contentLength || contentLength <= 2_000_000) {
        const task = res.body()
          .then((body) => {
            if (body.byteLength > 2_000_000) return;
            captured.responseShape = jsonShape(JSON.parse(body.toString('utf8')));
          })
          .catch(() => {});
        shapeTasks.add(task);
        void task.finally(() => shapeTasks.delete(task));
      }
    }
  });

  try {
    const initialResponse = await page.goto(opts.startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (opts.flow) {
      await opts.flow(page, initialResponse?.status(), { cdpUrl: handle.cdpUrl });
    } else {
      await page.waitForTimeout(3_000); // let lazy XHRs fire
    }
    await Promise.allSettled([...shapeTasks]);
  } finally {
    // Closing the context flushes the HAR to disk.
    await context.close();
    await dispose();
  }

  return { harPath: opts.harPath, routes };
}

/** Reduce JSON to a bounded keys/types description; no scalar value survives. */
export function jsonShape(value: unknown, depth = 0): JsonShape {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth >= 4) return 'array';
    return { array: value.length ? jsonShape(value[0], depth + 1) : 'unknown' };
  }
  if (typeof value !== 'object') return typeof value;
  if (depth >= 4) return 'object';
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
  return Object.fromEntries(entries.map(([key, child]) => [key, jsonShape(child, depth + 1)]));
}

/** Collapse a route list to distinct API endpoints (method + path template). */
export function distinctEndpoints(routes: CapturedRoute[]): CapturedRoute[] {
  const seen = new Map<string, CapturedRoute>();
  for (const r of routes) {
    if (r.resourceType === 'document') continue;
    let pathKey = r.url;
    try {
      const u = new URL(r.url);
      // Templatize numeric / long-id path segments so repeats collapse.
      const path = u.pathname
        .split('/')
        .map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{12,}$/i.test(s) ? '{id}' : s))
        .join('/');
      pathKey = `${u.host}${path}${sanitizedQuery(u.searchParams)}`;
    } catch {
      /* keep raw url */
    }
    const key = `${r.method} ${pathKey}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, {
        ...r,
        url: pathKey,
        ...(r.phase ? { observedDuring: [r.phase] } : {}),
      });
    } else if (r.phase && !existing.observedDuring?.includes(r.phase)) {
      existing.observedDuring = [...(existing.observedDuring ?? []), r.phase];
    }
    if (existing && !existing.requestShape && r.requestShape) existing.requestShape = r.requestShape;
    if (existing && !existing.responseShape && r.responseShape) existing.responseShape = r.responseShape;
  }
  return [...seen.values()];
}

function sanitizedQuery(params: URLSearchParams): string {
  if (!params.size) return '';
  const safeEnumKey = /^(?:status|state|type|tab|filter|view|scope|sort)$/i;
  const sensitiveKey = /token|secret|key|auth|session|signature|password|email|code/i;
  const entries = [...params.entries()].slice(0, 20).map(([key, value]) => {
    if (sensitiveKey.test(key)) return [key, '{redacted}'] as const;
    if (safeEnumKey.test(key) && /^[a-z][a-z0-9_-]{0,31}$/i.test(value)) return [key, value] as const;
    return [key, '{value}'] as const;
  });
  const rendered = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${value}`)
    .join('&');
  return rendered ? `?${rendered}` : '';
}
