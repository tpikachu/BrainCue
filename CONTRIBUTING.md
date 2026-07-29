# Contributing to BrainCue

Thanks for wanting to help. BrainCue is a local-first desktop companion that
listens to the conversation you're in and contributes through a
screen-share-invisible overlay. That shape creates a few unusual rules — most of
this document is those rules, because they're the ones that aren't obvious from
reading the code.

## Read this first

In order — each answers a question the previous one raises, and together they
take about twenty minutes:

1. [`docs/00-VISION.md`](docs/00-VISION.md) — what we're building and why.
2. [`docs/10-ROADMAP.md`](docs/10-ROADMAP.md) — the big picture: release
   trains, milestones, and what is deliberately deferred.
3. [`docs/BOARD.md`](docs/BOARD.md) — **the shared board**: which release is
   being built *right now*, milestone by milestone. Check it before proposing
   or picking up work, so you don't build what's already in flight.
4. [`docs/README.md`](docs/README.md) — the map of the design docs. The "How
   v2 works" section is essential before touching any shared path.

## Where work comes from

Three layers, one direction of flow:

- **Roadmap** — the big picture. Enhanced at release boundaries; changing it
  is a proposal, not a PR.
- **Board** — the current train. Every in-flight milestone has a row; a PR
  that starts, finishes, or drops one updates its row **in the same PR**.
- **Changelog** — the record, written only when a release ships.

**To propose a feature or enhancement:** open a
[feature request issue](https://github.com/tpikachu/BrainCue/issues/new/choose)
*before writing code*. Say which roadmap milestone your idea serves — or make
the case for changing the roadmap; "neither" is usually a sign it belongs in
*Deferred*. A maintainer triages it: accepted proposals get the `accepted`
label, a version milestone, and (if scheduled for the current train) a board
row. Then it's ready to build against.

**Labels and milestones:** `kind:*` says what an issue *is* (bug, feature);
`triage` → `accepted` / `blocked` say where it stands; `bounty:*` and `eval:*`
belong to the GitTensor pipeline below — don't set them yourself. Version
targeting uses GitHub **milestones** (v2.2.0, …), which close when the train
ships. There are no priority labels: the board's ordering is the priority.

## Getting set up

**Prerequisites:** Node **20.11+** (declared in `engines`; `.nvmrc` matches),
network access for the Electron binary download during install, and — only when
npm has no prebuilt better-sqlite3 for the pinned Electron — a C++ toolchain
for the source rebuild (Windows: Visual Studio Build Tools + Python; macOS:
Xcode Command Line Tools).

```bash
npm install               # also rebuilds better-sqlite3 for Electron's ABI (postinstall)
npm run dev               # launch with HMR across all three processes
```

That's the whole setup. Do **not** run `npm run db:generate` here — every
migration is committed under `drizzle/` and the app applies them itself on
launch; `db:generate` is only for after you edit `schema.ts` (see Data below),
and running it on a fresh clone risks committing a spurious migration.

An OpenAI key is **optional** for development: copy `.env.example` to `.env`
and fill in `OPENAI_API_KEY`, or set it later in Settings, where it is
encrypted by the OS keychain.

**What you should see:** the app opens on a "Welcome to BrainCue" screen that
asks for a profile name — click **Load sample data** instead for a ready-made
world: seven Spaces across five activities and five finished conversations
waiting to be kept. Everything except live transcription and answer generation
works with no API key at all.

Use `npm run dev` rather than calling `electron-vite` directly — the wrapper in
`scripts/run-electron-vite.mjs` strips `ELECTRON_RUN_AS_NODE` and normalises a
lowercase Windows drive letter, which otherwise causes a confusing transient
Rollup build error.

## The gate before you push

```bash
npm run typecheck   # node + web tsconfigs
npm run test        # vitest
npm run build       # typecheck + bundle
```

All three must be clean. `npm run build` is the one that catches packaging-level
mistakes, so don't skip it because the tests passed.

## Ground rules

**Branch, then PR. Never commit to `master`.** Every change lands through a pull
request, including docs-only ones.

**Don't bump the version or add a changelog entry** unless you are explicitly
cutting a release. `changelog/<semver>.md` files drive both the in-app "What's
New" screen and `APP_VERSION`, so a stray entry ships a phantom release.

**Docs lead code.** If your change alters behaviour described in `docs/`, update
that document in the same PR. Substantial work also gets a note in
`docs/sessions/` (one file per day).

## Architecture you need to know before your first PR

Three processes, one renderer bundle: **main** (`src/main`), **preload**
(`src/preload`), **renderer** (`src/renderer`). A single `index.html` renders one
of three views chosen by a `?view=` query param — `dashboard`, `overlay` (the Cue
Card), and `selection` (region capture).

### IPC is a contract — follow it exactly

Adding an IPC means all four of these, in order:

1. Add the channel/event name to the `IPC` / `EVENTS` constants in
   `src/shared/ipc.ts`. **Never hardcode a channel string.**
2. Register a handler with `handle(channel, zodSchema, fn)` in
   `src/main/ipc/*.ipc.ts`. It validates input with zod and returns a uniform
   `Result<T>` envelope; errors are normalised and redacted, never thrown across
   the wire.
3. Expose a method on the typed `window.api` facade in `src/preload/index.ts`,
   which unwraps the envelope so renderer code uses ordinary `try`/`catch`.
4. For main → renderer pushes, use `broadcast(EVENTS.x, payload)` and subscribe
   with `api.events.onX(cb)` (it returns an unsubscribe function — call it).

The renderer must never touch `ipcRenderer` directly.

### Data

better-sqlite3 + Drizzle. The schema lives in `src/main/db/schema.ts` and is
reached **only** through repositories in `src/main/db/repositories/*.repo.ts`.

After editing the schema, run `npm run db:generate` and commit the generated
`drizzle/*.sql` plus the `drizzle/meta` snapshot.

> ⚠️ If you add a column to `sessions` or `chunks`, you must also add it to the
> DDL in `src/main/db/fkRebuild.ts`. That rebuild recreates those tables after
> migrations run, so a column it doesn't name is silently dropped on fresh
> installs. `fkRebuild.test.ts` enforces this — if it fails, that's why.

Any list that can grow needs server-side pagination (`LIMIT`/`OFFSET` + count) —
see `jobsRepo.page()`.

### Modes are configuration, never a fork

A mode (interview, meeting, companion, …) is a `ModeDefinition` over one shared
engine in `src/main/services/engine`. If a mode needs something the engine can't
express, **extend the engine** — don't special-case inside the mode. This is the
rule that keeps six modes from becoming six forked products, and reviews enforce
it.

## Invariants you must not break

These aren't style preferences — breaking one is a security or privacy
regression:

- **The API key lives only in the main process.** IPC returns booleans or data,
  never the key. The renderer learns `apiKeyPresent` and nothing more.
- **Nothing captures before an explicit start.** The start flow shows the user
  exactly what will be captured and what leaves the machine; keep those strings
  honest when the pipeline changes.
- **No native `<select>`, and no native `title` tooltips, in app windows.** Both
  render as separate OS windows that are *not* covered by Privacy Mode's
  screen-capture exclusion, so they stay visible in a screen share even when the
  app is hidden. Use the in-window `Dropdown`/`Select` and the `TooltipShield`
  from `src/renderer/components/ui.tsx`.
- **Memory is approval-gated.** Only memories the user has approved are ever
  recalled. Don't add a path that recalls unapproved content.

## Style

Match the surrounding code. The shared UI kit (`src/renderer/components/ui.tsx`)
and the generic `DataTable` exist to be reused — reach for them before rolling a
new one. Path aliases `@shared`, `@main`, `@renderer` are set up; shared types
belong in `src/shared/types.ts`.

Comments should explain *why*, especially where the reason is non-obvious (an OS
quirk, a race, a deliberate ordering). The codebase leans that way; please keep
it there.

## Tests

There are two suites, and they exist for one reason: the app's better-sqlite3
is rebuilt for **Electron's** ABI (the `postinstall`), so it cannot load under
plain Node — which is what vitest runs on.

- **Unit tests** — `npm run test` (single file:
  `npx vitest run src/path/to/x.test.ts`). Anything touching the database uses
  the harness in `src/main/test/dbHarness.ts`: `createTestDb()` runs the real
  Drizzle migrations on **sql.js** (WASM SQLite, dev-only), so repository and
  engine tests exercise the real schema anywhere. If you reach for
  better-sqlite3 in a test and hit an ABI error, this is why.
- **End-to-end tests** — `npm run test:e2e` (builds first) or
  `npm run test:e2e:only` (reuses the last build). They drive the **built**
  Electron app over CDP; see [`e2e/README.md`](e2e/README.md), which also
  documents how the README and landing-page media are captured.

Pure logic (trigger policies, cost accounting, personas, migrations) is unit
tested and should stay that way — it's what lets the engine change safely.

**Mutation-check tests that guard an invariant:** break the invariant on
purpose (remove the gate, flip the condition), confirm your test fails, then
restore it. A test that cannot fail is worse than no test; several shipped
tests here record exactly that discovery. Say in the PR which mutant your
test kills.

## Pull requests

- One logical change per PR; keep unrelated refactors out of it.
- Explain **why** in the description, not just what — the diff already says what.
- Say what you ran and what you couldn't (e.g. "no macOS machine, Windows only").
- Screenshots or a short clip for UI changes are very welcome.

## Contributing via GitTensor (Bittensor SN74)

BrainCue is preparing for listing as a GitTensor master repository — merged
PRs here would earn TAO for registered miners. Until listing lands this
section is forward-looking, but the workflow below is already how the repo
runs, and it is designed around how SN74 actually scores
([docs/13-GITTENSOR.md](docs/13-GITTENSOR.md) has the full mechanics):

- **Start from an issue — enforced.** Your PR body must contain
  `Closes #<issue>` or the intake gate (a required check) fails; fixing the
  description re-runs it, no push needed. Prefer maintainer-labeled
  `bounty:*` issues: they carry SN74's maintainer-issue multiplier (×1.66)
  and they're the work we will actually merge. Unsolicited scope has the
  highest close risk, and closed PRs damage your credibility ratio (the 0.80
  eligibility floor).
- **Approval is the merge.** When a maintainer approves your PR and the
  required checks are green, it merges automatically (native auto-merge,
  armed on every PR) — no waiting on a second click.
- **Every PR is evaluated automatically** (see [eval/](eval/)): intake
  guards, a secret scan, unit coverage of your changed lines (advisory floor
  70%), and a rubric-pinned LLM review that scores eight dimensions with
  file:line evidence. The scorecard comment tells you exactly what to fix
  **before** a human reviews — bot feedback never counts as a "changes
  requested" review, so iterating against it is free.
- **We don't casually close PRs.** A failed evaluation gets `eval:needs-work`
  and a fix window; closes happen on abandonment or bad faith. Your
  credibility is safe with honest work.
- **One concern per PR**, ≤ 40 files / ≤ 2500 lines for external PRs, no
  binaries. Splitting one concern across many PRs to farm per-PR score is
  detected and collapsed.
- **Tests and docs pay here.** SN74's own token scoring underweights them
  (×0.05 / ×0.08), so we deliberately price them back in with labeled
  `bounty:test` / `bounty:docs` issues.

## Reporting bugs

Open an issue with your OS and app version (Settings shows it, and it's in the
sidebar), what you expected, what happened, and steps to reproduce.

**Found a security problem?** Please don't open a public issue — report it
privately through GitHub's
[security advisories](https://github.com/tpikachu/BrainCue/security/advisories/new).

## One more thing

BrainCue is built to be used where AI assistance is permitted. Please don't send
contributions whose purpose is to defeat a platform's rules or to hide the
assistant from someone who has a right to know it's there — screen-capture
exclusion exists so your own notes stay yours, not to deceive.
