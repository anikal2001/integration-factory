# acme-billing (sample target repo)

A tiny fictional payments service used by `npm run demo` and the tests. It shows the
three things a codebase needs before integration-factory can build into it:

1. **A contract** — `src/payments/IPaymentProvider.js` and `BaseProvider.js` define what
   every provider implements.
2. **A profile** — `integration-factory.json` tells the orchestrator where new providers
   go, which template to render, how to register them, and how to verify the change.
3. **A verify gate** — `scripts/check-providers.mjs` fails when a provider breaks the
   contract. That exit code is what stands between the agent and a PR.

The demo copies this directory into a temp git repo, so nothing here is modified.
