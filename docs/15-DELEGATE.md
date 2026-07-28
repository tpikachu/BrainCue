# 15 · Delegate (the disclosed stand-in)

The design of record for a BrainCue agent that **joins a call in the user's
place** — a recurring standup, a routine client or marketing call — answers the
questions it can answer from approved memory, defers on everything else, and
hands the user a summary and the action items afterwards.

Grounded in [14 · Memory](14-MEMORY.md): the delegate has no knowledge of its
own. Everything it can say is a memory the user approved.

## 1. Why this mode exists

Meeting load is the problem: recurring calls consume the hours in which the
work would otherwise get done, and a large share of what the user contributes
to them is *recurring status* — what shipped, what is blocked, what the date
is. That part is answerable from a good memory, so the user should not have to
attend in order to deliver it.

The productivity comes from the user not being in the call. It does not come
from anyone believing the delegate is the user — which is why disclosure costs
this design nothing.

## 2. Non-negotiables

These are product invariants, not preferences. Code that weakens one is a
security-class review failure, exactly like the key-isolation invariants.

1. **The delegate is never presented as the human.** It joins under a name
   that names the tool, not a person — `<User> — AI Stand-in`. If the surface
   is video, a persistent, non-removable badge marks it as AI for as long as
   it is on screen.
2. **It introduces itself on join**, in one line, unprompted: who sent it,
   what it can answer, that it will bring anything else back.
3. **It never attends anything whose purpose is assessing the human.** Job
   interviews, performance reviews, examinations, identity verification, or
   any legal attestation are refused by the mode itself, not by policy
   documentation. No label makes those acceptable.
4. **It never speaks for a third party.** It answers *about the user's own
   work*, from the user's own approved memory.
5. **It defers rather than guesses.** Below the confidence floor, or on
   anything that is a commitment, a date, a price, a promise, or a judgement
   about a person, the answer is *"I'll take that back to <user>"* — always,
   even when a plausible answer exists in context.
6. **Recording and jurisdiction are checked before joining**, because the
   delegate processes other people's speech. Disclosure is also the compliance
   posture: transparency obligations for AI systems that interact with people
   (EU AI Act Article 50, applicable 2 August 2026) assume exactly this design.

## 3. Architecture — configuration over the same engine

The delegate is a `ModeDefinition`, not a fork ([12 · Engine plan](12-ENGINE-PLAN.md)).
Two genuinely new pieces are needed, and both are seams the engine already has:

```
NEW  sourceAdapter:  meeting-bot audio/transcript in   (today: system loopback)
NEW  surface:        meeting-bot audio/video out       (today: Cue Card, local TTS)
     ────────────────────────────────────────────────────────────────
     REUSED: transcription · question detection · grounding/retrieval ·
             persona · trigger policy · streamed TTS · cost meter · reports
```

**Joining a call.** Zoom exposes a Meeting SDK for bot participants and Teams
supports bots first-class via Graph; **Google Meet has no third-party join
API**, so a headless-browser bot service (e.g. Recall.ai) is the realistic
route to cover all three. Rolling our own joiner is a maintenance treadmill
against UI changes and should be a deliberate later decision, not the MVP.

**Answering.** Question detection already exists. The delegate's trigger
policy differs from Interview mode in one way that matters: it must decide
*whether the question is for it at all* (name mention, direct address, or a
round-robin cue) before answering, and stay silent otherwise. Silence is the
default posture; the presence levels in `trigger/presence.ts` model this.

**Escalation ("paging").** When something arrives that needs the human — an
explicit ask for them, a decision, an unhappy client, anything crossing a
configured topic list — the delegate says so out loud, notifies the user, and
the user can join live. This is what makes the mode defensible in practice:
it is a *filter* on meeting load, not a replacement for the person.

**Afterwards.** The call's transcript flows into the memory pipeline
(§3.4 of [14 · Memory](14-MEMORY.md)) — archive, extract, consolidate — and the
user receives a summary, what the delegate said, what it deferred, and the
action items. What the delegate stated is auditable, verbatim.

## 4. Latency budget

STT → retrieve → generate → TTS is ~1.5–3 s per turn with today's providers.
That is acceptable for status answers and poor for banter, so the persona is
written for it: short, prepared-sounding statements; no attempt at repartee;
an explicit "let me check" filler when retrieval is slow. Measured per-stage
budgets and a hard cap (defer rather than stall) belong in the acceptance
tests.

## 5. Delivery

| Stage | Content | Depends on |
| --- | --- | --- |
| **D0 · Async status** | No bot at all: the engine drafts the user's standup update from memory, sessions, and commits; the user approves; it posts. Solves most of the pain for a fraction of the build — **ship and evaluate this before D2+.** | M1 |
| **D1 · Listener** | Bot joins read-only, transcribes into the session pipeline, archives to memory. No speech, no risk surface. | M1 |
| **D2 · Voice stand-in** | Disclosed audio delegate: intro line, answers, defers, pages, summarises. | D1, M1 |
| **D3 · Visual** | Stylised avatar with persistent AI badge. Likeness only with the user's recorded consent on file and the badge non-removable. Lowest value, highest risk — deliberately last. | D2 |

## 6. Open questions

- Which bot platform (vendor vs. native SDKs per platform) — a build/buy
  decision with real cost and maintenance implications.
- How the confidence floor is tuned: too low and the delegate guesses, too
  high and it defers on everything and feels useless.
- Whether D0 alone satisfies the actual requirement. It might. That is the
  cheapest possible discovery and it comes first for that reason.
