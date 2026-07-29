# UX & Navigation

> Status: design set 2026-07-21; implemented as roadmap milestone 1.3. Spec:
> [01-PRD.md](./01-PRD.md) · Plan: [10-ROADMAP.md](./10-ROADMAP.md).
>
> **⚠ Two parts of this document are superseded — read this first.** The body
> below is written *mode-first*, and it no longer describes the shipped app:
>
> 1. **There is no mode picker.** The user picks an **activity** ("What's this
>    call?") and the engine derives the mode — [18-ACTIVITIES.md](./18-ACTIVITIES.md).
>    Where this file says "mode card" or "mode launcher", read *activity*.
> 2. **The profile is picked once, in the sidebar,** which splits the nav into a
>    profile-scoped group and a global one —
>    [19-ACTIVE-PROFILE.md](./19-ACTIVE-PROFILE.md).
>
> The full notices, with the reasoning, are at the end of this file. The
> problem analysis and the section structure in §§1–3 still hold, which is why
> the document is kept rather than rewritten.

## 1. The problem with the current layout

The sidebar ([App.tsx](../src/renderer/dashboard/App.tsx)) is a flat list where
**every activity is a nav item**, and every item is interview-shaped:

```
Profiles · Interview · Mock Interview · Sparring · Tailor Resume · Reports · Settings
```

Two structural problems:

1. **Chrome scales with modes.** v2 adds Interviewer Assist, Meeting Copilot,
   Tutor, Companion. As nav items that's an 11-entry sidebar; every new mode
   makes the app feel more cluttered instead of more capable.
2. **The vocabulary excludes every non-interview use.** "Profiles" means
   *candidates*, "Interview" is the only live session, and a utility (Tailor
   Resume) sits beside core activities as a peer.

## 2. Design principle

**Chrome scales with structure, not with modes.** The sidebar holds the four
durable *kinds* of thing — start something, your materials, what happened,
configuration — and modes live as **content** (launcher cards) inside them.
Adding a mode in Phase 2/3/4 adds a card, never a nav item.

## 3. Target information architecture

```
┌────────────┐
│ ⌂ Home     │  mode launcher + resume-last + status
│ ▤ Library  │  who you are + what it's about (profiles, context packs)
│ ▦ Reports  │  everything that happened, filterable by mode
│ ⚙ Settings │  + Providers (multi-AI) + Labs (experimental modes)
│ (⛁ DB dev) │  unchanged, dev builds only
└────────────┘
```

### 3.1 Home — "What are we doing?"

The default route. A grid of mode cards (from the mode registry, PRD §5), a
resume-last-session shortcut, and the readiness strip (key present · audio
source · privacy state — today's `SidebarStatus` content, promoted).

```
┌──────────────────────────────────────────────────────────┐
│  Ready: ● key · ● loopback · ● privacy      [Resume last]│
│                                                          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐         │
│  │ 🎤 Interview │ │ 🗣 Practice  │ │ 👥 Meeting   │         │
│  │  Copilot    │ │ mock · drill│ │  Copilot    │         │
│  └─────────────┘ └─────────────┘ └─────────────┘         │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐         │
│  │ 🪑 Interviewer│ │ 📚 Tutor    │ │ ✨ Companion │         │
│  │  Assist  🔜 │ │         🔜  │ │      (Labs) │         │
│  └─────────────┘ └─────────────┘ └─────────────┘         │
└──────────────────────────────────────────────────────────┘
```

A card opens that mode's **setup sheet** (shared component, per-mode fields:
profile → context pack → mode settings → Start) and lands in the Session view.
Unshipped modes render as visible-but-disabled teasers (🔜) or Labs-gated
cards — the catalog itself markets the widening.

### 3.2 Session — one live surface

The current `InterviewPage` splits into **SetupSheet** (opened from Home) and
**SessionView** (`/session`), the single live surface for every mode. The
transcript pane is universal; the contribution pane renders per-mode card types
(answer cue / suggested question / context / action item / tutor turn — PRD
§6.6). While a session is live, a pulsing **● Live** pill appears in the
sidebar above the nav (clicking returns to `/session`); `useLiveSession` being
global already makes this safe across navigation.

### 3.3 Library — who you are, what it's about

Two tabs, mapping the PRD §5 domain model:

- **Profiles** ("who you are") — today's `ProfilesPage`/`ProfileEditorPage`
  unchanged in function.
- **Context Packs** ("what it's about") — the generalized Jobs UI: one list,
  `kind` badges (job / subject / project / custom), kind-aware editor (a `job`
  pack keeps JD-link fetch + company research exactly as today).
- **Tailor Resume becomes a pack action**, not a nav item — it *is* a
  resume×JD operation, so it belongs on `job`-kind packs (button in the pack
  editor + a card in the pack list row). The page component survives nearly
  intact; only its entry point moves.
  > **Not shipped as described.** Tailor Resume is switched off behind
  > `FLAGS.jobSearch`; `/tailor` redirects to `/home`, there is no control in
  > the pack editor, and the row button is hidden. See
  > [20 · Quarantine](20-QUARANTINE.md).

### 3.4 Reports & Settings

- **Reports** — unchanged structure; adds mode filter chips (Interview ·
  Practice · Meeting · …) and per-mode report renderers (coaching report,
  meeting summary, evaluation draft, study progress).
- **Settings** — gains **Providers** (per-provider keys + per-capability
  model selection, PRD §6.7; today's single OpenAI key panel becomes the first
  entry) and **Labs** (experimental-mode flags, roadmap rule 3).

## 4. Route migration (nothing breaks)

Old routes keep working — tray/`onNavigate` deep links, the tour, and muscle
memory all survive via redirects:

| v1 route | v2 route | Notes |
| --- | --- | --- |
| `/` → `/profiles` | `/` → `/home` | new default |
| `/profiles`, `/profiles/:id` | `/library` (Profiles tab) | redirect |
| `/interview` | `/home?mode=interview` → setup sheet | redirect opens the card |
| `/mock`, `/sparring` | `/home?mode=practice` (variant preselected) | redirect |
| `/tailor` | switched off (`FLAGS.jobSearch`); route kept, redirects to `/home` | see [20](20-QUARANTINE.md) |
| `/reports`, `/settings`, `/whats-new`, `/dev` | unchanged | Settings gains sub-sections |
| — | `/session` | new: the shared live SessionView |

## 5. Overlay (Cue Card): explicitly unchanged

The overlay window, its IPC, hotkeys, privacy/affinity behavior, and the
selection window are **not** touched by this redesign — parity gate. Its card
*types* extend per mode (PRD §6.6), which is content inside the existing
window, not window/layout work.

## 6. Execution order (inside milestone 1.3)

> **Status (2026-07-22, Spaces-UX PR):** steps 1, 2, and 4 are DELIVERED —
> Home is the universal launcher ("How can BrainCue help right now?" +
> primary actions + status chips + recents + flag-gated Labs strip), the
> Library merged Profiles/Spaces/Documents under `/library` tabs (jobs UI
> lives in the Spaces tab; Tailor is switched off — [20](20-QUARANTINE.md)),
> the sidebar is
> Home/Library/Sessions/Insights/Settings, and the Tour was rewritten. The
> shared start flow shipped as `StartSessionModal` (activity → Space → source →
> transparency summary → explicit start); flags live in `src/shared/flags.ts`.
> Step 3 (full SessionView extraction from InterviewPage) is deferred — the
> interview workspace stays intact partly because the privacy hard test pins
> its profile-select → "Interviews" flow; revisit when Meeting lands.
>
> **Since then:** Meeting Copilot and Companion graduated from the Labs strip
> to real launcher cards (Labs-badged, opening the start flow); "Talk to
> BrainCue" joined the primary actions when voice shipped; the Memory tab
> landed in Library. The start modal now lists gated modes (Interviewer
> Assist, Tutor) as disabled **"Coming soon"** entries instead of hiding them.
> Settings gained the **Providers** signpost card (per-capability view, planned
> providers marked Coming soon) and the Companion prefs card. The first-run
> Tour was rewritten again for the full current catalog — meeting, companion,
> voice summon, review-first memory — with `data-tour` anchors on the
> meeting/companion cards.

Each step lands green on the parity gate:

1. **Home + collapsed sidebar.** Add `/home` with cards for the *existing*
   flows (Interview, Practice variants, Tailor as a "tools" row); sidebar
   becomes Home/Library/Reports/Settings; add redirects; drop the "Copilot"
   subtitle under the brand ([App.tsx](../src/renderer/dashboard/App.tsx)).
   Card-launched pages (`/interview`, `/mock`, `/sparring`, `/tailor`) have no
   sidebar entry, so they get a **"← Home / ‹mode›" breadcrumb bar** and keep
   the Home nav item highlighted — they read as *inside* Home, never orphaned.
   The breadcrumb is the interim way back until the SetupSheet (step 3)
   replaces full-page navigation for setup.
2. **Library merge.** Profiles + Jobs UIs under `/library` tabs (rename +
   re-parent, no behavior change; packs still `kind='job'`-only until schema
   milestone 1.1 lands the other kinds).
3. **SessionView extraction.** Split `InterviewPage` into SetupSheet +
   SessionView; add the sidebar Live pill.
4. **Tour + copy rewrite.** New `TOUR_STEPS` targeting the four-section nav
   (`data-tour` attrs move with the items); Home replaces "Interview" as the
   tour's centerpiece. Feeds milestone 1.4.

Phases 2–4 then only *add cards and card types*: Meeting/Interviewer cards
(P2), Tutor card + voice controls in SessionView (P3), Companion card + Memory
tab in Library (P4 — the one planned nav-adjacent addition, as a Library tab,
not a sidebar item).

## 7. Open questions

- Home naming: "Home" vs "Start". (Current lean: Home — it also hosts status.)
- Does Practice deserve its own card or live as a toggle on each mode's card
  ("live / practice")? Current lean: own card now (it's shipped and loved),
  revisit when Tutor absorbs the drill loop in 3.2.
- Where does the readiness strip live long-term — Home only, or persistent in
  the sidebar footer as today (`SidebarStatus`)? Current lean: both, same
  component.

> **Superseded (2026-07-28): the mode picker is gone.**
> This document is written mode-first, and the start flow's first step is no
> longer a mode. Choosing a mode AND a Space kind was the same question asked
> twice — the two lists overlapped item-for-item and their defaults
> contradicted each other. The user now picks an **activity** ("What's this
> call?") and the engine derives the mode from it; Home's cards are shortcuts
> INTO that one flow with an activity preselected, not a second catalog.
> Practice, which never started a session, is a link under the Interview
> activity. See [18-ACTIVITIES.md](./18-ACTIVITIES.md) — where this file says
> "mode card" or "mode launcher", read "activity".

> **Also superseded (2026-07-28): the profile is picked in the sidebar, and
> the sidebar is two groups.**
> Seven surfaces each carried their own profile `<Select>` and defaulted
> independently, so "whose dashboard is this?" had seven answers free to
> disagree. There is one switcher now, above the nav, and every page under it
> reads the active profile.
>
> That split the five "durable sections" this document describes. Home,
> Library, Sessions, and Insights are views of ONE profile and sit under a group
> labelled with that profile's name; **Profiles** (promoted out of the Library,
> where it had been listing every profile beside three tabs showing exactly one)
> and **Settings** are global and sit below a divider under "App". See
> [19-ACTIVE-PROFILE.md](./19-ACTIVE-PROFILE.md).

---

## Help, and the tour (2026-07-29)

Two surfaces answer "how does this work?", and they are deliberately different
shapes.

**Help** (`/help`) is the manual, reachable from a **?** in the title bar on
every page. It lives in the window chrome rather than the sidebar for one
reason: the sidebar's first group is scoped to a profile, and Help is not —
and the pages launched from Home replace the nav's context entirely, so a
sidebar entry would be unreachable from exactly the places people get stuck.

Its content is **generated from the source of truth wherever one exists**: the
activity list from `ACTIVITIES`, the shortcut table from `SHORTCUT_DEFS`. A
hand-typed copy of either would be wrong within a release, and wrong help is
worse than none. The FAQ is hand-written and includes the limits — macOS system
audio needing a virtual device, unsigned installers, Privacy Mode blanking your
own screenshots — because an FAQ that only lists what works is marketing.

**The tour** is the ninety-second version, shown once on first run. Two changes
make it worth its length:

1. **Steps navigate.** A `TourStep` now carries a `route` as well as a `target`,
   so it opens the page and rings the actual card — the Spaces list, the two
   memory switches, the review queue — instead of spotlighting the sidebar entry
   that leads there. Highlighting "Library" in the nav says where to click and
   nothing about what you would find.
2. **It states consequences, not only capabilities.** A conversation kept with
   no Space keeps nothing; memory does nothing until switched on; Privacy Mode
   blanks your own screenshots too. Each of those reads as a bug when discovered
   later and as a design when heard here.

Fifteen steps grouped into four named chapters, with chapter ticks rather than
"step 7 of 15" — a bare count reads as a chore, four chapters read as a short
story with a visible end. A step whose anchor is missing falls back to a
centered card, which is also what the steps about the Cue Card (a different
window) and the save prompt (which only exists after a session) use.

`Tour.test.ts` is the rot guard: every `target` must match a `data-tour` anchor
the renderer actually renders, and every `route` must be one `App.tsx`
registers. It also fails if the targets drift back to being mostly `nav-*`.
