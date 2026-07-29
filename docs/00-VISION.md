# Vision — from interview copilot to ambient conversational companion

> Status: direction set 2026-07-21. This is the v2 north star. The product spec
> is [01-PRD.md](./01-PRD.md); the delivery plan is [10-ROADMAP.md](./10-ROADMAP.md).

## 1. The shift in one paragraph

BrainCue v1 is an interview copilot: it listens to an interview, detects
questions, and streams grounded answer cues into a capture-invisible overlay.
v2 keeps every one of those muscles but changes what the product **is**: an
**ambient AI companion for live conversations and activities**. It hears what is
happening on your machine (with consent), decides *when* it can contribute, and
delivers help through whichever surface fits — silent overlay cues or its own
voice. Interviews become one mode among many: candidate copilot, interviewer
assist, meeting copilot, tutor, or an ambient companion while you work or game.

## 2. Why "ambient companion", not a voice-mode clone

Generic voice chat is ChatGPT/Gemini home turf — we cannot out-latency or
out-price them, so we do not compete there. BrainCue's structural advantages
are things a cloud chat app cannot do:

| Advantage | Why a cloud assistant can't follow |
| --- | --- |
| **Present in real conversations** — system-loopback capture puts it inside your actual meetings, calls, and games | They live in their own app; they can't hear your call |
| **Invisibly present** — the overlay is excluded from screen capture (`WDA_EXCLUDEFROMCAPTURE`) | Requires OS-level window affinity, i.e. a desktop app |
| **Grounded in *your* corpus, locally** — documents, notes, (later) memory stay on the machine; only retrieved snippets leave | Their grounding is cloud-stored by design |
| **User-owned intelligence** — BYO key, no accounts, full local deletion | Their business model is the account |

The unifying frame: **BrainCue is in the room with you.** Voice chat is one of
its surfaces, not the product.

## 3. What the user picks: an activity

> Revised 2026-07-28. This section used to be a **mode catalog**, and the modes
> were shown to the user in a picker. They no longer are — see
> [18-ACTIVITIES.md](./18-ACTIVITIES.md) for why that picker was deleted.

A **mode** is a preset over one shared engine (§4) — never a forked pipeline —
and it is now an *internal* concept. The user says what the call **is**; the
mode follows from it. That collapse happened because choosing a mode and
choosing a Space kind were the same question asked twice, and they could
disagree.

| Activity | You are… | BrainCue… | Runs | Status |
| --- | --- | --- | --- | --- |
| **Meeting or call** | a participant | quietly surfaces context, unanswered questions, action items, decisions | `meeting` | 🧪 shipped (Labs) |
| **Project discussion** | talking about ongoing work | recalls prior decisions and open threads | `meeting` | 🧪 shipped (Labs) |
| **Interview** | the candidate | detects questions, streams grounded answer cues framed as you | `interview` | ✅ shipped (v1) |
| **Study or tutoring** | learning something | surfaces the part of your material that bears on what was said | `meeting` → `tutor` | 🧪 partial |
| **Personal** | dealing with your own life | keeps the background straight, catches what you agreed to | `meeting` | 🧪 shipped (Labs) |
| **Game** · **Just me** | playing / working / thinking | ambient presence; speaks when it should, stays silent when it shouldn't | `companion` | 🧪 shipped (Labs) |
| **Something else** | anything else | contributes only when confident | `meeting` | 🧪 shipped (Labs) |

**Practice** (mock + sparring) is not an activity: it is preparation *for* an
interview, in its own drill pages. It used to sit in the mode list, where
picking it started nothing — it navigated away.

Two modes are still unbuilt: **Interviewer Assist** (you are the one asking —
question suggestions, coverage tracking, a drafted evaluation) and **Tutor**
(voice dialogue and drills; `subject` runs `meeting` until it lands). An
activity whose mode is off is **not offered** rather than silently downgraded —
starting a standup as an interview is worse than not starting it — so the
roadmap lives on Home's Labs strip instead of inside the picker you must answer
to start.

The voice/summon layer (push-to-talk, spoken replies with barge-in), session
summaries, and the review-first memory substrate are output/grounding surfaces
over the one engine, not modes.

## 4. One engine, many modes (the core bet)

Every mode is a configuration of the same six-stage pipeline:

```
Sources → Transcription → Trigger policy → Grounding → Generation → Surfaces
 (mic,      (Realtime      (when should     (RAG over    (persona     (Cue Card,
 loopback,   GA STT)        I contribute?)   local docs   prompt,      voice, reports)
 screen,                                     + memory)    streaming)
 hotkey ask)
```

v1 already built one full vertical slice of this: realtime STT, a question
classifier (which is simply a *reactive* trigger policy), the RAG retriever,
streaming answers, and the overlay + TTS surfaces. v2's foundational work is
extracting the engine so a mode may **only configure it, never bypass it** —
the rule that keeps six modes maintainable instead of six forked products.

## 5. Product principles

1. **Local-first, key-owner-first, provider-agnostic** — data lives in SQLite
   on the user's disk; AI calls use the user's own key, which never reaches the
   renderer. OpenAI is the first provider, not the identity: the engine talks to
   a provider layer, and multi-provider support (Anthropic, Google, local
   models) is on the roadmap.
2. **Grounded, never inventing** — contributions cite the user's corpus; when
   there's no match, say so and offer a safe framing instead of fabricating.
3. **Consent & transparency** — listening starts explicitly, and the user can
   always see what was heard and exactly what left the machine.
4. **Silence is a feature** — an ambient agent is judged by when it *doesn't*
   speak; sensitivity is user-tunable and quiet is the default posture.
5. **One engine, many activities** — modes are presets, not forks, and the user
   never picks one. They say what the call is; the mode is derived.
6. **Continuity is scoped, and memory belongs to the user** — a conversation is
   kept in the **Space** it happened in, or not at all, so the tenth standup is
   grounded in the previous nine and one client's history can never ground
   another's call. Long-term memory about the *person* is a separate promise:
   off until consented, proposed rather than taken, and only ever recalled after
   the user approves it in the Memory section — visible, editable, deletable.
   See [16-CONTINUITY.md](./16-CONTINUITY.md).
7. **Assist where allowed** — unchanged v1 ethics posture: no anti-proctoring,
   no evasion, persistent "use only where AI assistance is permitted" reminder.

## 6. Brand

Keep **BrainCue** — "cue" generalizes perfectly past interviews (cue cards work
for any conversation). Retire the "interview copilot" descriptor.

| Element | v1 | v2 |
| --- | --- | --- |
| Name | BrainCue Copilot | **BrainCue** (appId/binary unchanged — no installer churn) |
| Descriptor | "AI interview copilot" | "ambient AI companion" / "the AI in the room with you" |
| Overlay | "Cue Card" | keep — it's the brand's best asset, now cueing any conversation |

Open brand decisions (owner: maintainer): final tagline wording; whether the
electron-builder `productName` changes now or at v2.0 release; README hero copy.
The npm package `name` became `braincue` (2026-07-22) with the userData
directory pinned to the legacy id so existing installs keep their data.
