# Discovery plans

A plan is a JSON document matching `DiscoveryPlan` in `src/discovery/plan.ts`. Two are
built in (`marketplace-seller`, `web-app-account`); pass any file path to `--plan` for
your own. `shipping-carrier.json` here is a starting point for a carrier portal.

Rules every plan inherits, regardless of what it says:

- Only visible, in-viewport, non-submit controls are candidates.
- Labels matching publish / save / delete / buy / pay / ship / offer / confirm are never clicked.
- Every click needs an observable postcondition (URL, visible UI, or first-party network).
- Discovery stops on HTTP 401/403/429, a CAPTCHA or browser challenge, an unexpected
  scroll, or when the interaction budget is spent.
