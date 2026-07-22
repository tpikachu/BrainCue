# UX & Navigation — the mode-first layout

> Status: design set 2026-07-21; implemented as roadmap milestone 1.3. Spec:
> [01-PRD.md](./01-PRD.md) · Plan: [10-ROADMAP.md](./10-ROADMAP.md).

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
| `/tailor` | `/library` → pack action (route kept: `/tailor` redirects to picker) | |
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
> lives in the Spaces tab; Tailor is a Space action), the sidebar is
> Home/Library/Sessions/Insights/Settings, and the Tour was rewritten. The
> shared start flow shipped as `StartSessionModal` (mode → Space → source →
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
