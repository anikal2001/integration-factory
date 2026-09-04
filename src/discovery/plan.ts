// A DiscoveryPlan describes which authenticated UI surfaces the browser navigator should
// reach and which controls it should exercise on each one — as data, not code. This is
// what makes discovery generic: a marketplace seller account, a SaaS admin console, a
// payments dashboard, or a shipping portal are all just different plans.
//
// Plans are read-only by construction. The navigator never submits, saves, publishes,
// purchases, deletes, or changes account state, whatever a plan says; a plan can only
// narrow what it explores.

export interface VisualTask {
  /** What the visual adviser should find, in one sentence. */
  targetDescription: string;
  /** The visible state Playwright must be able to verify after one click. */
  predictedPostcondition: string;
}

export interface ControlSpec {
  /** Stable id; becomes a discovery phase and a capability name in reports. */
  id: string;
  /** Visible labels, most specific first. Matched semantically against buttons/selects. */
  hints: string[];
  /**
   * Regex source matched against captured endpoint URLs and JSON key shapes. Used to
   * score which routes implement this capability.
   */
  signal?: string;
  /**
   * Enumerate every option of a matching native <select> or ARIA listbox/tree (a
   * category picker, a plan picker, a region selector) and correlate the responses.
   */
  enumerate?: boolean;
  /** Allow <a href> candidates. Default false: controls are buttons/selects on the surface. */
  allowLinks?: boolean;
  visual?: VisualTask;
}

export interface SurfaceSpec {
  /** Stable id; becomes a discovery phase, a capability name, and a memory key. */
  id: string;
  /** Visible labels that lead to this surface, most specific first. */
  hints: string[];
  /** Regex source tested against the pathname to confirm arrival. */
  pathPattern?: string;
  /** Regex source tested against the page's primary heading to confirm arrival. */
  headingPattern?: string;
  /** Exact-label regex source used when choosing this surface from an open account menu. */
  menuLabelPattern?: string;
  /**
   * Reached from the account/profile menu (settings, orders, billing) rather than a
   * primary call-to-action on the page. Default false.
   */
  viaAccountMenu?: boolean;
  /**
   * Labels of a secondary, still non-mutating entry offered after the primary control
   * (e.g. a "create manually" option in a mode chooser).
   */
  entryVariants?: string[];
  /**
   * Regex source matched against an open overlay's text to recognise an unfinished form
   * belonging to this surface, so it can be closed without saving before moving on.
   */
  unfinishedOverlayPattern?: string;
  /** Regex source for capability scoring of endpoints observed on this surface. */
  signal?: string;
  visual?: VisualTask;
  controls?: ControlSpec[];
}

export interface DiscoveryPlan {
  /** Short id, e.g. "marketplace-seller". */
  id: string;
  description?: string;
  /** Labels of the header control that opens the account/profile menu. */
  accountMenuHints?: string[];
  accountMenuVisual?: VisualTask;
  /**
   * Regex source for content links that look like destinations but are distractions
   * (editorial, promotions, favourites). Applied to label + pathname.
   */
  distractionPattern?: string;
  /** Regex source of endpoint paths that must never be promoted to a capability. */
  ignoreEndpointPattern?: string;
  surfaces: SurfaceSpec[];
}

/** Surfaces first, then their controls, in traversal order. */
export function planPhases(plan: DiscoveryPlan): string[] {
  const phases: string[] = ['bootstrap'];
  for (const surface of plan.surfaces) {
    phases.push(surface.id);
    for (const control of surface.controls ?? []) phases.push(control.id);
  }
  return phases;
}

export function findSurface(plan: DiscoveryPlan, id: string): SurfaceSpec | undefined {
  return plan.surfaces.find((surface) => surface.id === id);
}

export function findControl(plan: DiscoveryPlan, id: string): { surface: SurfaceSpec; control: ControlSpec } | undefined {
  for (const surface of plan.surfaces) {
    const control = surface.controls?.find((candidate) => candidate.id === id);
    if (control) return { surface, control };
  }
  return undefined;
}

/** Validates a plan loaded from JSON. Throws with a precise message on the first problem. */
export function assertPlan(value: unknown): DiscoveryPlan {
  if (!value || typeof value !== 'object') throw new Error('plan must be an object');
  const plan = value as DiscoveryPlan;
  if (!plan.id || typeof plan.id !== 'string') throw new Error('plan.id is required');
  if (!Array.isArray(plan.surfaces) || plan.surfaces.length === 0) throw new Error('plan.surfaces must be a non-empty array');
  const ids = new Set<string>(['bootstrap']);
  for (const surface of plan.surfaces) {
    if (!surface.id || typeof surface.id !== 'string') throw new Error('every surface needs an id');
    if (ids.has(surface.id)) throw new Error(`duplicate phase id "${surface.id}"`);
    ids.add(surface.id);
    if (!Array.isArray(surface.hints) || surface.hints.length === 0) throw new Error(`surface "${surface.id}" needs hints`);
    for (const key of ['pathPattern', 'headingPattern', 'menuLabelPattern', 'unfinishedOverlayPattern', 'signal'] as const) {
      const source = surface[key];
      if (source !== undefined) compileOrThrow(source, `surface "${surface.id}".${key}`);
    }
    for (const control of surface.controls ?? []) {
      if (!control.id || typeof control.id !== 'string') throw new Error(`every control on "${surface.id}" needs an id`);
      if (ids.has(control.id)) throw new Error(`duplicate phase id "${control.id}"`);
      ids.add(control.id);
      if (!Array.isArray(control.hints) || control.hints.length === 0) throw new Error(`control "${control.id}" needs hints`);
      if (control.signal !== undefined) compileOrThrow(control.signal, `control "${control.id}".signal`);
    }
  }
  for (const key of ['distractionPattern', 'ignoreEndpointPattern'] as const) {
    const source = plan[key];
    if (source !== undefined) compileOrThrow(source, `plan.${key}`);
  }
  return plan;
}

function compileOrThrow(source: string, label: string): void {
  try {
    new RegExp(source, 'i');
  } catch (error) {
    throw new Error(`${label} is not a valid regex: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── Built-in plans ───────────────────────────────────────────────────────────────

/**
 * A marketplace seller account: listing editor → category picker, settings → shipping,
 * orders → sold filter. This is the plan the navigator was originally built around.
 */
export const MARKETPLACE_SELLER_PLAN: DiscoveryPlan = {
  id: 'marketplace-seller',
  description: 'Seller-side surfaces of a consumer marketplace: listing editor, taxonomy, settings, shipping, orders, sold.',
  accountMenuHints: [
    'open account options', 'account menu', 'profile menu', 'user menu', 'seller hub',
    'my account', 'account', 'profile', 'avatar',
  ],
  accountMenuVisual: {
    targetDescription: 'Open the header account/profile/avatar menu without scrolling.',
    predictedPostcondition: 'A visible account dropdown or popover reveals account navigation links.',
  },
  distractionPattern: '\\b(?:favorites?|journal|magazine|article|blog|promotion|discount|first orders?|shop|search by brand)\\b',
  ignoreEndpointPattern: '\\/(?:v\\d+\\/)?products?\\/search(?:[/?]|$)|favorites?_empty_state|\\/favorites?(?:[/?]|$)',
  surfaces: [
    {
      id: 'listing',
      hints: ['create a listing', 'create listing', 'new listing', 'list an item', 'sell an item', 'start selling', 'sell'],
      pathPattern: '\\/(?:sell|deposit|listing(?:s)?\\/(?:create|new)|list\\/new)(?:\\/|$)',
      headingPattern: '^(?:create (?:a )?listing|new listing|list an item|sell an item)$',
      entryVariants: ['use manual listing', 'manual listing', 'create manually', 'list manually', 'continue manually'],
      unfinishedOverlayPattern: 'create (?:a )?listing|sell an item|choose category|item details',
      signal: 'listings?|products?|items?|sell|draft',
      visual: {
        targetDescription: 'Open the reversible create-listing or sell-entry surface without submitting anything.',
        predictedPostcondition: 'A listing mode chooser or verified listing editor becomes visible.',
      },
      controls: [
        {
          id: 'taxonomy',
          hints: ['choose category', 'select category', 'category', 'department', 'item type', 'product type'],
          signal: 'categor|taxonom|catalog|attribut|facet|department|product.?type',
          enumerate: true,
          visual: {
            targetDescription: 'Open the category, department, or item-type picker inside the verified listing editor.',
            predictedPostcondition: 'A category selector changes visibly or a first-party taxonomy response occurs.',
          },
        },
      ],
    },
    {
      id: 'settings',
      hints: ['seller settings', 'selling settings', 'account settings', 'preferences', 'settings'],
      pathPattern: '\\/(?:my-)?account\\/settings(?:\\/|$)|\\/(?:seller|selling)\\/settings(?:\\/|$)',
      headingPattern: '^(?:account settings|seller settings|selling settings)$',
      menuLabelPattern: '^(?:(?:account|seller|selling)\\s+)?settings$',
      viaAccountMenu: true,
      signal: 'settings?|preferences?|seller.?profile|account.?config',
      visual: {
        targetDescription: 'Choose the exact account or seller settings link from the currently open account menu.',
        predictedPostcondition: 'The account or seller settings surface is visibly loaded.',
      },
      controls: [
        {
          id: 'shippingSettings',
          hints: ['shipping preferences', 'shipping settings', 'delivery settings', 'postage', 'shipping', 'delivery'],
          signal: 'shipping|delivery|postage|carrier|fulfillment|return.?address',
          allowLinks: true,
          visual: {
            targetDescription: 'Open the shipping, delivery, or postage preferences from the verified settings surface.',
            predictedPostcondition: 'Shipping or delivery settings change visibly or a first-party settings response occurs.',
          },
        },
      ],
    },
    {
      id: 'orders',
      hints: ['seller orders', 'manage orders', 'my orders', 'orders', 'sales'],
      pathPattern: '\\/(?:my-account\\/)?orders(?:-sales)?(?:\\/|$)|\\/(?:seller\\/)?sales(?:\\/|$)',
      headingPattern: '^(?:(?:my )?(?:orders|sales)|orders\\s*(?:&|and)\\s*sales)$',
      menuLabelPattern: '^(?:(?:my\\s+)?(?:orders|sales)|orders\\s*(?:&|and)\\s*sales)$',
      viaAccountMenu: true,
      signal: 'orders?|transactions?|purchases?|sales',
      visual: {
        targetDescription: 'Choose the exact orders or sales-management link from the currently open account menu.',
        predictedPostcondition: 'The seller orders or orders-and-sales surface is visibly loaded.',
      },
      controls: [
        {
          id: 'soldListings',
          hints: ['sold listings', 'my sales', 'completed orders', 'completed', 'fulfilled', 'sold', 'sales'],
          signal: 'sold|completed|fulfilled|closed|sales',
          allowLinks: true,
          visual: {
            targetDescription: 'Open the sold, completed, or fulfilled filter within the verified orders/sales surface.',
            predictedPostcondition: 'The sold/completed state changes visibly or a first-party filtered orders response occurs.',
          },
        },
      ],
    },
  ],
};

/**
 * A generic web-app account: dashboard, then settings → integrations/webhooks, then an
 * activity or history view → export. Shows the same navigator on a non-marketplace target.
 */
export const WEB_APP_ACCOUNT_PLAN: DiscoveryPlan = {
  id: 'web-app-account',
  description: 'Account-side surfaces of a SaaS product: dashboard, settings, integrations, activity, exports.',
  accountMenuHints: ['open account options', 'account menu', 'profile menu', 'user menu', 'workspace menu', 'my account', 'account', 'profile', 'avatar'],
  accountMenuVisual: {
    targetDescription: 'Open the header account/profile/avatar menu without scrolling.',
    predictedPostcondition: 'A visible account dropdown or popover reveals account navigation links.',
  },
  distractionPattern: '\\b(?:blog|docs|documentation|changelog|pricing|community|help center|status)\\b',
  surfaces: [
    {
      id: 'dashboard',
      hints: ['dashboard', 'home', 'overview'],
      pathPattern: '\\/(?:dashboard|home|overview)(?:\\/|$)',
      headingPattern: '^(?:dashboard|overview|home)$',
      signal: 'dashboard|overview|summary|stats',
    },
    {
      id: 'settings',
      hints: ['workspace settings', 'account settings', 'organization settings', 'settings', 'preferences'],
      pathPattern: '\\/(?:settings|preferences|admin)(?:\\/|$)',
      headingPattern: '^(?:(?:workspace|account|organization|general)\\s+)?settings$',
      menuLabelPattern: '^(?:(?:workspace|account|organization)\\s+)?settings$',
      viaAccountMenu: true,
      signal: 'settings?|preferences?|organization|workspace',
      controls: [
        {
          id: 'integrations',
          hints: ['integrations', 'connected apps', 'webhooks', 'api'],
          signal: 'integrations?|webhooks?|connected|apps|api.?keys?',
          allowLinks: true,
        },
        {
          id: 'notifications',
          hints: ['notification preferences', 'notifications', 'alerts'],
          signal: 'notifications?|alerts?|subscriptions?',
          allowLinks: true,
        },
      ],
    },
    {
      id: 'activity',
      hints: ['activity', 'history', 'audit log', 'logs', 'reports'],
      pathPattern: '\\/(?:activity|history|audit|logs|reports)(?:\\/|$)',
      headingPattern: '^(?:activity|history|audit log|logs|reports)$',
      menuLabelPattern: '^(?:activity|history|audit log|reports)$',
      viaAccountMenu: true,
      signal: 'activity|history|audit|events?|reports?',
      controls: [
        {
          id: 'exportHistory',
          hints: ['export', 'download csv', 'download report'],
          signal: 'export|download|csv|report',
        },
      ],
    },
  ],
};

export const BUILTIN_PLANS: Record<string, DiscoveryPlan> = {
  [MARKETPLACE_SELLER_PLAN.id]: MARKETPLACE_SELLER_PLAN,
  [WEB_APP_ACCOUNT_PLAN.id]: WEB_APP_ACCOUNT_PLAN,
};
