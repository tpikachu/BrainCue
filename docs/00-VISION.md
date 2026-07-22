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

## 3. Mode catalog

A **mode** is a preset over one shared engine (§4) — never a forked pipeline.

| Mode | You are… | BrainCue… | Status |
| --- | --- | --- | --- |
| **Interview Copilot** | the candidate | detects questions, streams grounded answer cues | ✅ shipped (v1) |
| **Practice** (mock + sparring) | rehearsing | plays interviewer with a TTS voice, coaches each answer | ✅ shipped (v1) |
| **Interviewer Assist** | the one asking | suggests questions and follow-ups, tracks coverage, drafts the evaluation | Phase 2 |
| **Meeting Copilot** | a participant | quietly surfaces context, unanswered questions, action items | Phase 2 |
| **Tutor** | learning something | voice dialogue + drills grounded in any material you give it | Phase 3 |
| **Companion** | working / gaming / thinking | ambient presence with long-term memory; speaks when it should, stays silent when it shouldn't | Phase 4 |

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
5. **One engine, many modes** — modes are presets, not forks.
6. **Memory belongs to the user** — visible, editable, deletable (Phase 4).
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
