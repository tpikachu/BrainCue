# BrainCue documentation

The design documents that drive development. BrainCue is docs-driven: these are
the source of truth the implementation follows, not a write-up produced after
the fact.

📖 Rendered as a site at **<https://tpikachu.github.io/BrainCue/>**
(built from this folder — see [`../.github/workflows/pages.yml`](../.github/workflows/pages.yml)).

## Start here

| Doc | What it covers |
| --- | --- |
| [00 · Vision](00-VISION.md) | The north star: from interview copilot to ambient conversational companion, the mode catalog, and the product principles. |
| [01 · PRD](01-PRD.md) | The product spec: domain model, the engine, and per-mode requirements. |
| [10 · Roadmap](10-ROADMAP.md) | Phases as release trains, what lands when, and the development rules. |

## Architecture

| Doc | What it covers |
| --- | --- |
| [02 · Architecture](02-ARCHITECTURE.md) | The three processes, data flow, and module boundaries. |
| [12 · Engine plan](12-ENGINE-PLAN.md) | The six-stage pipeline (sources → transcription → trigger → grounding → generation → surfaces) that every mode configures. |
| [03 · Windows](03-WINDOWS.md) | Main, renderer, and the capture-excluded overlay window. |
| [11 · UX & navigation](11-UX-NAVIGATION.md) | The mode-first layout: Home as launcher, modes as cards. |

## Reference

| Doc | What it covers |
| --- | --- |
| [04 · Database](04-DATABASE.md) | Schema, context packs, and the migration story. |
| [05 · IPC map](05-IPC-MAP.md) | Every channel and event across the renderer/main bridge. |
| [06 · Provider services](06-OPENAI-SERVICE.md) | Transcription, answers, embeddings, and speech behind the provider seam. |
| [07 · API key security](07-API-KEY-SECURITY.md) | Where the key lives, and why it never reaches the renderer. |
| [08 · Folder structure](08-FOLDER-STRUCTURE.md) | Where code goes and why. |

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

`media/` holds the demo GIFs and video used by the landing page and the root
README. See [`../e2e/README.md`](../e2e/README.md#capturing-marketing-media) for
how those assets are produced.
