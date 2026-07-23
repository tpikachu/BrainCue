# Security Policy

BrainCue is a local-first desktop app whose security model is small and strict:
the API key lives only in the main process (encrypted at rest via the OS
keychain), the renderer is untrusted and reaches main only through a typed,
zod-validated IPC bridge, and app windows are excluded from screen capture in
Privacy Mode. Anything that weakens one of those invariants is a security bug,
even if nothing "crashes".

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via
[GitHub security advisories](https://github.com/tpikachu/BrainCue/security/advisories/new).
Include what you found, how to reproduce it, and what an attacker gains.

You can expect an acknowledgement within **72 hours** and a status update at
least weekly until resolution. Confirmed reports are credited in the release
notes unless you ask otherwise.

## Scope

In scope — anything violating the invariants in
[docs/07-API-KEY-SECURITY.md](docs/07-API-KEY-SECURITY.md) and
[CONTRIBUTING.md](CONTRIBUTING.md):

- API key reaching the renderer, logs, IPC payloads, or disk in plaintext
- IPC handlers reachable with unvalidated/forged payloads, or renderer code
  gaining main-process capabilities
- App content becoming visible to screen capture while Privacy Mode is on
  (including via native OS surfaces: dialogs, tooltips, popups)
- Unapproved memory content reaching prompts, or local data exfiltration
- Supply-chain issues in our build/release pipeline

Out of scope: vulnerabilities requiring an already-compromised machine,
social engineering, and issues in third-party services (report those upstream).

## Fixing security bugs

If you want to submit the fix as well: report privately first, then open the
PR once we've agreed on disclosure. Security fixes follow the normal
contribution gate (see CONTRIBUTING.md) plus a maintainer security review.
