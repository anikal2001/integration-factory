# integration-factory

**Build third-party integrations into your codebase with an agent you can trust: sandbox → agent → verify → PR. When the third party has no API, discover its private one safely from a real browser session first.**

Provider-agnostic by construction. The model is any OpenAI-compatible endpoint, the sandbox is a local git worktree or a cloud box, the browser is local Chromium or a hosted one. Nothing in the core knows what kind of integration it is building — a marketplace adapter, a payment provider, a shipping carrier, a CRM connector, or an SSO plugin are all just different **profiles**.

```bash
npm install
npm run demo        # offline: scaffolds a payment provider into a sample repo, verifies it, prepares a PR
```

No API keys, no network. The demo uses a scripted model and a temp git repo, so you can read every step the real thing would take.

## How it works

```
                 integration-factory.json            targets/<x>.json          plan (JSON)
                 "what an integration looks          "where the third           "which UI surfaces
                  like in THIS codebase"              party lives"               to explore"
                          │                                │                        │
  ┌─────────────┐    ┌────▼─────┐    ┌───────────┐    ┌────▼──────┐    ┌────────────▼────┐
  │  sandbox    │───▶│  agent   │───▶│  verify   │───▶│  PR       │    │  browser         │
  │ worktree /  │    │ 5 tools, │    │ profile's │    │ dry-run   │◀───│  discovery       │
  │ cloud box   │    │ any LLM  │    │ command   │    │ by default│    │  read-only, HAR  │
  └─────────────┘    └──────────┘    └───────────┘    └───────────┘    └──────────────────┘
```

1. **Profile** — the target repo declares its contract files, where new modules go, a template, registration steps, and a verify command.
2. **Sandbox** — the repo is checked out on a fresh branch (git worktree locally, or a cloud sandbox).
3. **Agent** — a model drives five primitive tools (`read_file`, `write_file`, `list_dir`, `exec`, `finish`) following a playbook rendered from the profile. Thin brain, fat determinism: templates, verification, and PR prep are plain code.
4. **Verify** — the profile's command must exit 0. If it doesn't, no PR.
5. **PR** — dry-run prints the exact commands; `--open-pr` pushes and opens it.

For targets without a usable public API, **onboard** runs first: log in once (a human can help), then a navigator walks the account's surfaces read-only, records the private endpoints it sees, classifies them by capability, and writes a discovery doc + capture scaffold into a branch of your repo.

## Build an integration into your repo

Add `integration-factory.json` to the repo that receives integrations:

```json
{
  "name": "acme-billing",
  "kind": "payments",
  "contractFiles": ["src/payments/IPaymentProvider.js", "src/payments/BaseProvider.js"],
  "scaffold": { "path": "src/payments/providers/{{Pascal}}Provider.js", "template": ".integration-factory/provider.template.js" },
  "registration": ["Add '{{kebab}}' to PROVIDER_IDS in src/payments/registry.js"],
  "verify": "node scripts/check-providers.mjs",
  "baseRef": "origin/main"
}
```

Tokens: `{{name}}`, `{{Pascal}}`, `{{camel}}`, `{{kebab}}`, `{{CONSTANT}}`. See [`examples/sample-target-repo`](examples/sample-target-repo) for the complete shape, including a template and a real verify gate.

Then:

```bash
cp .env.example .env            # set MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME for a real model
npm start -- stripe --repo ../acme-billing            # dry run: branch + worktree, commands printed
npm start -- stripe --repo ../acme-billing --open-pr  # push + gh pr create (verify must pass)
```

Any OpenAI-shaped `/chat/completions` endpoint works: OpenRouter, Anthropic, OpenAI, LiteLLM, Together, Groq, Ollama. Set `SANDBOX_PROVIDER=daytona` for a cloud sandbox (experimental; `TARGET_REPO` becomes a git URL).

## Discover a target that has no API

```bash
npx playwright install chromium

# Log in once. Headed by default so you can finish MFA/CAPTCHA yourself; the session is saved locally.
npm run login -- vendor --url https://app.vendor.example/login

# Discover: walks the plan's surfaces, captures endpoints, classifies capabilities.
npm run onboard -- vendor --url https://app.vendor.example/ --plan web-app-account --repo ../acme-billing --pr
```

Outputs under `out/vendor/`:

| file | what | commit it? |
| --- | --- | --- |
| `storageState.json` | cookies + localStorage | **never** |
| `vendor.har` | full traffic incl. tokens | **never** |
| `vendor-endpoints.json` | sanitized endpoints, capability + enumeration candidates, discovery audit | yes, via the PR |
| `vendor-navigation.json` | every action the navigator took and why it stopped | yes |
| `vendor.capture.js` | the profile's capture scaffold, filled with what was found | yes |

`--pr` writes the doc, the endpoints report, and the capture scaffold into a fresh branch of `--repo` (dry-run; `--open-pr` to push). The HAR is never written into the repo.

### Discovery plans

A plan is data: which surfaces to reach, which controls to exercise, how to confirm arrival. Two are built in — `marketplace-seller` (listing editor → category picker, settings → shipping, orders → sold) and `web-app-account` (dashboard, settings → integrations, activity → export). [`examples/plans/shipping-carrier.json`](examples/plans/shipping-carrier.json) shows a third. Pass any JSON path to `--plan`.

```json
{
  "id": "web-app-account",
  "accountMenuHints": ["account menu", "my account", "avatar"],
  "surfaces": [
    { "id": "settings", "hints": ["account settings", "settings"], "viaAccountMenu": true,
      "headingPattern": "^(?:account )?settings$", "signal": "settings?|preferences?",
      "controls": [{ "id": "integrations", "hints": ["integrations", "webhooks"], "signal": "integrations?|webhooks?", "allowLinks": true }] }
  ]
}
```

Controls with `"enumerate": true` walk every option of a native select or ARIA listbox (a category tree, a service-level picker) and correlate the responses, so reference data gets captured branch by branch.

### Safety model, in one paragraph

The navigator is read-only whatever a plan says: labels matching publish / save / delete / buy / pay / ship / offer / confirm are excluded before scoring; every click needs an observable postcondition; an unexpected scroll reverts and ends the run; HTTP 401/403/429, a CAPTCHA, or a spent budget stops it; login submits each stage once so a wrong password never becomes a lockout; credentials come from env and are never written down. There is no bot-detection evasion — a challenged headless browser hands off to a human at a visible one. Full details and the reporting process are in [`SECURITY.md`](SECURITY.md).

### Optional: visual adviser

For popovers the semantic navigator can't resolve, a bounded [Browser Use](https://browser-use.com) sidecar can look at the page over CDP and propose **one** visible control. It cannot click; Playwright resolves the proposal, applies the same safety checks, and verifies the postcondition. Needs Python ≥3.12 + `uv sync` + `BROWSER_USE_API_KEY`, and is off unless you pass `--visual`.

## Layout

```
src/
  index.ts / orchestrate.ts    build loop: sandbox → agent → verify → PR
  profile.ts                   integration-factory.json: what an integration is in a codebase
  target.ts                    targets/<name>.json: where a third party lives, how to log in
  agent/                       tool specs + the model-agnostic loop
  model/                       ModelClient: OpenAI-compatible + Mock
  sandbox/                     Sandbox: local worktree + Daytona
  tasks/                       deterministic scaffold + verify
  playbooks/                   model-neutral task spec (profile can override)
  auth/                        adaptive login, IMAP code reader
  capture/                     Playwright capture, endpoint sanitising, capability/enumeration scoring
  discovery/                   plans, the plan-driven surface navigator, visual adviser
  pr/                          PR prep, discovery doc
  onboard.ts / *-cli.ts        the discovery pipeline and CLIs
examples/                      sample target repo, target, plans
scripts/                       demo, visual-adviser sidecar + smoke
test/                          node:test; fixture servers, no internet
```

## Status

Early. The loop, profiles, plans, discovery, and dry-run PRs work and are tested. Not yet: durable/resumable runs, parallel fan-out, a record-and-replay conformance suite built from captures, cost telemetry per run, and any mutating discovery (that stays human-authorized by design). Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Apache-2.0. See [`LICENSE`](LICENSE).
