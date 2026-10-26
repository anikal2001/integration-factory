# Benchmark: factory-produced integrations vs hand-built ones

Status: design, 2026-10-25. Nothing here is built. This document is marketplace-neutral and host-neutral; a host (the private repo that depends on this package) supplies the contract binding, the reference adapter, the test account and the fixture products, and keeps its own per-site plan.

## 1. Question the benchmark answers

For one site and one host contract, how close does the factory chain get to a hand-built integration, at what cost, and how fast does it recover after the site changes?

Two subjects run the same suite:

- **reference** — the host's hand-built adapter for the site. It is the oracle for fidelity and the baseline for every other number.
- **candidate** — whatever the factory chain produces for the same site and contract. Today the chain is `onboard` (discovery docs + endpoints) → `orchestrate` (scaffold + agent) → an agent finishing the adapter. Every stage is part of the subject; the benchmark records which stage produced each artifact and how much human help each stage needed. A candidate that is "just the scaffold" scores coverage 0 and that is the honest "before" number.

Both subjects are addressed through one **binding**: a thin host-written object that maps the host contract to the benchmark operations below. The suite never imports the host contract directly.

## 2. Benchmark operations

The binding exposes these operations; a binding reports `unsupported` for any the subject does not implement, and the suite scores that as not covered (never as a failure of a run).

| op | effect | source in a typical host contract |
|---|---|---|
| `session.check` | read | checkSession / session reader |
| `listing.get` | read | getListing |
| `listing.status` | read | getListingStatus |
| `listing.page` | read | getListingsPage (newest first, cursor) |
| `listing.import` | read | importListing |
| `listing.url` | pure | buildListingUrl |
| `listing.create` | write | createListing |
| `listing.update` | write | updateListing |
| `listing.delist` | write | delistListing |
| `listing.relist` | write | relist.capture + relist.publish, or createFromEndedListing |
| `orders.pull` | read | pullOrders / getSoldListings |
| `offers.*` | read/write | OfferOps members, one op per member |
| `settings.infer` | read | inferSettings |
| `taxonomy.map` | pure | category / size mapping for one product |

Hosts extend the table; every op carries `effect: read | write | pure` because the suite's mutation budget and safety score depend on it.

## 3. Dimensions and formulas

All scores are computed by the runner from recorded evidence. No model is involved in scoring.

| dimension | formula | notes |
|---|---|---|
| **coverage** | covered ops / contract ops, reported per group (required, optional, capability props, offers) and combined | covered = binding does not report `unsupported` **and** at least one conformance case for the op passes. A throwing stub is not covered. |
| **correctness** | passed cases / run cases, per op and overall; replay and live reported separately | replay = sanitized recorded HTTP; live = test account. Cases come from `test/cases.json`. |
| **fidelity** | matched fields / compared fields over the fixture product set | For `listing.create` + `listing.get`: candidate readback vs reference readback of the same source product (reference = 100 % by definition). For `listing.import`: normalized product vs the known source product, both subjects scored against the source. Field list fixed per host; nulls on both sides count as matched, null on one side counts as mismatched. |
| **robustness** | passed scenarios / scenarios | Fixed scenario list, mostly replay: session reuse across two runs, expired session → typed failure, 401, 403 challenge, 429, error envelope inside HTTP 200, pagination reaches terminal, empty account, second scan yields no duplicates, write failure after draft → cleanup. Hosts add site-specific scenarios. |
| **safety** | pass/fail gates, not a ratio | unintended writes = 0 (every write op call matched to a budgeted step); mutation budget respected (1 create, 1 delist, 1 relist, 1 cleanup per live run unless the host raises it); cleanup verified by readback; no secret-shaped values in anything under `<integration>/`. Any failed gate fails the run. |
| **cost** | per stage: wall-clock s, model tokens in/out, model spend, human interventions, live mutations consumed; plus adapter LOC and test LOC | Interventions are counted from `input_required` events (factory) or from a manual log (reference). |
| **repair** | wall-clock and spend from "site changed" to "suite green again" | Simulated by mutating replay fixtures (renamed field, new required field, changed path) and real when a site actually changes. Reference repair time comes from the host's git history for the matching fix. |

A comparison report is one table: dimension × {reference, candidate}, plus the per-op coverage/correctness table and the scenario table.

## 4. Fixtures and live split

- **Replay**: sanitized recorded HTTP for every read op and for the write ops' request shapes. Recorded once per subject with a recorder in the binding (the reference adapter's HTTP client wrapped; the factory's HAR capture for the candidate), scrubbed with the same `privacy/har-scrubber`, stored under `<integration>/test/fixtures/`. Replay runs in CI with no network and no model key.
- **Live**: a test seller account on the site, a fixed fixture product set (5–8 products chosen to hit the host's field edge cases: multi-colour, one-size, size systems, max photos, non-JPEG image, long description), and the canary from the agent spec: snapshot → create one tracked draft → submit once → independent readback → delist → verify gone → relist → readback → final cleanup. Live runs are opt-in, need the account and a human on call, and consume the mutation budget. Reads (orders, sold, offers status) are live but never fabricate a sale.

Both subjects run the same suite build; nobody weakens an assertion to make a subject pass.

## 5. Evidence

Each run writes `evidence/benchmark.json`:

```
{ schemaVersion: 1, subject: "reference"|"candidate", site, host, contractVersion,
  subjectSha, suiteSha, startedAt, mode: "replay"|"live",
  chain?: [{ stage: "onboard"|"mint"|"agent"|"manual", sha?, wallClockS, tokensIn, tokensOut, spendUsd, interventions }],
  coverage: { required: {n,d}, optional: {n,d}, props: {n,d}, offers: {n,d}, combined: {n,d} },
  ops: [{ op, effect, covered, cases: {run, passed}, mode }],
  fidelity: { products, fieldsCompared, fieldsMatched, mismatches: [{ product, field, expected, actual }] },
  scenarios: [{ name, passed, failure? }],
  safety: { unintendedWrites, budget: { create, delist, relist, cleanup }, cleanupVerified, secretsFound },
  cost: { wallClockS, spendUsd, interventions, liveMutations, adapterLoc, testLoc },
  repair?: { trigger, wallClockS, spendUsd } }
```

The comparison report is generated from two such files. Numbers in prose are never typed by hand.

## 6. Where it lives

- This package: `src/testing/` (exported as `./testing`): the runner, op table types, scoring, scenario runner, fixture recorder/replayer, `benchmark.json` schema and the comparison report. Fixture site for the package's own tests: the fake marketplace from the phase-2 test plan.
- The host (private): the binding, the reference adapter, the test account, fixture products, site-specific scenarios, and the per-site plan with recorded numbers.

## 7. Order of work

The suite comes before any minter rebuild, because its first job is to put a number on today's factory.

1. Build `src/testing/` against the fake marketplace (replay only). Done: runner produces `benchmark.json` for the fake reference; CI replays with no network.
2. Host writes the binding for its reference adapter and records replay fixtures. Done: reference `benchmark.json`, replay mode, every required op covered.
3. Run today's factory chain on the same site and bind the result. Done: candidate `benchmark.json` for the "before" row, with the chain stages and interventions filled in.
4. Live run of both subjects on the test account, one canary each. Done: live `benchmark.json` for both, safety gates all pass.
5. Re-run step 3 after each SPEC phase that touches the minter or runtime; the row history is the progress chart.

Done check for this document: steps 1–3 recorded for one site, comparison table generated, numbers copied nowhere else.
