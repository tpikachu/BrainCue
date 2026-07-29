# BrainCue documentation

The design documents that drive development. BrainCue is docs-driven: these are
the source of truth the implementation follows, not a write-up produced after
the fact.

📖 Rendered as a site at **<https://tpikachu.github.io/BrainCue/>**
(built from this folder — see [`../.github/workflows/pages.yml`](../.github/workflows/pages.yml)).

## Start here

| Doc | What it covers |
| --- | --- |
| [00 · Vision](00-VISION.md) | The north star: from interview copilot to ambient conversational companion, and the product principles. |
| [01 · PRD](01-PRD.md) | The product spec: domain model, the engine, and per-mode requirements. |
| [10 · Roadmap](10-ROADMAP.md) | Phases as release trains, what lands when, and the development rules. |
| [The current train](TRAIN.md) | The live board: which release is being built right now, milestone by milestone. Unnumbered because it changes every PR and resets every release. |

## How v2 works

The four docs that describe what the product **is** today. Read them in order —
each answers a question the previous one raises.

| Doc | What it covers |
| --- | --- |
| [18 · Activities](18-ACTIVITIES.md) | The one thing the user picks. Why the mode picker was deleted, how a mode is derived, and how a Space is a saved activity. |
| [17 · Spaces & profile](17-SPACES-AND-PROFILE.md) | What a Space is, what it holds, and where it sits relative to the profile. |
| [19 · Active profile](19-ACTIVE-PROFILE.md) | One profile at a time: how the whole dashboard is scoped, and where that is resolved. |
| [16 · Continuity](16-CONTINUITY.md) | The two things BrainCue keeps — a conversation's summary and long-term memory about you — how they differ, and why a Space is the only place either is kept. |
| [14 · Long-term memory](14-MEMORY.md) | How memory is stored, scoped, consented to, and retrieved — including why recall runs a lexical path alongside the semantic one, and what is still missing. |

## Architecture

| Doc | What it covers |
| --- | --- |
| [02 · Architecture](02-ARCHITECTURE.md) | The three processes, data flow, and module boundaries. |
| [12 · Engine plan](12-ENGINE-PLAN.md) | The six-stage pipeline (sources → transcription → trigger → grounding → generation → surfaces) that every mode configures. |
| [03 · Windows](03-WINDOWS.md) | Main, renderer, and the capture-excluded overlay window. |
| [11 · UX & navigation](11-UX-NAVIGATION.md) | The layout: Home as launcher, the one start flow, and the split between global and profile-scoped navigation. |

## Reference

| Doc | What it covers |
| --- | --- |
| [04 · Database](04-DATABASE.md) | Schema, context packs, and the migration story. |
| [05 · IPC map](05-IPC-MAP.md) | Every channel and event across the renderer/main bridge. |
| [06 · Provider services](06-OPENAI-SERVICE.md) | Transcription, answers, embeddings, and speech behind the provider seam. |
| [07 · API key security](07-API-KEY-SECURITY.md) | Where the key lives, and why it never reaches the renderer. |
| [08 · Folder structure](08-FOLDER-STRUCTURE.md) | Where code goes and why. |
| [21 · Media](21-MEDIA.md) | The demo film, the GIFs and the screenshots: the storyboard, the style rules, how they are captured from the real app, and the checklist before any of it ships. |

## Process & history

| Doc | What it covers |
| --- | --- |
| [13 · GitTensor plan](13-GITTENSOR.md) | Bittensor SN74 listing plan and the automated PR evaluation pipeline (scoring, anti-gaming, roadmap). |
| [Session log](sessions/README.md) | The running development diary — one file per day. |
| [09 · MVP plan](09-MVP-PLAN.md) | Historical: the record of the shipped v1 build. |
| [Changelog](../changelog/) | What shipped in each release (also drives the in-app "What's New"). |

## Conventions

- **Numbered prefixes are stable.** `NN-NAME.md` — the number is the doc's
  identity; renumbering breaks inbound links, so new docs take the next free
  number rather than inserting.
- **Docs lead code.** A feature updates its design doc in the same PR that
  implements it; `docs/sessions/` records what actually happened that day.
- **Links are relative** (`[Roadmap](10-ROADMAP.md)`) so they resolve both on
  github.com and on the built site, where they are rewritten to `.html`.

## Media

`media/` holds the demo film and the GIFs; `images/` holds the screenshots. Both
are used by the landing page and the root README, and both are recordings of the
real app — nothing is mocked up in a design tool.

```bash
npm run media          # capture everything, then build everything
```

[**21 · Media**](21-MEDIA.md) is the guide: the storyboard, the style rules,
what every asset is for, and what has to be true before any of it ships.
