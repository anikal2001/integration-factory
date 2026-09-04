# Contributing

Thanks for helping. This project is small on purpose: a thin agent loop, deterministic
tasks around it, and swappable providers. Contributions that keep it that way are the
easiest to merge.

## Setup

```bash
npm install
npx playwright install chromium   # browser tests
npm run typecheck && npm test
npm run demo                      # offline end-to-end run
```

The optional visual adviser needs Python ≥3.12 and [uv](https://docs.astral.sh/uv/):
`uv sync`, then `npm run visual:smoke` with `BROWSER_USE_API_KEY` set.

## What a good change looks like

- **Providers stay behind interfaces.** A new model gateway implements `ModelClient`; a
  new sandbox implements `Sandbox` + `SandboxFactory`; a new browser source implements
  `BrowserProvider`. Nothing else should need to know it exists.
- **Judgment in the model, everything else in code.** If a step can be deterministic
  (rendering a template, running a verify command, opening a PR), it belongs in
  `src/tasks/` or `src/pr/`, not in a prompt.
- **Codebase specifics live in profiles, target specifics in targets, UI specifics in
  plans.** Please don't hardcode a company's file paths or a website's selectors in
  `src/`. Add or extend an example instead.
- **Discovery safety is not negotiable.** Changes to `src/discovery/` or `src/auth/`
  must keep every guarantee listed in `SECURITY.md`, and the tests that prove them must
  still pass.
- **No new runtime dependencies without a reason.** The core loop has none; browser
  discovery has Playwright. Tell us in the PR why a dependency earns its place.

## Tests

`node:test` via `tsx`, no framework. Browser tests spin up a local fixture server and a
headless Chromium; they never touch the internet. If you fix a navigator bug, add the
fixture HTML that reproduces it.

## Pull requests

- One change per PR, with a short description of the behaviour before and after.
- Run `npm run typecheck && npm test` locally; CI runs the same plus the demo.
- Keep the README's command examples true. If you change a flag, change the doc.

## Reporting a vulnerability

See `SECURITY.md`. Please don't open a public issue for anything involving credentials,
session files, or a way to make the navigator take a mutating action.
