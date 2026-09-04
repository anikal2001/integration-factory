import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Locator, Page, Response } from 'playwright';

/** A discovery phase id from the active plan (a surface or control id, or 'accountMenu'). */
export type VisualGoal = string;

export interface VisualAdviceRequest {
  goal: VisualGoal;
  targetDescription: string;
  predictedPostcondition: string;
}

export interface VisualAdviceResult {
  attempted: boolean;
  acted: boolean;
  verified: boolean;
  navigated: boolean;
  lossOfGrounding: boolean;
  detail: string;
}

export interface VisualNavigationAdviser {
  adviseAndAct(page: Page, request: VisualAdviceRequest): Promise<VisualAdviceResult>;
}

export interface VisualClickProposal {
  status: 'proposed' | 'blocked';
  label?: string;
  role?: 'button' | 'link';
  href?: string;
  context?: string;
  predictedPostcondition?: string;
  reason: string;
}

interface AdviserInput extends VisualAdviceRequest {
  cdpUrl: string;
  currentUrl: string;
  allowedDomains: string[];
  model: string;
}

export type VisualProposalProvider = (input: AdviserInput) => Promise<VisualClickProposal>;

export interface BrowserUseVisualAdviserOptions {
  cdpUrl: string;
  apiKey: string;
  allowedHostSuffix: string;
  model?: string;
  projectDir?: string;
  timeoutMs?: number;
  /** Test seam; production uses the Python Browser Use sidecar. */
  proposalProvider?: VisualProposalProvider;
}

interface ResolvedCandidate {
  locator: Locator;
  label: string;
  href?: string;
}

const DANGEROUS_LABEL = /publish|post listing|submit listing|list now|save(?: changes| draft)?|update listing|delete|remove listing|buy|purchase|checkout|pay|ship now|mark as shipped|send offer|accept offer|decline offer|confirm|cancel order|payout|withdraw/i;
const SENSITIVE_PAGE = /password|passcode|two-factor|2fa|mfa|verification code|security code|payment|billing|payout|bank account|identity|government id|tax information/i;
const ADVICE_PREFIX = 'INTEGRATION_FACTORY_VISUAL_ADVICE=';

/**
 * Browser Use supplies visual grounding only. It proposes one exact visible control;
 * Playwright independently resolves, safety-checks, clicks, and verifies that proposal.
 */
export class BrowserUseVisualAdviser implements VisualNavigationAdviser {
  private readonly model: string;
  private readonly projectDir: string;
  private readonly timeoutMs: number;
  private readonly proposalProvider: VisualProposalProvider;
  private disabledReason?: string;

  constructor(private readonly options: BrowserUseVisualAdviserOptions) {
    this.model = options.model ?? 'bu-2-0';
    this.projectDir = options.projectDir ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.proposalProvider = options.proposalProvider ?? ((input) => this.runSidecar(input));
  }

  async adviseAndAct(page: Page, request: VisualAdviceRequest): Promise<VisualAdviceResult> {
    if (this.disabledReason) {
      return result(false, false, false, false, false, `visual adviser disabled after provider failure: ${this.disabledReason}`);
    }
    if (!(await this.isSafeOrdinaryPage(page))) {
      return result(false, false, false, false, false, 'visual adviser disabled on an authentication or sensitive page');
    }
    if (!this.isAllowedUrl(page.url())) {
      return result(false, false, false, false, true, 'current page is outside the target domain allowlist');
    }

    let proposal: VisualClickProposal;
    try {
      proposal = await this.proposalProvider({
        ...request,
        cdpUrl: this.options.cdpUrl,
        currentUrl: page.url(),
        allowedDomains: [this.options.allowedHostSuffix, `*.${this.options.allowedHostSuffix}`],
        model: this.model,
      });
    } catch (error) {
      const detail = errorMessage(error);
      if (isProviderFailure(detail)) this.disabledReason = detail;
      return result(true, false, false, false, false, `Browser Use provider failed: ${detail}`);
    }
    if (proposal.status !== 'proposed' || !proposal.label) {
      const reason = sanitizeDetail(proposal.reason);
      if (isProviderFailure(reason)) this.disabledReason = reason;
      return result(true, false, false, false, false, `Browser Use declined: ${reason}`);
    }

    const candidate = await this.resolveProposal(page, proposal);
    if (!candidate) {
      return result(true, false, false, false, false, 'Browser Use proposal did not resolve to one exact, safe, fully visible control');
    }

    const beforeUrl = page.url();
    const beforeScroll = await page.evaluate(() => window.scrollY).catch(() => 0);
    const beforeFingerprint = await visibleFingerprint(page);
    const beforeScreenshot = await screenshotHash(page);
    const pagesBefore = new Set(page.context().pages());
    const responses: string[] = [];
    const onResponse = (response: Response): void => {
      if (this.isAllowedUrl(response.url())) responses.push(response.url());
    };
    page.on('response', onResponse);

    try {
      await candidate.locator.click({ timeout: 5_000 });
      await settle(page);

      for (const opened of page.context().pages()) {
        if (!pagesBefore.has(opened)) await opened.close().catch(() => {});
      }

      if (!this.isAllowedUrl(page.url())) {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
        return result(true, true, false, true, true, 'visual proposal left the target domain allowlist and was reverted');
      }

      const afterScroll = await page.evaluate(() => window.scrollY).catch(() => beforeScroll);
      if (Math.abs(afterScroll - beforeScroll) >= 80) {
        await page.evaluate((target) => window.scrollTo({ top: target, behavior: 'instant' }), beforeScroll).catch(() => {});
        return result(true, true, false, page.url() !== beforeUrl, true, 'visual proposal caused unexpected scrolling; scroll was reverted');
      }

      const changed = page.url() !== beforeUrl
        || responses.length > 0
        || await visibleFingerprint(page) !== beforeFingerprint
        || await screenshotHash(page) !== beforeScreenshot;
      return result(
        true,
        true,
        changed,
        page.url() !== beforeUrl,
        false,
        changed
          ? `Browser Use proposed “${sanitizeDetail(candidate.label)}”; Playwright verified a postcondition`
          : `Browser Use proposed “${sanitizeDetail(candidate.label)}”; no postcondition was observed`,
      );
    } catch (error) {
      return result(true, true, false, page.url() !== beforeUrl, false, `safe visual click failed: ${errorMessage(error)}`);
    } finally {
      page.off('response', onResponse);
    }
  }

  private async resolveProposal(page: Page, proposal: VisualClickProposal): Promise<ResolvedCandidate | undefined> {
    const requested = normalizeLabel(proposal.label ?? '');
    if (!requested || requested.length > 160 || DANGEROUS_LABEL.test(requested)) return undefined;

    const nodes = page.locator('a[href], button, [role="link"], [role="button"]');
    const count = Math.min(await nodes.count(), 220);
    const matches: ResolvedCandidate[] = [];
    for (let index = 0; index < count; index += 1) {
      const locator = nodes.nth(index);
      if (!(await locator.isVisible().catch(() => false))) continue;
      const meta = await locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute('role') ?? (tag === 'a' ? 'link' : tag === 'button' ? 'button' : '');
        return {
          values: [
            element.getAttribute('aria-label'),
            element instanceof HTMLElement ? element.innerText : element.textContent,
            element.getAttribute('title'),
          ].filter(Boolean).map((value) => String(value).replace(/\s+/g, ' ').trim()),
          role,
          href: element.getAttribute('href') ?? undefined,
          type: element instanceof HTMLButtonElement ? element.type : element.getAttribute('type'),
          disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
          inViewport: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight
            && rect.left >= 0 && rect.right <= window.innerWidth,
        };
      }).catch(() => undefined);
      if (!meta || meta.disabled || !meta.inViewport || meta.type?.toLowerCase() === 'submit') continue;
      if (proposal.role && meta.role !== proposal.role) continue;
      if (!meta.values.some((value) => normalizeLabel(value) === requested)) continue;
      if (meta.values.some((value) => DANGEROUS_LABEL.test(value))) continue;
      if (meta.href && !this.isAllowedUrl(new URL(meta.href, page.url()).toString())) continue;
      if (proposal.href) {
        const proposedHref = safeComparableHref(proposal.href, page.url());
        const actualHref = meta.href ? safeComparableHref(meta.href, page.url()) : undefined;
        if (!proposedHref || proposedHref !== actualHref) continue;
      }
      matches.push({ locator, label: meta.values[0] ?? proposal.label ?? '', href: meta.href });
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  private async isSafeOrdinaryPage(page: Page): Promise<boolean> {
    if (/\/(?:login|signin|sign-in|auth|checkout|payment|payout|identity|security)(?:\/|$|[?#])/i.test(page.url())) return false;
    const password = await page.locator('input[type="password"], input[autocomplete="one-time-code"]').first().isVisible().catch(() => false);
    if (password) return false;
    const headings = await page.locator('h1, [role="heading"], [role="dialog"]').allInnerTexts().catch(() => []);
    return !SENSITIVE_PAGE.test(headings.join(' ').slice(0, 3_000));
  }

  private isAllowedUrl(value: string): boolean {
    try {
      const url = new URL(value);
      const allowed = this.options.allowedHostSuffix.toLowerCase().replace(/^www\./, '');
      const host = url.hostname.toLowerCase();
      return (url.protocol === 'http:' || url.protocol === 'https:')
        && (host === allowed || host.endsWith(`.${allowed}`));
    } catch {
      return false;
    }
  }

  private runSidecar(input: AdviserInput): Promise<VisualClickProposal> {
    return new Promise((resolve, reject) => {
      const script = path.join(this.projectDir, 'scripts', 'browser-use-adviser.py');
      const child = spawn('uv', ['run', '--project', this.projectDir, 'python', script], {
        cwd: this.projectDir,
        windowsHide: true,
        env: {
          ...process.env,
          BROWSER_USE_API_KEY: this.options.apiKey,
          ANONYMIZED_TELEMETRY: 'false',
          BROWSER_USE_LOGGING_LEVEL: 'warning',
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Browser Use visual proposal timed out'));
      }, this.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk.toString('utf8')); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk.toString('utf8')); });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        const line = stdout.split(/\r?\n/).reverse().find((entry: string) => entry.startsWith(ADVICE_PREFIX));
        if (code !== 0 || !line) {
          reject(new Error(`Browser Use adviser failed${code === null ? '' : ` (${code})`}: ${sanitizeDetail(stderr.slice(-500))}`));
          return;
        }
        try {
          resolve(JSON.parse(line.slice(ADVICE_PREFIX.length)) as VisualClickProposal);
        } catch {
          reject(new Error('Browser Use adviser returned invalid JSON'));
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
}

function result(
  attempted: boolean,
  acted: boolean,
  verified: boolean,
  navigated: boolean,
  lossOfGrounding: boolean,
  detail: string,
): VisualAdviceResult {
  return { attempted, acted, verified, navigated, lossOfGrounding, detail };
}

async function visibleFingerprint(page: Page): Promise<string> {
  return page.locator('h1, [role="heading"][aria-level="1"], a[href], button, [role="link"], [role="button"], [role="menu"], [role="dialog"]').evaluateAll((elements) => elements
    .slice(0, 220)
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    })
    .map((element) => [
      element.getAttribute('aria-label'),
      element instanceof HTMLElement ? element.innerText : element.textContent,
      element.getAttribute('href'),
      element.getAttribute('role'),
      element.getAttribute('aria-expanded'),
    ].filter(Boolean).join('|').replace(/\s+/g, ' ').trim().slice(0, 240))
    .join('\n')).catch(() => '');
}

async function screenshotHash(page: Page): Promise<string> {
  const bytes = await page.screenshot({ type: 'png', animations: 'disabled' }).catch(() => undefined);
  return bytes ? createHash('sha256').update(bytes).digest('hex') : '';
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {});
  await page.waitForTimeout(350);
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function safeComparableHref(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base);
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

function sanitizeDetail(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w.-]+/g, '<email>')
    .replace(/(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{12,}/gi, '<secret>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function errorMessage(error: unknown): string {
  return sanitizeDetail(error instanceof Error ? error.message : String(error));
}

function boundedAppend(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= 256_000 ? combined : combined.slice(-256_000);
}

function isProviderFailure(value: string): boolean {
  return /free tier|upgrade your subscription|invalid api|unauthorized|forbidden|insufficient (?:credit|quota)|rate limit|model .*not (?:allowed|available)/i.test(value);
}
