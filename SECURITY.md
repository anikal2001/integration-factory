# Security

## Reporting

Please report vulnerabilities privately to the maintainers (open a GitHub security
advisory on this repository, or contact a maintainer directly) rather than filing a
public issue. Include reproduction steps and the version or commit. We aim to
acknowledge within a few days.

## What this tool touches

integration-factory runs an LLM agent inside a **sandboxed checkout of your repo** and,
optionally, drives a **real browser on an account you control**. Both deserve a threat
model. This is ours.

### The agent loop

- The model acts only through five primitive tools (`read_file`, `write_file`,
  `list_dir`, `exec`, `finish`) bound to a sandbox. `exec` runs a shell in that
  sandbox; with the `local` provider that is a git worktree **on your machine**. Treat
  a real model run like running a contributor's script: use a throwaway checkout, and
  prefer a cloud sandbox for untrusted repositories.
- File contents the model reads are data, not instructions. The playbook says so, but
  prompt injection through repo contents is a real risk. Do not point the agent at
  repositories you don't trust.
- PR creation is dry-run by default. `OPEN_PR=true` pushes and calls `gh`; the branch
  is always a new one, and the verify command must exit 0 first.

### Browser discovery

Hard guarantees, enforced in code and covered by tests:

- **Read-only.** The navigator never publishes, saves, submits a form, deletes,
  purchases, pays, ships, sends or accepts offers, or changes account settings. Labels
  matching those actions are excluded before scoring, whatever the plan says.
- **One verified action at a time.** Every click must produce an observable
  postcondition (URL, visible UI, or first-party network response). Unexpected scrolling
  is reverted and treated as loss of grounding, which is terminal.
- **Stops on friction.** HTTP 401/403/429, a CAPTCHA or browser challenge, an expired
  session (refreshed at most once), or a spent interaction budget ends the run.
- **Login submits each stage once.** A repeated form is a failure, not a retry, so a
  wrong password never becomes a lockout.
- **No bot-detection evasion.** A headless browser that is challenged hands off to a
  human at a visible browser. Residential proxies are supported only for targets whose
  terms permit it; a CAPTCHA is never solved automatically.
- **The visual adviser cannot act.** It returns one proposed label; Playwright resolves,
  safety-checks, and executes it independently, and it is disabled on authentication,
  payment, or identity pages.

### Secrets and artifacts

- Credentials come from environment variables and are typed into the browser form only.
  They are never written to disk or logged.
- `storageState.json` (cookies + localStorage) and `*.har` (full request/response
  bodies, including tokens) are written under the output directory and are gitignored.
  **Never commit them.** The onboard PR carries a sanitized endpoint list only: URL
  templates with ids and query values redacted, and JSON *shapes* (keys and types), never
  values.
- Log lines and reports scrub email addresses and token-shaped strings.

### Your responsibilities

Use a test account the target has approved for automation, comply with its terms of
service, and keep the interaction budgets conservative. No automation can guarantee a
third party will never restrict an account.
