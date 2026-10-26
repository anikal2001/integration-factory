# SPEC: integration-factory as a module

Status: draft for approval, 2026-10-25. No code has changed. Design rationale and every Pomerado pointer are in `docs/design/pomerado-notes.md`; this file is the plan.

## Goal

Turn `integration-factory` from two tsx CLIs into one installable package with the Pomerado triangle: a **versioned artifact contract**, a **model-free runtime** that executes it, and a **reviewed minter** that produces it — driven through a **job model** over CLI, MCP and a library API. Keep what already beats Pomerado: human-assisted login with session persistence, proxy/Browserbase, provider-neutral models, sandbox + verify + PR, target-repo profiles, Windows support.

Non-goals for this spec: hosted service, multi-tenant queue, captcha solving, Effect adoption, replacing Zod.

## Target package

```
package.json   name integration-factory, type module, engines node >=22
               bin: integration-factory (cli), integration-factory-mcp (stdio)
               exports: ".", "./runtime", "./mcp", "./authoring/*", "./core/*", "./testing/*"
               "integrationFactory": { "hostProtocol": 1 }
src/
  runtime/     contracts, run-outcome, failures, questions, commit, deadline, job-store,
               execute-skill, execute-operation, define-operation      (model-free)
  site/        login (from auth/login.ts), login-fields, challenge, sign-in-recipe, signed-in-marker,
               verification (manual, imap)
  browser/     providers (local, persistent-local, browserbase), proxy, page helpers
  execution/   sandbox (local worktree, attach, daytona), child-process operation runner, boundary errors
  mint/        harness (turn loop), tools, navigator (plan-driven), capture, extract, live-tests,
               publication, outcome
  review/      kinds, decisions, execution-policy, publication, model slot
  models/      models.ts (slot → id, the only file naming ids), client (OpenAI-compatible, Anthropic, mock),
               observer, failure, retry
  inputs/      askers: terminal, callback, mcp(job), secrets registry
  privacy/     credential-policy (pure), har-scrubber, state-store (encrypted storageState + expiry)
  artifact/    schemas (zod → JSON Schema), read/write/validate, canonicalise
  profile/     profile, target, plan (existing), schemas
  hosts/       cli, mcp-server, mcp-jobs, library (createFactory)
  local-features.ts
authoring/     skills/<name>/SKILL.md, plans/*.json, review/POLICY.md, workspace/AGENTS.md
test/          fixtures (fake marketplace, fake login, challenge, imap), unit, contract tests
docs/          how-it-works.md, design/pomerado-notes.md
```

Module boundary rule (enforced by a test that greps imports): `runtime/` imports nothing from `mint/`, `review/`, `hosts/`; `models/` is imported only by `mint/` and `review/`; `privacy/credential-policy.ts` has no imports. Inside every module: `types.ts`, `*.utils.ts` (pure), services (I/O).

## Artifact contract (v1)

```
<integration>/
  integration.json   { name, site, version, contractVersion: 1,
                       operations: [{ name, effect: "read"|"write", input, output (JSON Schema, refs inlined),
                                      declaredQuestions: InputRequest[], acceptedConfirms: string[],
                                      writeDeclaration?: { commitMarks: string[], confirmation: "message"|"readback"|"unverifiable" } }] }
  sign-in.json       { recipeVersion: 1, loginUrl, selectors?, successSelector?, verification: "none"|"code"|"human" }  – value-free
  skills/*.json      promoted extension Skill schema + { skillVersion: 1 }
  src/*.ts           optional; may import only "integration-factory/runtime"
  discovery/         endpoints.json, navigation.json, memory.json, plan.json – each { schemaVersion }
  test/cases.json    [{ operation, input, expect: { status?, outputMatches?, commitMark? } }]
  evidence/          review.json (decisions), coverage.json, canary.json, privacy.json
  .jobs/             { key, inputDigest, jobId, status, failedOutcome, commitMarks } – never input/output
```
Loader: `readIntegration(dir)` validates every file with Zod and refuses `contractVersion`/`recipeVersion`/`skillVersion` newer than the runtime. Private per-job area (outside the directory): encrypted `storageState`, scrubbed HAR, raw captures; retention 1 day default.

## Job model

`startJob(kind: "mint"|"run"|"onboard", request) → { jobId }`; `getJob(jobId, waitSeconds ≤ 30)`; `provideInput(jobId, requestId, answers)`; `cancelJob(jobId)`. States: `running | input_required | succeeded | failed | cancelled`. One job dir per job with a stage checkpoint (`auth | capture | extract | write | review | publish`), so a killed process resumes at the checkpoint with the saved session. Idempotency: same key + same input digest rejoins, different digest refuses. Pending question expiry 10 min; finished record 15 min in memory, 1 day on disk.

Question types: `credential {username, password, saveLogin}`, `verification_code`, `confirm`, `choice`, `text`, `challenge_handoff { headed: true | liveViewUrl, expiresAt }` (answer `{ resolved: true }`). The manual-assist loop in `login()` becomes: detect challenge → emit `challenge_handoff` → suspend the deadline → wait for the answer or expiry → re-check `loginComplete` → persist session.

## Runtime outcomes

Copy the Pomerado classifier verbatim as data: 10 outcome codes × retry class (`never|fix_input|same_key|new_key`) × `WriteStatus` (`not_attempted|may_have_applied|applied|not_applied`). Typed failures: `ChallengeFailure`, `AuthRequired`, `CredentialsRejected`, `RateLimited`, `BudgetExhausted`, `LossOfGrounding`, `InvalidInput`, `InvalidOutput`, `WriteConfirmationRefused`, `CommitAlreadySent`, `DeadlineExceeded`, `BrowserFailure`. Each has `code`, archive-only `detail`, and a renderer hook for public text. A write is `applied` only by a recorded commit mark or readback match.

## Minter and reviewer

One turn loop (`mint/harness`) over `ModelClient` with purpose-tagged executions `explore|authenticate|capture|test|act|inspect` and a tool set assembled from host hooks: `read_source, execute, request_input, task_update, report_blocked, retain_capture, live_tests, finish_build` + sandbox tools `read_file, write_file, list_dir, exec, apply_patch`. Discovery (plan-driven navigator) runs as `explore|capture` executions; its `endpoints.json` is context for `act` code writing. `finish_build` is refused unless live tests pass ≥ 70 % and the coverage invariants from the agent spec hold.

`review/` runs inside `execute`, `request_input`, `task_update` and `finish_build`: decisions `allow|deny|escalate`, `allow_business|authentication|reword`, `allow|clarify|reword|new_mint`, `PublicationDecision|PublicationDenial{findings[file,line]}`. A denied call never reaches the site; a missing host hook is a refusal. The reviewer is a different model instance (slot `reviewer`), any provider. Publication policy is one string in `authoring/review/POLICY.md` read by both minter and reviewer. `local-features.ts` renders what this build cannot do into both contexts.

## Phases, each with its done check

| # | Phase | Work | Done check (proof shown in the PR) |
|---|---|---|---|
| 0 | Consolidate + package | Delete duplicated tree in `secnd/integration-orchestrator`, move Secnd bits to a `profiles/secnd.json` + private glue; add `bin`, `exports`, `dist` (tsc), semver, CHANGELOG, boundary test, "no real model in tests" rule, model-ids test; drop `../secnd-backend/.env` sourcing; drop `--no-verify` | `npm pack` installs globally on Windows + WSL; `integration-factory --help` and `integration-factory-mcp --help` run; CI green; `rg -i 'secnd\|vestiaire' src` empty |
| 1 | Artifact contract | `artifact/` Zod schemas + JSON Schema export + `readIntegration` validating loader + version refusal; promote extension `Skill` schema; versioned `discovery/*.json`; `onboard()` writes the directory | Contract tests: valid dir loads, each tampered file fails with the named field, newer version refused; `examples/` contains one complete integration dir |
| 1b | Conformance harness + benchmark | `src/testing/` (`./testing` export): op table, runner, scoring, scenario runner, fixture recorder/replayer, `evidence/benchmark.json` schema, comparison report; design in `docs/design/benchmark.md`. Runs before any minter work so today's chain gets a "before" number | Runner produces `benchmark.json` for the fake marketplace in replay mode with no network and no model key; a host binding for one real hand-built adapter yields a reference row and a candidate row from today's chain |
| 2 | Job model + MCP + resumable login | `runtime/job-store`, `hosts/mcp-jobs`, `hosts/mcp-server` (`mint, get_job, provide_input, cancel_job`), typed questions incl. `challenge_handoff`; `login()` emits questions instead of stdin/callbacks; stage checkpoints; `persistent-local` browser provider; `privacy/state-store` | Fixture tests: challenge page → `input_required` with `challenge_handoff` → `provide_input` → job resumes and succeeds; kill mid-capture → restart resumes at `capture`; 403/429/IMAP/manual-assist fixtures (none exist today); an MCP client script drives a full onboard of the fake marketplace |
| 3 | Deterministic runtime | `run-outcome`, `failures`, `commit`, `deadline`, `execute-skill` (HTTP replay + assertions), `define-operation`/`execute-operation` (child process), `serve --integration` with effect annotations | `integration-factory run` executes `test/cases.json` of the example integration with no model key; outcome classifier unit tests cover all 10 codes; write without recorded confirmation reports `may_have_applied` |
| 4 | Minter + reviewer | Single harness with purpose-tagged executions; prompts to `authoring/` with replaceable sections; `review/` with execution/question/publication kinds; `MintOutcome`; `local-features`; wire discovery into code writing; `models/` Anthropic client, observer, retry | Scripted-model test: a write `execute` denied by the reviewer never reaches the fixture server (asserted by request count); publication denial carries file/line findings; same POLICY string loaded by both; mint of the fake marketplace produces an integration dir that phase-3 runtime executes; benchmark candidate row re-run and compared with the phase-1b "before" row |
| 5 | Privacy + docs + release | HAR scrubber, encrypted storageState with expiry, `evidence/privacy.json`, gitleaks, `docs/how-it-works.md`, AGENTS.md, canary release workflow | Scrubber test: cookies/auth headers/set-cookie/token-shaped values absent from anything under `<integration>/`; first `0.x.0-canary.1` published with provenance |

Phases 0–1 are mechanical and low-risk; 1b is the measuring stick and must land before 3–4 so every later phase has a number to move; 2 is where the user-visible win (Cloudflare handoff over MCP) lands; 3–4 are the real build. Each phase is its own PR stack on a feature branch; nothing merges to `main` without approval.

## Open decisions (need an answer before phase 0)

1. **Package name and bin names**: `integration-factory` / `integration-factory-mcp` as above, or a shorter brand.
2. **Where Secnd glue lives**: DECIDED 2026-10-25 — a private repo that depends on this package. This repo stays free of Secnd strings; the Secnd profile, adapter stub, doc prose and Vestiaire CLIs move there, and `secnd/integration-orchestrator` is deleted once the private repo exists.
3. **Reviewer model**: default slot `reviewer` to Claude via the Anthropic client, or to the same OpenAI-compatible endpoint as the minter. Recommendation: Anthropic, since the minter can stay on whatever `MODEL_BASE_URL` points to and the two must differ.
4. **Python side-car** (`browser-use-adviser.py`): keep as optional adviser behind a hook, or drop. Recommendation: keep behind `local-features` until a TS equivalent exists.
5. **Daytona sandbox**: quarantine until it has a test (recommendation) or delete.
