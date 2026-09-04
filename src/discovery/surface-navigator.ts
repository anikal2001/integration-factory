// SurfaceNavigator — plan-driven, read-only exploration of an authenticated web UI.
//
// Given a DiscoveryPlan it reaches each declared surface (a page or drawer such as an
// editor, settings, orders, a dashboard), exercises the declared controls on it (a
// category picker, a preferences tab, a filter), and correlates first-party network
// traffic with the phase that caused it. Everything marketplace-specific lives in the
// plan; this file only knows how to find controls by semantic label, click one thing at
// a time, verify a postcondition, and stop when grounding is lost.
//
// Safety guarantees that no plan can weaken:
//  - Never clicks a control whose label looks like publish/save/delete/pay/ship/offer.
//  - Never submits a form, never types into inputs, never leaves the allowed host.
//  - One action at a time with a delay, bounded interaction/navigation budgets.
//  - Stops on 401/403/429, captcha or browser challenges, login walls, unexpected
//    scrolling (loss of grounding), or budget exhaustion. Stops are terminal.

import type { Locator, Page, Response } from 'playwright';
import type { ControlSpec, DiscoveryPlan, SurfaceSpec, VisualTask } from './plan.js';
import type { VisualNavigationAdviser } from './visual-adviser.js';

export interface NavigationMemory {
  version: 1;
  origin: string;
  updatedAt: string;
  /** Stable, query-free routes that worked on a prior run, keyed by surface id. */
  routes: Record<string, string>;
}

export interface DiscoveryEvent {
  phase: string;
  action: 'navigate' | 'interact' | 'dismiss' | 'fallback' | 'stop';
  strategy:
    | 'current-page'
    | 'semantic'
    | 'enumeration-branch'
    | 'account-menu'
    | 'visual-adviser'
    | 'remembered-route'
    | 'restore'
    | 'overlay'
    | 'safety';
  url: string;
  outcome: 'succeeded' | 'failed' | 'blocked';
  detail?: string;
}

export interface BranchCoverage {
  control: string;
  selector: string;
  value: string;
  label: string;
  status: 'covered' | 'blocked';
  detail?: string;
}

export interface EnumerationCoverage {
  discovered: number;
  attempted: number;
  covered: number;
  blocked: number;
  branches: BranchCoverage[];
}

export interface DiscoveryReport {
  startedAt: string;
  finishedAt?: string;
  phasesReached: string[];
  events: DiscoveryEvent[];
  interactions: number;
  navigations: number;
  enumerationCoverage: EnumerationCoverage;
  stopReason?: 'authentication-required' | 'challenge' | 'rate-limited' | 'budget-exhausted' | 'loss-of-grounding';
  humanInterventionRequired: boolean;
}

export interface SurfaceNavigatorOptions {
  plan: DiscoveryPlan;
  startUrl: string;
  /** Target host suffix, including API/account subdomains when they share it. */
  allowedHostSuffix: string;
  memory?: NavigationMemory;
  maxInteractions?: number;
  maxNavigations?: number;
  /** A deliberate floor between actions. This is a safety throttle, not bot evasion. */
  actionDelayMs?: number;
  /** Optional one-action visual fallback. Playwright still validates and executes. */
  visualAdviser?: VisualNavigationAdviser;
  log?: (message: string) => void;
}

export function passiveDiscoveryReport(): DiscoveryReport {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    finishedAt: now,
    phasesReached: ['bootstrap'],
    events: [],
    interactions: 0,
    navigations: 0,
    enumerationCoverage: { discovered: 0, attempted: 0, covered: 0, blocked: 0, branches: [] },
    humanInterventionRequired: false,
  };
}

interface Candidate {
  locator: Locator;
  text: string;
  href?: string;
  tag: string;
  type?: string;
  score: number;
  inHeaderRegion: boolean;
  stableSelector?: string;
}

interface ObservedLink {
  label: string;
  href: string;
}

interface CompiledSurface {
  spec: SurfaceSpec;
  path?: RegExp;
  heading?: RegExp;
  menuLabel?: RegExp;
  unfinishedOverlay?: RegExp;
  controls: ControlSpec[];
  /** Whether arrival can be recognised from URL/heading alone (and therefore remembered). */
  recognisable: boolean;
}

const DISMISS_CONTROL = /^(?:close|dismiss|skip|not now|maybe later|no thanks|got it|reject all|only necessary|continue without)$/i;
const ONBOARDING_OVERLAY = /welcome|getting started|onboarding|walkthrough|tour|tips|notification|download.*app|cookie|privacy choices|complete your profile|before you start|how it works/i;
const DANGEROUS_ACTION = /publish|post listing|submit listing|list now|save changes|update listing|delete|remove listing|buy|purchase|checkout|pay|ship now|mark as shipped|send offer|accept offer|decline offer|confirm order|cancel order/i;
const CHALLENGE_TEXT = /captcha|verify you are human|checking your browser|just a moment|unusual traffic|security challenge/i;
const AUTH_URL = /\/(?:login|log-in|signin|sign-in|auth)(?:\/|$|[?#])/i;
const DYNAMIC_PATH_SEGMENT = /^(?:\d{5,}|[0-9a-f]{12,}|[A-Za-z0-9_-]{24,})$/;
const NOT_FOUND = /\b404\b|page not found|could not be found|does(?:n['’]t| not) exist/i;
const ENUMERATION_CONTAINER = '[role="listbox"]:visible, [role="tree"]:visible, [role="menu"]:visible';
const ENUMERATION_OPTION = '[role="option"], [role="treeitem"], [role="menuitemradio"], button[type="button"]';

export class SurfaceNavigator {
  private readonly plan: DiscoveryPlan;
  private readonly surfaces: CompiledSurface[];
  private readonly distraction?: RegExp;
  private readonly accountMenuHints: string[];
  private readonly maxInteractions: number;
  private readonly maxNavigations: number;
  private readonly actionDelayMs: number;
  private readonly log: (message: string) => void;
  private readonly origin: string;
  private readonly reportState: DiscoveryReport;
  private phase = 'bootstrap';
  private blockedByResponse?: DiscoveryReport['stopReason'];
  private readonly memoryState: NavigationMemory;
  private visualAdviser?: VisualNavigationAdviser;
  private readonly visualAttempts = new Set<string>();
  private accountMenuLinks: ObservedLink[] = [];

  constructor(private readonly options: SurfaceNavigatorOptions) {
    this.plan = options.plan;
    this.surfaces = options.plan.surfaces.map((spec) => ({
      spec,
      path: compile(spec.pathPattern),
      heading: compile(spec.headingPattern),
      menuLabel: compile(spec.menuLabelPattern),
      unfinishedOverlay: compile(spec.unfinishedOverlayPattern),
      controls: spec.controls ?? [],
      recognisable: !!(spec.pathPattern || spec.headingPattern),
    }));
    this.distraction = compile(options.plan.distractionPattern);
    this.accountMenuHints = options.plan.accountMenuHints ?? [];
    // Branch-complete enumeration legitimately uses several reversible interactions per
    // selector (open, choose, backtrack, reopen). Keep a bounded default large enough
    // that coverage cannot starve later surfaces.
    this.maxInteractions = options.maxInteractions ?? 36;
    this.maxNavigations = options.maxNavigations ?? 10;
    this.actionDelayMs = options.actionDelayMs ?? 600;
    this.log = options.log ?? (() => {});
    this.origin = new URL(options.startUrl).origin;
    this.visualAdviser = options.visualAdviser;
    this.memoryState = options.memory?.version === 1 && options.memory.origin === this.origin
      ? { ...options.memory, routes: { ...options.memory.routes } }
      : { version: 1, origin: this.origin, updatedAt: new Date().toISOString(), routes: {} };
    this.reportState = {
      startedAt: new Date().toISOString(),
      phasesReached: ['bootstrap'],
      events: [],
      interactions: 0,
      navigations: 0,
      enumerationCoverage: { discovered: 0, attempted: 0, covered: 0, blocked: 0, branches: [] },
      humanInterventionRequired: false,
    };
  }

  get currentPhase(): string {
    return this.phase;
  }

  setVisualAdviser(adviser: VisualNavigationAdviser | undefined): void {
    this.visualAdviser = adviser;
  }

  report(): DiscoveryReport {
    return structuredClone(this.reportState);
  }

  memory(): NavigationMemory {
    return { ...this.memoryState, routes: { ...this.memoryState.routes } };
  }

  async run(page: Page, initialResponseStatus?: number): Promise<void> {
    if (initialResponseStatus === 429) this.blockedByResponse = 'rate-limited';
    if (initialResponseStatus === 401) this.blockedByResponse = 'authentication-required';
    if (initialResponseStatus === 403) this.blockedByResponse = 'challenge';
    const onResponse = (response: Response): void => {
      if (!this.isAllowedUrl(response.url())) return;
      const status = response.status();
      if (status === 429) this.blockedByResponse = 'rate-limited';
      if (status === 401 || status === 403) {
        this.blockedByResponse = status === 401 ? 'authentication-required' : 'challenge';
      }
    };
    page.on('response', onResponse);

    try {
      await this.settle(page);
      await this.dismissObstructions(page);
      if (!(await this.safetyCheck(page))) return;

      for (const surface of this.surfaces) {
        if (this.stopped()) return;
        const reached = await this.ensureSurface(page, surface);
        if (this.stopped()) return;
        if (reached) {
          for (const control of surface.controls) {
            await this.exerciseControl(page, surface, control);
            if (this.stopped()) return;
          }
        }
        if (!(await this.safetyCheck(page))) return;
        if (surface.spec.unfinishedOverlayPattern || surface.spec.entryVariants?.length) {
          await this.resetAfterSurface(page, surface);
          if (this.stopped()) return;
        }
      }
    } finally {
      page.off('response', onResponse);
      this.reportState.finishedAt = new Date().toISOString();
      this.memoryState.updatedAt = this.reportState.finishedAt;
    }
  }

  private setPhase(phase: string): void {
    this.phase = phase;
    if (!this.reportState.phasesReached.includes(phase)) this.reportState.phasesReached.push(phase);
  }

  private async ensureSurface(page: Page, surface: CompiledSurface): Promise<boolean> {
    if (this.stopped()) return false;
    const id = surface.spec.id;
    this.setPhase(id);
    await this.dismissObstructions(page);
    if (!(await this.safetyCheck(page))) return false;

    if (surface.recognisable && await this.matchesSurface(page, surface)) {
      this.rememberSurface(surface, page.url());
      this.record(page, 'navigate', 'current-page', 'succeeded');
      return true;
    }

    const remembered = this.memoryState.routes[id];
    if (remembered) {
      const returnUrl = page.url();
      if (await this.tryDirectRoute(page, surface, remembered)) return true;
      if (!(await this.safetyCheck(page))) return false;
      await this.restorePage(page, returnUrl);
      if (this.stopped()) return false;
    }

    // Account destinations are normally exposed from the profile/account button. Open
    // that UI and rescore its visible links; do not guess undocumented URL paths.
    let returnUrl = page.url();
    if (surface.spec.viaAccountMenu) {
      const beforeMenu = await this.accountMenuEvidence(page);
      const beforeLinks = await this.visibleSafeLinks(page);
      let menuOpened = await this.openAccountMenu(page);
      if (!menuOpened && await this.tryVisualAction(page, 'accountMenu', this.plan.accountMenuVisual, false)) {
        menuOpened = await this.accountMenuEvidence(page) !== beforeMenu;
        if (menuOpened) this.captureNewMenuLinks(beforeLinks, await this.visibleSafeLinks(page));
        if (!menuOpened) this.record(page, 'fallback', 'visual-adviser', 'failed', 'visual proposal did not reveal account menu controls');
      }
      if (this.stopped()) return false;
      let selected = menuOpened ? await this.followObservedMenuLink(page, surface) : false;
      if (menuOpened && !selected) selected = await this.tryVisualAction(page, id, surface.spec.visual, false);
      if (this.stopped()) return false;
      if (selected && await this.matchesSurface(page, surface, true)) {
        this.rememberSurface(surface, page.url());
        return true;
      }
      if (page.url() !== returnUrl) await this.restorePage(page, returnUrl);
      if (this.stopped()) return false;
    }

    // Primary entry controls often open a drawer without changing URL or heading. For
    // account-menu surfaces this is the fallback when a target has no profile menu.
    returnUrl = page.url();
    let selected = await this.clickSemantic(page, { surface }, true);
    if (!selected) selected = await this.tryVisualAction(page, id, surface.spec.visual, false);
    if (this.stopped()) return false;
    if (selected) {
      if (surface.spec.entryVariants?.length) await this.enterVariantIfOffered(page, surface);
      if (await this.matchesSurface(page, surface, true)) {
        this.rememberSurface(surface, page.url());
        return true;
      }
      this.record(page, 'fallback', 'semantic', 'failed', `entry did not reach a verified ${id} surface`);
      if (page.url() !== returnUrl) await this.restorePage(page, returnUrl);
      return false;
    }
    return false;
  }

  private async exerciseControl(page: Page, surface: CompiledSurface, control: ControlSpec): Promise<boolean> {
    if (this.stopped()) return false;
    this.setPhase(control.id);
    await this.dismissObstructions(page);
    if (!(await this.safetyCheck(page))) return false;
    if (control.enumerate && await this.enumerateNativeSelects(page, control)) return true;
    const opener = control.enumerate ? (await this.candidates(page, { surface, control }, false))[0] : undefined;
    let clicked = await this.clickSemantic(page, { surface, control }, false);
    if (clicked && control.enumerate) await this.enumerateCustomBranches(page, surface, control, opener);
    if (!clicked) clicked = await this.tryVisualAction(page, control.id, control.visual, true);
    if (!clicked) this.record(page, 'fallback', 'semantic', 'failed', `no safe ${control.id} control found`);
    return clicked;
  }

  private async clickSemantic(
    page: Page,
    goal: { surface: CompiledSurface; control?: ControlSpec },
    navigationOnly: boolean,
  ): Promise<boolean> {
    if (this.stopped()) return false;
    const goalId = goal.control?.id ?? goal.surface.spec.id;
    const candidates = await this.candidates(page, goal, navigationOnly);
    const candidate = candidates[0];
    if (!candidate || !(await this.safetyCheck(page)) || this.budgetExhausted(page)) return false;
    await this.throttle(page);
    const beforeUrl = page.url();
    const beforeState = await this.visibleStateFingerprint(page);
    const beforeScroll = await this.scrollPosition(page);
    const observedResponses: string[] = [];
    const onResponse = (response: Response): void => {
      if (this.isAllowedUrl(response.url())) observedResponses.push(response.url());
    };
    page.on('response', onResponse);
    try {
      await candidate.locator.click({ timeout: 5_000 });
      this.reportState.interactions += 1;
      await this.settle(page);
      if (page.url() !== beforeUrl) this.reportState.navigations += 1;
      const afterState = await this.visibleStateFingerprint(page);
      const changed = page.url() !== beforeUrl || afterState !== beforeState || observedResponses.length > 0;
      if (!changed) {
        await this.guardUnexpectedScroll(page, beforeScroll, `click on ${candidate.text.slice(0, 80)} produced no verified change`);
        this.record(page, navigationOnly ? 'navigate' : 'interact', 'semantic', 'failed', `${candidateDetail(goalId, candidate)}; no verified postcondition`);
        return false;
      }
      this.record(
        page,
        navigationOnly ? 'navigate' : 'interact',
        'semantic',
        'succeeded',
        `${candidateDetail(goalId, candidate)}; verified ${page.url() !== beforeUrl ? 'URL change' : observedResponses.length ? 'network response' : 'visible UI change'}`,
      );
      return true;
    } catch {
      this.reportState.interactions += 1;
      await this.guardUnexpectedScroll(page, beforeScroll, `failed click on ${candidate.text.slice(0, 80)}`);
      this.record(page, navigationOnly ? 'navigate' : 'interact', 'semantic', 'failed', candidateDetail(goalId, candidate));
      return false;
    } finally {
      page.off('response', onResponse);
    }
  }

  private async tryVisualAction(page: Page, goal: string, task: VisualTask | undefined, isControl: boolean): Promise<boolean> {
    if (this.stopped() || !task) return false;
    const attemptKey = `${this.phase}:${goal}`;
    if (!this.visualAdviser || this.visualAttempts.has(attemptKey) || this.budgetExhausted(page)) return false;
    if (!(await this.safetyCheck(page))) return false;
    this.visualAttempts.add(attemptKey);
    await this.throttle(page);
    try {
      const advice = await this.visualAdviser.adviseAndAct(page, { goal, ...task });
      if (advice.acted) this.reportState.interactions += 1;
      if (advice.navigated) this.reportState.navigations += 1;
      this.record(
        page,
        advice.acted ? (isControl ? 'interact' : 'navigate') : 'fallback',
        'visual-adviser',
        advice.verified ? 'succeeded' : advice.lossOfGrounding ? 'blocked' : 'failed',
        advice.detail,
      );
      if (advice.lossOfGrounding) {
        this.stop(page, 'loss-of-grounding', advice.detail);
        return false;
      }
      return advice.verified;
    } catch (error) {
      this.record(page, 'fallback', 'visual-adviser', 'failed', `visual adviser unavailable: ${safeError(error)}`);
      return false;
    }
  }

  private async openAccountMenu(page: Page): Promise<boolean> {
    if (this.stopped() || !this.accountMenuHints.length) return false;
    const candidates = await this.candidatesForHints(page, this.accountMenuHints, false);
    // Account controls belong in the current header/viewport. Never let Playwright
    // auto-scroll to a footer/profile lookalike and mistake that movement for progress.
    const candidate = candidates.find((item) => item.inHeaderRegion && item.tag !== 'a' && item.type !== 'submit');
    if (!candidate || this.budgetExhausted(page)) return false;
    await this.throttle(page);
    const beforeEvidence = await this.accountMenuEvidence(page);
    const beforeLinks = await this.visibleSafeLinks(page);
    const beforeExpanded = await candidate.locator.getAttribute('aria-expanded').catch(() => null);
    const beforeScroll = await this.scrollPosition(page);
    try {
      await candidate.locator.click({ timeout: 4_000 });
      this.reportState.interactions += 1;
      await this.settle(page);
      const afterExpanded = await candidate.locator.getAttribute('aria-expanded').catch(() => null);
      const afterEvidence = await this.accountMenuEvidence(page);
      const afterLinks = await this.visibleSafeLinks(page);
      const opened = (beforeExpanded !== 'true' && afterExpanded === 'true') || afterEvidence !== beforeEvidence;
      if (!opened) {
        await this.guardUnexpectedScroll(page, beforeScroll, 'account control did not reveal a verified account menu');
        this.record(page, 'interact', 'account-menu', 'failed', 'account control produced no verified menu state');
        return false;
      }
      this.captureNewMenuLinks(beforeLinks, afterLinks);
      this.record(page, 'interact', 'account-menu', 'succeeded', 'verified newly visible account menu controls');
      return true;
    } catch {
      this.reportState.interactions += 1;
      await this.guardUnexpectedScroll(page, beforeScroll, 'account control click failed');
      this.record(page, 'interact', 'account-menu', 'failed');
      return false;
    }
  }

  private async candidates(
    page: Page,
    goal: { surface: CompiledSurface; control?: ControlSpec },
    navigationOnly: boolean,
  ): Promise<Candidate[]> {
    const hints = goal.control?.hints ?? goal.surface.spec.hints;
    const candidates = await this.candidatesForHints(page, hints, navigationOnly);
    if (goal.control) {
      const control = goal.control;
      return candidates.filter((candidate) => {
        if (this.isDistraction(`${candidate.text} ${safePathname(candidate.href ?? '', this.origin)}`)) return false;
        if (!control.allowLinks && candidate.tag === 'a') return false;
        return control.hints.some((hint) => normalizeLabel(candidate.text) === normalizeLabel(hint)
          || semanticLabelMatch(candidate.text, hint));
      });
    }
    const surface = goal.surface;
    if (surface.spec.viaAccountMenu && navigationOnly && (surface.menuLabel || surface.path)) {
      return candidates.filter((candidate) => {
        if (surface.menuLabel?.test(normalizeLabel(candidate.text))) return true;
        return !!candidate.href && !!surface.path && surface.path.test(safePathname(candidate.href, this.origin));
      });
    }
    return candidates;
  }

  private async candidatesForHints(page: Page, hints: string[], navigationOnly: boolean): Promise<Candidate[]> {
    const nodes = page.locator('a[href], button, select, [role="link"], [role="button"], [role="combobox"]');
    const count = Math.min(await nodes.count(), 160);
    const result: Candidate[] = [];
    for (let index = 0; index < count; index += 1) {
      const locator = nodes.nth(index);
      if (!(await locator.isVisible().catch(() => false))) continue;
      const meta = await locator.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        values: [
          element instanceof HTMLElement ? element.innerText : element.textContent,
          element.getAttribute('aria-label'), element.getAttribute('title'),
        ].filter(Boolean).map((value) => String(value).replace(/\s+/g, ' ').trim().slice(0, 240)),
        href: element.getAttribute('href') ?? undefined,
        type: element instanceof HTMLButtonElement ? element.type : (element.getAttribute('type') ?? undefined),
        insideForm: !!element.closest('form'),
        inHeaderRegion: !!element.closest('header, nav, [role="banner"], [role="navigation"]')
          || element.getBoundingClientRect().top < window.innerHeight * 0.35,
        inViewport: (() => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight
            && rect.left >= 0 && rect.right <= window.innerWidth;
        })(),
        disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
        stableSelector: (() => {
          if (element.id) return `#${CSS.escape(element.id)}`;
          const componentId = element.getAttribute('data-component-id');
          if (componentId) return `[data-component-id="${CSS.escape(componentId)}"]`;
          const controls = element.getAttribute('aria-controls');
          if (controls) return `[aria-controls="${CSS.escape(controls)}"]`;
          return undefined;
        })(),
      })).catch(() => undefined);
      if (!meta || meta.disabled || !meta.values.length || !meta.inViewport) continue;
      const text = meta.values.join(' ');
      if (DANGEROUS_ACTION.test(text)) continue;
      if (navigationOnly && !meta.href && meta.tag !== 'a' && meta.insideForm && elementRole(text) !== 'navigation') continue;
      if (meta.type?.toLowerCase() === 'submit' && meta.insideForm) continue;
      if (meta.href && !this.isSafeHref(meta.href)) continue;

      const labels = meta.values.map((value) => value.toLowerCase());
      const href = (meta.href ?? '').toLowerCase();
      let score = 0;
      for (const hint of hints) {
        if (labels.some((label) => label === hint)) score += 12;
        else if (labels.some((label) => semanticLabelMatch(label, hint))) score += hint.includes(' ') ? 8 : 5;
        else if (href.includes(hint.replace(/\s+/g, '-')) || href.includes(hint.replace(/\s+/g, ''))) score += 4;
      }
      if (meta.href) score += 2;
      if (meta.inHeaderRegion) score += 1;
      if (score > 0) result.push({
        locator,
        text: meta.values[0],
        href: meta.href,
        tag: meta.tag,
        type: meta.type,
        score,
        inHeaderRegion: meta.inHeaderRegion,
        stableSelector: meta.stableSelector,
      });
    }
    return result.sort((a, b) => b.score - a.score);
  }

  /** Enumerate every enabled non-placeholder option for every visible matching select. */
  private async enumerateNativeSelects(page: Page, control: ControlSpec): Promise<boolean> {
    const selects = page.locator('select:visible');
    let found = false;
    for (let selectIndex = 0; selectIndex < await selects.count(); selectIndex += 1) {
      if (this.stopped()) return found;
      const select = selects.nth(selectIndex);
      const descriptor = await select.evaluate((element) => {
        const selectElement = element as HTMLSelectElement;
        const labels = selectElement.labels ? [...selectElement.labels].map((label) => label.innerText) : [];
        return [selectElement.getAttribute('aria-label'), selectElement.getAttribute('name'), selectElement.id, ...labels]
          .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      }).catch(() => '');
      if (!control.hints.some((hint) => semanticLabelMatch(descriptor, hint))) continue;
      const selectorKey = descriptor || `native-select-${selectIndex + 1}`;
      const original = await select.inputValue();
      const options = await select.locator('option').evaluateAll((nodes) => nodes.map((node) => {
        const option = node as HTMLOptionElement;
        return { value: option.value, label: option.label.trim(), disabled: option.disabled };
      }).filter((option) => option.value && option.label && !option.disabled && !/^(?:choose|select|please select|--)/i.test(option.label)));
      if (!options.length) continue;
      found = true;
      this.reportState.enumerationCoverage.discovered += options.length;
      for (const option of options) {
        if (this.stopped() || this.budgetExhausted(page)) {
          this.addBranch(control.id, selectorKey, option.value, option.label, 'blocked', 'conservative action budget exhausted');
          continue;
        }
        const fresh = page.locator(await this.stableSelectorFor(select, `select:nth-of-type(${selectIndex + 1})`)).first();
        const observedResponses: string[] = [];
        const onResponse = (response: Response): void => {
          if (this.isAllowedUrl(response.url())) observedResponses.push(response.url());
        };
        page.on('response', onResponse);
        this.reportState.enumerationCoverage.attempted += 1;
        try {
          await this.throttle(page);
          await fresh.selectOption(option.value);
          this.reportState.interactions += 1;
          await this.settle(page);
          const selected = await fresh.inputValue().catch(() => '');
          const covered = selected === option.value;
          this.addBranch(
            control.id,
            selectorKey,
            option.value,
            option.label,
            covered ? 'covered' : 'blocked',
            covered ? `selected; ${observedResponses.length} correlated first-party response(s)` : 'selection did not persist',
          );
        } catch (error) {
          this.reportState.interactions += 1;
          this.addBranch(control.id, selectorKey, option.value, option.label, 'blocked', safeError(error));
        } finally {
          page.off('response', onResponse);
        }
      }
      if (!this.stopped()) {
        const fresh = page.locator(await this.stableSelectorFor(select, `select:nth-of-type(${selectIndex + 1})`)).first();
        await fresh.selectOption(original).catch(() => {});
      }
    }
    return found;
  }

  /**
   * Snapshot every sibling before acting, then reacquire and exercise each one. The
   * opener is resolved fresh between branches so a closed listbox never causes index-0
   * repetition or stale-locator clicks.
   */
  private async enumerateCustomBranches(page: Page, surface: CompiledSurface, control: ControlSpec, opener?: Candidate): Promise<void> {
    const container = page.locator(ENUMERATION_CONTAINER).first();
    if (!await container.isVisible().catch(() => false)) return;
    const selectorKey = (await container.getAttribute('id')) || (await container.getAttribute('aria-label')) || `custom-${control.id}-picker`;
    const optionNodes = container.locator(ENUMERATION_OPTION);
    const branches = await optionNodes.evaluateAll((nodes) => nodes.map((node, index) => {
      const element = node as HTMLElement;
      const label = (element.innerText || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const value = element.getAttribute('data-value') || element.getAttribute('data-id') || element.id || label || String(index);
      return {
        value,
        label,
        disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
      };
    }).filter((branch) => branch.label && !branch.disabled && !/^(?:choose|select|show more|see more)$/i.test(branch.label)));
    const distinct = [...new Map(branches.map((branch) => [`${branch.value}:${branch.label}`, branch])).values()];
    this.reportState.enumerationCoverage.discovered += distinct.length;

    for (const branch of distinct) {
      if (this.stopped() || this.budgetExhausted(page)) {
        this.addBranch(control.id, selectorKey, branch.value, branch.label, 'blocked', 'conservative action budget exhausted');
        continue;
      }
      if (!await container.isVisible().catch(() => false)) {
        await this.reopenPicker(page, surface, control, opener);
      }
      const active = page.locator(ENUMERATION_CONTAINER).first();
      const freshOptions = active.locator(ENUMERATION_OPTION);
      const matchingIndex = await freshOptions.evaluateAll((nodes, target) => nodes.findIndex((node) => {
        const element = node as HTMLElement;
        const label = (element.innerText || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const value = element.getAttribute('data-value') || element.getAttribute('data-id') || element.id || label;
        return value === target.value && label === target.label;
      }), branch);
      if (matchingIndex < 0) {
        this.addBranch(control.id, selectorKey, branch.value, branch.label, 'blocked', 'branch could not be reacquired after backtracking');
        continue;
      }
      const option = freshOptions.nth(matchingIndex);
      const beforeUrl = page.url();
      const beforeState = await this.visibleStateFingerprint(page);
      const responses: string[] = [];
      const onResponse = (response: Response): void => {
        if (this.isAllowedUrl(response.url())) responses.push(response.url());
      };
      page.on('response', onResponse);
      this.reportState.enumerationCoverage.attempted += 1;
      try {
        await this.throttle(page);
        await option.click({ timeout: 4_000 });
        this.reportState.interactions += 1;
        await this.settle(page);
        if (page.url() !== beforeUrl) this.reportState.navigations += 1;
        const changed = page.url() !== beforeUrl || await this.visibleStateFingerprint(page) !== beforeState || responses.length > 0;
        this.addBranch(
          control.id,
          selectorKey,
          branch.value,
          branch.label,
          changed ? 'covered' : 'blocked',
          changed ? `verified; ${responses.length} correlated first-party response(s)` : 'no verified postcondition',
        );
      } catch (error) {
        this.reportState.interactions += 1;
        this.addBranch(control.id, selectorKey, branch.value, branch.label, 'blocked', safeError(error));
      } finally {
        page.off('response', onResponse);
      }
      if (page.url() !== beforeUrl && !this.stopped()) await this.restorePage(page, beforeUrl);
    }
  }

  private async reopenPicker(page: Page, surface: CompiledSurface, control: ControlSpec, opener?: Candidate): Promise<boolean> {
    await page.keyboard.press('Escape').catch(() => {});
    let target: Locator | undefined;
    if (opener?.stableSelector) {
      const stable = page.locator(opener.stableSelector).first();
      if (await stable.isVisible().catch(() => false)) target = stable;
    }
    if (!target && opener) {
      const candidates = await this.candidates(page, { surface, control }, false);
      target = candidates.find((candidate) => normalizeLabel(candidate.text) === normalizeLabel(opener.text))?.locator;
    }
    if (!target) return false;
    try {
      await target.click({ timeout: 4_000 });
      this.reportState.interactions += 1;
      await this.settle(page);
      return await page.locator(ENUMERATION_CONTAINER).first().isVisible().catch(() => false);
    } catch {
      this.reportState.interactions += 1;
      return false;
    }
  }

  private addBranch(
    control: string,
    selector: string,
    value: string,
    label: string,
    status: BranchCoverage['status'],
    detail?: string,
  ): void {
    const branch: BranchCoverage = { control, selector, value, label, status, ...(detail ? { detail } : {}) };
    this.reportState.enumerationCoverage.branches.push(branch);
    this.reportState.enumerationCoverage[status] += 1;
    this.reportState.events.push({
      phase: control,
      action: 'interact',
      strategy: 'enumeration-branch',
      url: '',
      outcome: status === 'covered' ? 'succeeded' : 'blocked',
      detail: `${selector}: ${label} (${status})${detail ? `; ${detail}` : ''}`,
    });
  }

  private async stableSelectorFor(locator: Locator, fallback: string): Promise<string> {
    return await locator.evaluate((element, fallbackSelector) => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const name = element.getAttribute('name');
      if (name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      return fallbackSelector;
    }, fallback).catch(() => fallback);
  }

  private async visibleSafeLinks(page: Page): Promise<ObservedLink[]> {
    const links = page.locator('a[href]');
    const count = Math.min(await links.count(), 220);
    const result: ObservedLink[] = [];
    for (let index = 0; index < count; index += 1) {
      const link = links.nth(index);
      if (!(await link.isVisible().catch(() => false))) continue;
      const observed = await link.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: [element instanceof HTMLElement ? element.innerText : element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')]
            .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 160),
          href: element.getAttribute('href') ?? '',
          inViewport: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight
            && rect.left >= 0 && rect.right <= window.innerWidth,
        };
      }).catch(() => undefined);
      if (!observed?.label || !observed.href || !observed.inViewport || !this.isSafeHref(observed.href)) continue;
      result.push({ label: observed.label, href: new URL(observed.href, this.origin).toString() });
    }
    return result;
  }

  private captureNewMenuLinks(before: ObservedLink[], after: ObservedLink[]): void {
    const existing = new Set(before.map(linkKey));
    this.accountMenuLinks = after.filter((link) => !existing.has(linkKey(link)));
  }

  private async followObservedMenuLink(page: Page, surface: CompiledSurface): Promise<boolean> {
    if (this.stopped() || !(await this.safetyCheck(page)) || this.budgetExhausted(page)) return false;
    const id = surface.spec.id;
    const candidates = this.accountMenuLinks
      .filter((link) => !this.isDistraction(`${link.label} ${safePathname(link.href, this.origin)}`))
      .map((link) => ({
        link,
        score: (surface.menuLabel?.test(normalizeLabel(link.label)) ? 20 : 0)
          + (surface.path?.test(safePathname(link.href, this.origin)) ? 12 : 0),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);
    const candidate = candidates[0]?.link;
    if (!candidate) return false;

    await this.throttle(page);
    try {
      const response = await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      this.reportState.interactions += 1;
      this.reportState.navigations += 1;
      await this.settle(page);
      const verified = (!response || response.status() < 400) && await this.matchesSurface(page, surface);
      this.record(
        page,
        'navigate',
        'account-menu',
        verified ? 'succeeded' : 'failed',
        `followed observed menu link: ${candidateDetail(id, { text: candidate.label, href: candidate.href } as Candidate)}`,
      );
      if (verified) this.rememberSurface(surface, page.url());
      return verified;
    } catch {
      this.reportState.interactions += 1;
      this.reportState.navigations += 1;
      this.record(page, 'navigate', 'account-menu', 'failed', `observed ${id} menu link could not be loaded`);
      return false;
    }
  }

  private async visibleStateFingerprint(page: Page): Promise<string> {
    return page.locator('h1, [role="heading"][aria-level="1"], a[href], button, [role="link"], [role="button"], [role="menu"], [role="dialog"]').evaluateAll((elements) => {
      const values: string[] = [];
      for (const element of elements.slice(0, 220)) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none' || rect.width <= 0 || rect.height <= 0) continue;
        if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) continue;
        const label = [
          element.getAttribute('aria-label'),
          element instanceof HTMLElement ? element.innerText : element.textContent,
          element.getAttribute('href'),
          element.getAttribute('role'),
          element.getAttribute('aria-expanded'),
        ].filter(Boolean).join('|').replace(/\s+/g, ' ').trim().slice(0, 240);
        if (label) values.push(label);
      }
      return values.join('\n');
    }).catch(() => '');
  }

  private async accountMenuEvidence(page: Page): Promise<string> {
    const values = await page.locator('a[href], button, [role="link"], [role="button"], [role="menu"]').evaluateAll((elements) => {
      const accountPattern = /account|profile|setting|order|sale|selling|listing|shipping|delivery|payout|return|workspace|billing|team|integration|activity|dashboard/i;
      const evidence: string[] = [];
      for (const element of elements.slice(0, 220)) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none' || rect.width <= 0 || rect.height <= 0) continue;
        const label = [
          element.getAttribute('aria-label'),
          element instanceof HTMLElement ? element.innerText : element.textContent,
          element.getAttribute('href'),
          element.getAttribute('role'),
        ].filter(Boolean).join('|').replace(/\s+/g, ' ').trim().slice(0, 240);
        if (accountPattern.test(label)) evidence.push(label);
      }
      return [...new Set(evidence)].sort();
    }).catch(() => [] as string[]);
    return values.join('\n');
  }

  private async scrollPosition(page: Page): Promise<number> {
    return page.evaluate(() => window.scrollY).catch(() => 0);
  }

  private async guardUnexpectedScroll(page: Page, beforeScroll: number, detail: string): Promise<void> {
    const afterScroll = await this.scrollPosition(page);
    if (Math.abs(afterScroll - beforeScroll) < 80) return;
    await page.evaluate((target) => window.scrollTo({ top: target, behavior: 'instant' }), beforeScroll).catch(() => {});
    this.stop(page, 'loss-of-grounding', `${detail}; unexpected automatic scroll was reverted`);
  }

  private async tryDirectRoute(page: Page, surface: CompiledSurface, target: string): Promise<boolean> {
    if (this.stopped() || !this.isAllowedUrl(target) || this.budgetExhausted(page)) return false;
    await this.throttle(page);
    try {
      const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      this.reportState.interactions += 1;
      this.reportState.navigations += 1;
      await this.settle(page);
      const okay = (!response || response.status() < 400) && await this.matchesSurface(page, surface);
      this.record(page, 'navigate', 'remembered-route', okay ? 'succeeded' : 'failed');
      if (okay) this.rememberSurface(surface, page.url());
      else delete this.memoryState.routes[surface.spec.id];
      return okay;
    } catch {
      this.reportState.interactions += 1;
      this.reportState.navigations += 1;
      this.record(page, 'navigate', 'remembered-route', 'failed');
      delete this.memoryState.routes[surface.spec.id];
      return false;
    }
  }

  private async restorePage(page: Page, target: string): Promise<void> {
    if (this.stopped() || page.url() === target || !this.isAllowedUrl(target) || this.budgetExhausted(page)) return;
    await this.throttle(page);
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      this.reportState.interactions += 1;
      this.reportState.navigations += 1;
      await this.settle(page);
      this.record(page, 'navigate', 'restore', 'succeeded');
    } catch {
      this.reportState.interactions += 1;
      this.reportState.navigations += 1;
      this.record(page, 'navigate', 'restore', 'failed');
    }
  }

  private async dismissObstructions(page: Page): Promise<void> {
    for (let pass = 0; pass < 3 && !this.stopped() && !this.budgetExhausted(page); pass += 1) {
      const overlays = page.locator(
        '[role="dialog"], [aria-modal="true"], dialog[open], [data-testid*="onboarding" i], [data-testid*="modal" i], [class*="onboarding" i]',
      );
      const count = Math.min(await overlays.count(), 20);
      let dismissed = false;
      for (let index = 0; index < count; index += 1) {
        const overlay = overlays.nth(index);
        if (!(await overlay.isVisible().catch(() => false))) continue;
        const overlayText = (await overlay.innerText().catch(() => '')).slice(0, 2_000);
        const controls = overlay.locator('button, [role="button"]');
        const controlCount = Math.min(await controls.count(), 30);
        let chosen: Locator | undefined;
        for (let controlIndex = 0; controlIndex < controlCount; controlIndex += 1) {
          const control = controls.nth(controlIndex);
          if (!(await control.isVisible().catch(() => false))) continue;
          const label = await control.evaluate((element) => [
            element instanceof HTMLElement ? element.innerText : element.textContent,
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
          ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()).catch(() => '');
          if (DISMISS_CONTROL.test(label) || (ONBOARDING_OVERLAY.test(overlayText) && /^close$/i.test(label))) {
            chosen = control;
            break;
          }
        }
        if (chosen) {
          await this.throttle(page);
          try {
            await chosen.click({ timeout: 4_000 });
            this.reportState.interactions += 1;
            await this.settle(page);
            this.record(page, 'dismiss', 'overlay', 'succeeded', 'dismissed onboarding or consent overlay');
            dismissed = true;
            break;
          } catch {
            this.reportState.interactions += 1;
            this.record(page, 'dismiss', 'overlay', 'failed');
          }
        } else if (ONBOARDING_OVERLAY.test(overlayText)) {
          await page.keyboard.press('Escape');
          this.reportState.interactions += 1;
          await this.settle(page);
          const closed = !(await overlay.isVisible().catch(() => false));
          this.record(page, 'dismiss', 'overlay', closed ? 'succeeded' : 'failed', 'Escape on onboarding overlay');
          dismissed = closed;
          break;
        }
      }
      if (!dismissed) return;
    }
  }

  /**
   * After a surface that may have opened a drawer or form: return to the start URL, or
   * close the unfinished overlay. Nothing was entered and no submit/save control is
   * ever used.
   */
  private async resetAfterSurface(page: Page, surface: CompiledSurface): Promise<void> {
    if (this.stopped()) return;
    const current = sanitizeUrl(page.url());
    const start = sanitizeUrl(this.options.startUrl);
    if (current !== start) {
      await this.restorePage(page, this.options.startUrl);
      return;
    }
    if (!surface.unfinishedOverlay) return;

    const overlays = page.locator('[role="dialog"], [aria-modal="true"], dialog[open], [class*="drawer" i]');
    const count = Math.min(await overlays.count(), 20);
    for (let index = 0; index < count; index += 1) {
      const overlay = overlays.nth(index);
      if (!(await overlay.isVisible().catch(() => false))) continue;
      const text = (await overlay.innerText().catch(() => '')).slice(0, 2_000);
      if (!surface.unfinishedOverlay.test(text)) continue;
      const close = overlay.locator('button[aria-label*="close" i], button[title*="close" i]').first();
      try {
        if (await close.isVisible().catch(() => false)) await close.click({ timeout: 4_000 });
        else await page.keyboard.press('Escape');
        this.reportState.interactions += 1;
        await this.settle(page);
        this.record(page, 'dismiss', 'overlay', 'succeeded', `closed unfinished ${surface.spec.id} surface`);
      } catch {
        this.reportState.interactions += 1;
        this.record(page, 'dismiss', 'overlay', 'failed', `could not close unfinished ${surface.spec.id} surface`);
      }
      return;
    }
  }

  /** A secondary, still non-mutating entry offered after the primary control (a mode chooser). */
  private async enterVariantIfOffered(page: Page, surface: CompiledSurface): Promise<boolean> {
    if (this.stopped()) return false;
    const candidates = await this.candidatesForHints(page, surface.spec.entryVariants ?? [], false);
    const candidate = candidates[0];
    if (!candidate || !(await this.safetyCheck(page)) || this.budgetExhausted(page)) return false;
    await this.throttle(page);
    const beforeUrl = page.url();
    const beforeState = await this.visibleStateFingerprint(page);
    const beforeScroll = await this.scrollPosition(page);
    try {
      await candidate.locator.click({ timeout: 5_000 });
      this.reportState.interactions += 1;
      await this.settle(page);
      if (page.url() !== beforeUrl) this.reportState.navigations += 1;
      await this.dismissObstructions(page);
      const changed = page.url() !== beforeUrl || await this.visibleStateFingerprint(page) !== beforeState;
      const verified = await this.matchesSurface(page, surface, changed);
      this.record(
        page,
        'navigate',
        'semantic',
        verified ? 'succeeded' : 'failed',
        verified ? `entered ${surface.spec.id} variant without submitting` : `${surface.spec.id} variant click produced no verified surface`,
      );
      if (!verified) await this.guardUnexpectedScroll(page, beforeScroll, `${surface.spec.id} variant entry produced no verified surface`);
      return verified;
    } catch {
      this.reportState.interactions += 1;
      await this.guardUnexpectedScroll(page, beforeScroll, `${surface.spec.id} variant entry click failed`);
      this.record(page, 'navigate', 'semantic', 'failed', `${surface.spec.id} variant was offered but could not be opened`);
      return false;
    }
  }

  /**
   * Arrival check. Surfaces with a path or heading pattern are recognised from the page
   * itself; surfaces without one are accepted only when the caller verified a change and
   * the page is not a 404 (and are never remembered as a route).
   */
  private async matchesSurface(page: Page, surface: CompiledSurface, verifiedChange = false): Promise<boolean> {
    const title = await page.title().catch(() => '');
    const primaryHeadings = await page.locator('h1, [role="heading"][aria-level="1"]').allTextContents().catch(() => []);
    if (NOT_FOUND.test([title, ...primaryHeadings].join(' '))) return false;
    if (!surface.recognisable) return verifiedChange;
    const path = new URL(page.url()).pathname;
    if (surface.path?.test(path)) return true;
    return !!surface.heading && primaryHeadings.some((heading) => surface.heading!.test(heading));
  }

  private async safetyCheck(page: Page): Promise<boolean> {
    if (this.stopped()) return false;
    if (this.blockedByResponse) {
      this.stop(page, this.blockedByResponse, this.blockedByResponse === 'rate-limited' ? 'rate limit response received' : 'access challenge response received');
      return false;
    }
    if (await this.looksLikeAuthentication(page)) {
      this.stop(page, 'authentication-required', 'session is missing or expired');
      return false;
    }
    if (await this.looksLikeChallenge(page)) {
      this.stop(page, 'challenge', 'captcha or browser challenge detected');
      return false;
    }
    return !this.budgetExhausted(page);
  }

  private async looksLikeAuthentication(page: Page): Promise<boolean> {
    const passwordVisible = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    if (passwordVisible) return true;
    const text = await this.pageText(page);
    if (AUTH_URL.test(page.url())) return /log[ -]?in|sign[ -]?in|continue with email/i.test(text);
    const emailVisible = await page.locator('input[type="email"], input[autocomplete="username"]').first().isVisible().catch(() => false);
    return emailVisible && /log[ -]?in|sign[ -]?in|continue with email/i.test(text);
  }

  private async looksLikeChallenge(page: Page): Promise<boolean> {
    const title = await page.title().catch(() => '');
    if (CHALLENGE_TEXT.test(title)) return true;
    const challengeElement = page.locator('[name="cf-turnstile-response"], iframe[src*="captcha" i], iframe[src*="challenge" i], [class*="captcha" i]').first();
    if (await challengeElement.isVisible().catch(() => false)) return true;
    return CHALLENGE_TEXT.test(await this.pageText(page));
  }

  private stop(page: Page, reason: NonNullable<DiscoveryReport['stopReason']>, detail: string): void {
    if (this.reportState.stopReason) return;
    this.reportState.stopReason = reason;
    this.reportState.humanInterventionRequired = reason === 'authentication-required'
      || reason === 'challenge'
      || reason === 'loss-of-grounding';
    this.record(page, 'stop', 'safety', 'blocked', detail);
    this.log(`discovery stopped: ${detail}`);
  }

  private stopped(): boolean {
    return this.reportState.stopReason !== undefined;
  }

  private budgetExhausted(page: Page): boolean {
    if (this.stopped()) return true;
    if (this.reportState.interactions < this.maxInteractions && this.reportState.navigations < this.maxNavigations) return false;
    this.stop(page, 'budget-exhausted', 'conservative interaction budget exhausted');
    return true;
  }

  private rememberSurface(surface: CompiledSurface, pageUrl: string): void {
    if (!surface.recognisable) return;
    const stable = stableRoute(pageUrl);
    if (stable && this.isAllowedUrl(stable)) this.memoryState.routes[surface.spec.id] = stable;
  }

  private record(
    page: Page,
    action: DiscoveryEvent['action'],
    strategy: DiscoveryEvent['strategy'],
    outcome: DiscoveryEvent['outcome'],
    detail?: string,
  ): void {
    this.reportState.events.push({ phase: this.phase, action, strategy, url: sanitizeUrl(page.url()), outcome, ...(detail ? { detail } : {}) });
  }

  private isDistraction(value: string): boolean {
    return !!this.distraction && this.distraction.test(value);
  }

  private isSafeHref(href: string): boolean {
    if (/^(?:javascript|data|mailto|tel):/i.test(href)) return false;
    try {
      return this.isAllowedUrl(new URL(href, this.origin).toString());
    } catch {
      return false;
    }
  }

  private isAllowedUrl(value: string): boolean {
    try {
      const url = new URL(value, this.origin);
      const allowed = this.options.allowedHostSuffix.toLowerCase();
      const host = url.hostname.toLowerCase();
      return (url.protocol === 'http:' || url.protocol === 'https:') && (host === allowed || host.endsWith(`.${allowed}`));
    } catch {
      return false;
    }
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  private async throttle(page: Page): Promise<void> {
    await page.waitForTimeout(this.actionDelayMs);
  }

  private async pageText(page: Page): Promise<string> {
    return (await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '')).slice(0, 4_000);
  }
}

function compile(source: string | undefined): RegExp | undefined {
  return source === undefined ? undefined : new RegExp(source, 'i');
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<unknown>';
  }
}

function stableRoute(value: string): string | undefined {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.some((segment) => DYNAMIC_PATH_SEGMENT.test(segment))) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function semanticLabelMatch(label: string, hint: string): boolean {
  const normalizedLabel = normalizeLabel(label);
  const normalizedHint = normalizeLabel(hint);
  if (!normalizedLabel || !normalizedHint) return false;
  if (normalizedHint.includes(' ')) return normalizedLabel.includes(normalizedHint);
  if (normalizedLabel.split(/\s+/).length > 4) return false;
  return new RegExp(`(?:^|\\b)${escapeRegExp(normalizedHint)}(?:\\b|$)`, 'i').test(normalizedLabel);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safePathname(value: string, origin: string): string {
  try {
    return new URL(value, origin).pathname;
  } catch {
    return '';
  }
}

function linkKey(link: ObservedLink): string {
  return `${normalizeLabel(link.label)}|${link.href}`;
}

/** Buttons without hrefs are only treated as navigation when their text says so. */
function elementRole(text: string): 'navigation' | 'control' {
  return /open|go to|view|manage|menu|hub/i.test(text) ? 'navigation' : 'control';
}

function candidateDetail(goal: string, candidate: Candidate): string {
  const label = candidate.text
    .replace(/[\w.+-]+@[\w.-]+/g, '<email>')
    .replace(/\b\d{5,}\b/g, '{id}')
    .slice(0, 100);
  let href = '';
  if (candidate.href) {
    try {
      href = new URL(candidate.href, 'https://target.invalid').pathname
        .replace(/\b\d{5,}\b/g, '{id}')
        .slice(0, 140);
    } catch { /* omit malformed href */ }
  }
  return `matched ${goal}: ${label}${href ? ` -> ${href}` : ''}`;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\w.+-]+@[\w.-]+/g, '<email>')
    .replace(/(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{12,}/gi, '<secret>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
