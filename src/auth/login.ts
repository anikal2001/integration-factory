// Automated login → storageState. This is the "give it email + password and it gets
// the session on its own" piece. It fills credentials, handles an optional emailed
// verification code via a pluggable provider, waits for a logged-in signal, and saves
// the Playwright storageState for the capture/test automation to reuse.
//
// BOUNDARIES (honest):
//  - Credentials come from ENV at runtime (TARGET_EMAIL / TARGET_PASSWORD).
//    They are never written to disk, committed, or logged.
//  - This automates login to an account you control. It does NOT solve captcha and does
//    NOT defeat bot-detection — if the site challenges the login, a human step or a
//    visible human assistance (optionally via a permitted residential egress) is
//    required, and captcha-solving evasion is deliberately not built here.
//  - Full autonomy on the emailed code requires mailbox access (see VerificationProvider
//    + ImapVerificationProvider). That is a separate credential (an email app-password),
//    not the web password.

import type { Locator, Page } from 'playwright';
import type { BrowserProvider } from '../capture/browser-provider.js';

const AUTH_URL = /\/(?:login|log-in|signin|sign-in|auth)(?:\/|$|[?#])/i;

/** Per-target DOM contract. Selectors must be confirmed against the live page. */
export interface LoginRecipe {
  loginUrl: string;
  /** Confirmed selectors win; semantic discovery is the fallback for unknown/changed DOM. */
  emailSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  /** An element that exists only once logged in (e.g. an account menu). */
  successSelector?: string;
  /** Optional: the input shown when the site asks for an emailed/2FA code. */
  codeSelector?: string;
  codeSubmitSelector?: string;
}

/** Supplies a verification code when the site demands one. */
export interface VerificationProvider {
  /** Resolve the current login/2FA code (e.g. read it from the mailbox). */
  getCode(): Promise<string>;
}

export interface LoginInput {
  recipe: LoginRecipe;
  email?: string;
  password?: string;
  provider: BrowserProvider;
  storageStatePath: string;
  verification?: VerificationProvider;
  headed?: boolean;
  /** Human completes login in a visible browser (the free Cloudflare-passing path). */
  manualAssist?: boolean;
  log?: (msg: string) => void;
  /** Checkpoint 2: the site is asking for an emailed/2FA code. */
  onVerificationRequired?: () => void;
  /** Checkpoint 3: an anti-bot/captcha challenge blocked the login. */
  onChallenge?: (detail: string) => void;
}

export async function login(input: LoginInput): Promise<{ storageStatePath: string }> {
  const log = input.log ?? (() => {});
  const { browser, dispose } = await input.provider.connect();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    log(`opening ${input.recipe.loginUrl}`);
    const initialResponse = await page.goto(input.recipe.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (initialResponse?.status() === 429) throw new Error('login page is rate-limited; refusing to retry');
    if (initialResponse?.status() === 403 && !input.manualAssist) {
      input.onChallenge?.('login page returned HTTP 403');
      throw new Error('login page denied automated access; human assistance is required');
    }

    if (await challengeDetail(page)) {
      input.onChallenge?.(await challengeDetail(page) ?? 'browser challenge detected');
      if (!input.manualAssist) throw new Error('login blocked by an anti-bot challenge — human assistance is required');
    }

    // If the supplied URL is a public entry point, safely follow its login link.
    const authInitiallyVisible = !!(await findEmailInput(page, input.recipe.emailSelector)) ||
      !!(await findPasswordInput(page, input.recipe.passwordSelector)) || AUTH_URL.test(page.url());
    const loginEntryClicked = !authInitiallyVisible && await clickLoginEntry(page).catch(() => false);
    const authenticationObserved = authInitiallyVisible || loginEntryClicked;

    // ── Manual-assist (headed) path ──────────────────────────────────────────
    // A human at the visible browser completes login — solving any captcha, the
    // multi-step email→continue→password flow, and the email code themselves. This is
    // the free path that passes Cloudflare (headed + residential proxy). We best-effort
    // prefill the email to save a step, then wait long for the logged-in signal.
    if (input.manualAssist) {
      const emailInput = await findEmailInput(page, input.recipe.emailSelector);
      if (emailInput && input.email) await emailInput.fill(input.email).catch(() => {});
      log('Complete the login in the browser window (Continue → password/code, solve any captcha). Waiting up to 5 min…');
      let challengePinged = false;
      let completed = false;
      for (let elapsed = 0; elapsed < 300_000; elapsed += 1_000) {
        if (await loginComplete(page, input.recipe.successSelector, authenticationObserved)) {
          completed = true;
          break;
        }
        const detail = await challengeDetail(page);
        if (detail && !challengePinged) {
          challengePinged = true;
          input.onChallenge?.(detail);
        }
        await page.waitForTimeout(1_000);
      }
      if (!completed) throw new Error('manual login was not completed within 5 minutes; session was not saved');
      await page.waitForTimeout(2_000); // let post-login cookies settle
      log('login detected — saving session');
      await context.storageState({ path: input.storageStatePath });
      return { storageStatePath: input.storageStatePath };
    }

    // ── Automated path ───────────────────────────────────────────────────────
    if (!input.email || !input.password) {
      throw new Error('automated login requires TARGET_EMAIL and TARGET_PASSWORD');
    }

    // Every distinct stage is submitted at most once. If the same form reappears after
    // submission (bad credentials, validation error, throttling), stop instead of retrying.
    const submittedStages = new Set<string>();
    let verificationUsed = false;
    let submitted = false;
    for (let step = 0; step < 7; step += 1) {
      const challenge = await challengeDetail(page);
      if (challenge) {
        input.onChallenge?.(challenge);
        throw new Error('login blocked by an anti-bot challenge — human assistance is required');
      }
      if (await loginComplete(page, input.recipe.successSelector, submitted)) break;

      const codeInput = await findCodeInput(page, input.recipe.codeSelector);
      const emailInput = await findEmailInput(page, input.recipe.emailSelector);
      const passwordInput = await findPasswordInput(page, input.recipe.passwordSelector);
      const stage = `${new URL(page.url()).pathname}|email:${!!emailInput}|password:${!!passwordInput}|code:${!!codeInput}`;
      if (submittedStages.has(stage)) {
        throw new Error('login stage repeated after submission; refusing to retry credentials to protect the account');
      }

      if (codeInput) {
        input.onVerificationRequired?.();
        if (verificationUsed) throw new Error('verification stage repeated; refusing to request or submit another code');
        if (!input.verification) throw new Error('login requires a verification code but no VerificationProvider was configured');
        log('verification code required — fetching');
        const code = await input.verification.getCode();
        await codeInput.fill(code);
        verificationUsed = true;
      } else {
        if (emailInput) await emailInput.fill(input.email);
        if (passwordInput) await passwordInput.fill(input.password);
      }

      let action = await findAuthAction(page, input.recipe.submitSelector, !!codeInput);
      if (!action && !emailInput && !passwordInput && !codeInput) {
        if (await clickLoginEntry(page)) {
          await settle(page);
          continue;
        }
      }
      if (!action) {
        if (passwordInput || codeInput) {
          await page.keyboard.press('Enter');
        } else {
          throw new Error('could not find a safe login/continue control; use headed manual assistance');
        }
      } else {
        await action.click({ timeout: 5_000 });
      }
      submittedStages.add(stage);
      submitted = true;
      log(`submitted login stage ${submittedStages.size}`);
      await settle(page);
    }

    if (!(await loginComplete(page, input.recipe.successSelector, submitted))) {
      throw new Error('login did not reach an authenticated page within the conservative stage budget');
    }
    log('login confirmed — saving session');
    await context.storageState({ path: input.storageStatePath });
    return { storageStatePath: input.storageStatePath };
  } finally {
    await context.close();
    await dispose();
  }
}

async function findEmailInput(page: Page, preferred?: string): Promise<Locator | undefined> {
  return firstVisible(page, [
    preferred,
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
  ]);
}

async function findPasswordInput(page: Page, preferred?: string): Promise<Locator | undefined> {
  return firstVisible(page, [preferred, 'input[type="password"]', 'input[autocomplete="current-password"]']);
}

async function findCodeInput(page: Page, preferred?: string): Promise<Locator | undefined> {
  return firstVisible(page, [
    preferred,
    'input[autocomplete="one-time-code"]',
    'input[name*="code" i]',
    'input[inputmode="numeric"]',
  ]);
}

async function firstVisible(page: Page, selectors: Array<string | undefined>): Promise<Locator | undefined> {
  for (const selector of selectors) {
    if (!selector) continue;
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return undefined;
}

async function findAuthAction(page: Page, preferred?: string, verification = false): Promise<Locator | undefined> {
  const preferredLocator = preferred ? await firstVisible(page, [preferred]) : undefined;
  if (preferredLocator) return preferredLocator;
  const nodes = page.locator('button, input[type="submit"], [role="button"]');
  const count = Math.min(await nodes.count(), 80);
  const pattern = verification
    ? /verify|continue|next|submit|confirm/i
    : /continue|next|sign[ -]?in|log[ -]?in|login|submit/i;
  for (let index = 0; index < count; index += 1) {
    const locator = nodes.nth(index);
    if (!(await locator.isVisible().catch(() => false))) continue;
    const label = await locator.evaluate((element) => [
      element.textContent,
      element.getAttribute('aria-label'),
      element.getAttribute('value'),
      element.getAttribute('data-testid'),
    ].filter(Boolean).join(' ')).catch(() => '');
    if (pattern.test(label)) return locator;
  }
  return undefined;
}

async function clickLoginEntry(page: Page): Promise<boolean> {
  const nodes = page.locator('a[href], button, [role="link"], [role="button"]');
  const count = Math.min(await nodes.count(), 80);
  for (let index = 0; index < count; index += 1) {
    const locator = nodes.nth(index);
    if (!(await locator.isVisible().catch(() => false))) continue;
    const label = await locator.evaluate((element) => [
      element.textContent,
      element.getAttribute('aria-label'),
      element.getAttribute('href'),
      element.getAttribute('data-testid'),
    ].filter(Boolean).join(' ')).catch(() => '');
    if (!/(?:^|\b)(?:log[ -]?in|sign[ -]?in)(?:\b|$)/i.test(label)) continue;
    await locator.click({ timeout: 5_000 });
    await settle(page);
    return true;
  }
  return false;
}

async function loginComplete(page: Page, successSelector: string | undefined, submitted: boolean): Promise<boolean> {
  if (successSelector && await page.locator(successSelector).first().isVisible().catch(() => false)) return true;
  const accountSignal = page.locator(
    'a[href*="logout" i], button:has-text("Log out"), [data-authenticated="true"], [data-testid*="user-menu" i]',
  ).first();
  if (await accountSignal.isVisible().catch(() => false)) return true;
  if (!submitted) return false;
  if (await findEmailInput(page) || await findPasswordInput(page) || await findCodeInput(page)) return false;
  if (!AUTH_URL.test(page.url())) return true;
  return false;
}

async function challengeDetail(page: Page): Promise<string | undefined> {
  const title = await page.title().catch(() => '');
  const challengeElement = page.locator('[name="cf-turnstile-response"], iframe[src*="captcha" i], iframe[src*="challenge" i], [class*="captcha" i]').first();
  if (/just a moment|checking your browser|verify you are human|security challenge/i.test(title) || await challengeElement.isVisible().catch(() => false)) {
    return 'captcha / browser challenge detected';
  }
  return undefined;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/**
 * Waits for a human to paste the code — the safe default when no mailbox access is
 * configured. For true autonomy, implement VerificationProvider against IMAP/Gmail-API
 * on a mailbox YOU control (an app-password), polling for the sender + a code regex.
 */
export class ManualVerificationProvider implements VerificationProvider {
  async getCode(): Promise<string> {
    process.stdout.write('Enter the verification code from the email: ');
    return new Promise((resolve) => {
      process.stdin.once('data', (d) => resolve(d.toString().trim()));
    });
  }
}
