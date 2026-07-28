# 16 · Conversation continuity

> Status: design of record, 2026-07-28. Vision: [00-VISION.md](./00-VISION.md) ·
> Memory: [14-MEMORY.md](./14-MEMORY.md) · Delegate: [15-DELEGATE.md](./15-DELEGATE.md).

## 1. The gap this closes

BrainCue could hold a conversation. It could not hold *a relationship*.

A finished session left a transcript in `transcript_chunks` and, for meetings, a
`session_reports` row. Neither was retrievable: reports were read by exactly one
screen (Sessions), and `ChunkSource` had no value for a conversation, so nothing
a session produced ever entered the grounding path. Every call therefore began
from zero.

That is the correct shape for an interview copilot — an interview is a one-off,
and yesterday's interview is not context for today's. It is the wrong shape for
a companion in someone's daily calls, where the *entire* value is that it was
there last time. "What did we agree three calls ago?" was unanswerable, and the
answer to "what's the status on Atlas?" ignored the four conversations about
Atlas that BrainCue itself sat through.

This is **G7** in [14 · Memory](./14-MEMORY.md) §2, listed there and left open by
M1–M4: memory learned to hold durable *facts about the user*, which is a
different thing from remembering *what happened*.

## 2. What an archive is (and is not)

At stop, a session is distilled into a short structured record — topic, summary,
decisions, action items, open questions, participants — rendered as one text
block and indexed as `session` chunks. Later conversations retrieve it through
the path that already exists.

The distinction from memory is deliberate and load-bearing:

| | Memory ([14](./14-MEMORY.md)) | Archive (here) |
| --- | --- | --- |
| What it holds | standing claims about the *person* ("prefers concise answers") | what happened in *one conversation* |
| Consent | OFF by default, every item reviewed | ON by default, but written only when the user keeps the session (§3) |
| Lifetime | until superseded or deleted | deleted with its session |
| Scope | profile, or a Space | the Space the conversation happened in |

**Why the archive defaults ON when memory defaults OFF.** Memory extracts
assertions about a person and keeps them indefinitely; getting that wrong means
the app states something untrue about the user, so it earns an explicit gate and
a review queue. An archive summarises a session the user deliberately started,
from a transcript already stored on their disk, and never becomes a claim about
them. Requiring opt-in for it would mean the product's core promise — *it was
there last time* — is off until discovered. It stays honest by being visible
(Settings → Privacy → "Remember conversations"), by naming exactly what it keeps,
by asking before it keeps anything (§3), and by carrying the same guarantees
below.

## 3. The user decides what is remembered

Archiving does **not** happen when a session stops. It happens when the user
answers the save prompt with *Keep it*.

That prompt already existed (save-or-discard, so a stray session did not clutter
Reports); it now carries the weight of the whole feature. "Keep this
conversation?" is a question about the conversation, and running the summariser
before it is answered would mean Discard had to *undo* work that should never
have started — and would have sent the transcript to a model the user was about
to say no to.

So `session:remember` does both halves of remembering, and only it does:

| Answer | What happens |
| --- | --- |
| **Keep it** | Archive written + indexed; memory candidates extracted for review |
| **Discard** | Session, transcript, archive, and the *pending* candidates it suggested are all deleted |
| **Decide later** | Session kept, nothing remembered |

Discard deliberately spares **approved** memories. The user read those, said
yes, and may have edited them; taking one back because its origin was later
discarded would reverse a decision they made deliberately. Pending candidates
are different — they are the session's suggestions, and a rejected conversation
should not leave suggestions behind with nothing to trace them to.

Both halves stay gated by the user's own settings underneath (the global switch,
the per-Space opt-out, memory consent), so *Keep it* is intent, never an
override — and the counts it reports back can legitimately be zero.

## 4. Guarantees

1. **Same privacy gate as memory.** `checkSensitive` runs over the rendered
   archive before persistence. A summary can repeat a credential someone read
   aloud, and unlike a transcript an archive is *retrievable*.
2. **Same per-Space opt-out.** A Space with memory disabled is never summarised.
   One switch means one mental model: "this Space is not remembered."
3. **Deleted with its session.** `chunks.source_id` is a plain column, not a
   foreign key, so SQLite cannot cascade this — `sessionsRepo.delete` and
   `deleteAll` remove archives explicitly. Embeddings *do* cascade from `chunks`,
   so the vector goes with the text. An archive outliving its session would keep
   grounding answers in a conversation the user deleted.
4. **Practice is never archived.** A mock interview or sparring drill is a
   rehearsal against an AI, not something that happened; archiving it would
   ground future answers in invented scenarios.
5. **Never breaks a session.** Archiving swallows its own failures. A session
   the user chose to keep must stay kept even if summarising or extraction
   fails, so `session:remember` reports the counts as they are rather than
   throwing.
6. **Embed before write.** A provider failure leaves no half-indexed archive, and
   re-archiving replaces rather than duplicates.

## 5. Retrieval — the cap that matters

Archives compete with the corpus for the same top-k grounding slots, and they
*accumulate*. After a few hundred calls a profile has far more `session` chunks
than résumé, notes, and JD chunks combined; pure cosine ranking then hands the
whole context window to conversation history and the documents that ground
factual answers stop appearing at all.

That failure is gradual and silent, which is what makes it dangerous: the
companion would sound steadily more confident and steadily less tethered,
answering from what was recently *said* rather than from what is *true*.

So `retriever.ts` caps archives at `SESSION_ARCHIVE_MAX = 2` of the k=5 slots,
over-fetching first so the freed slots go to real alternatives rather than
shrinking the result. Two is enough for "we agreed X last week" while leaving
the majority of grounding on source material.

## 6. Scoping

An archive carries its session's `packId`:

- **In a Space** → the archive stays in that Space. One client's call history can
  never ground another client's meeting. This is a correctness *and* a
  confidentiality property.
- **No Space** → global to the profile, which is what makes a personal companion
  continuous across the day.

## 7. What this unblocks

- The **delegate** ([15](./15-DELEGATE.md)) cannot stand in for someone while
  forgetting every previous call; D0's status update is written *from* archives.
- **Action items and decisions** now exist in a durable, queryable form — the
  substrate for a carry-forward surface ("three open items from yesterday").
- **Speaker identity**, once transcripts carry it, upgrades `participants` from
  names in a summary to real [14 · Memory](./14-MEMORY.md) §3.2 entity links.

## 8. Not in this milestone

- **Cross-session synthesis** ("what did Sarah commit to this month?") — needs
  the archive corpus to exist first; retrieval over it is the next step.
- **A carry-forward UI.** Action items are archived but have no home yet.
- **Speaker identity.** `transcript_chunks.speaker` is still `me`/`them`, so a
  six-person standup yields "them" and participants come from the summariser's
  reading rather than from diarization.

## 9. De-interviewing the shared defaults

Continuity fixed what BrainCue *remembered*. The same review found the other
half of the mismatch: what it *assumed*. Three shared defaults were still
interview-shaped, and every non-interview mode inherited them.

**The answer prompt.** `streamAnswer` opened with "You ARE the candidate …
answering the interview ON THEIR BEHALF … while the interviewer watches", and
`meeting.mode.ts` reused it for summoned answers. Correct at the engine level —
one generate path is the whole point — but the *prompt* was never generalized
alongside the pipeline, so a question asked in a standup was answered by a model
told it was being assessed. It now takes an `AnswerFraming`:

- `interview` — unchanged, byte-for-byte, and still right when someone is in an
  interview. It stays the default so no existing caller changes behaviour.
- `conversation` — same shared rules (speakable, human, cited, never
  fabricated), different role, plus one explicit instruction: *nobody is
  assessing them here, so never sell, never perform credentials, and never pitch
  their background unless the question asks.*

**The STAR story force-include.** `retrieve()` force-included the best-matching
`story` chunk even when it missed the top-k, so it could surface as the Cue
Card's "Story to tell". That is a behavioural-interview device — the right
answer to "tell me about a time you…" and the wrong thing to push into a client
call, where it displaces an actual document and invites the model to start
narrating the user's achievements. Now gated to the interview family
(`engine/grounding.ts`), which is also why `ground()` takes the mode.

**`interviewType` on ambient sessions.** The start flow stamped `'general'` on
every meeting and companion session, and the prompt then branched on it. The
column keeps its default for compatibility; nothing asserts it any more.

Wiring is tested, not just rendering: `meeting.framing.test.ts` fails if meeting
mode is pointed back at the interview framing. The rendering tests alone did not
catch that — a mutation run proved it.

**Job-search tooling is quarantined, not deleted.** Tailor Resume, applications,
and the STAR story bank sit behind `FLAGS.jobSearch` (off). Tables, IPC,
repositories, and pages are intact and user data is untouched; one flag brings
the surface back. They belong to the interview-copilot product, and Home leading
with résumé tailoring misrepresents what BrainCue is — but deleting shipped
features from a released version needs a deprecation path, not a delete key.

## 10 · The words themselves (2026-07-28)

An archive said what a call was *about*. It could not say what was *said* — the
verbatim transcript stayed in `transcript_chunks`, which nothing retrieves. So
"we discussed pricing" was answerable three calls later and "what exactly did
they offer?" was not.

The archive now carries `keyQuotes`: up to six lines the summariser copies
character-for-character out of the transcript, rendered into the indexed text
under *In their own words*.

Two rules make them trustworthy, and both are deterministic rather than asked
of the model:

- **A quote that is not in the transcript is dropped.** Each candidate is
  normalised (case, whitespace) and must appear inside a real turn. A summariser
  told to copy verbatim will still occasionally smooth a line, and a fabricated
  quote is worse than no quote — the entire point of keeping the words is that
  they can be trusted as the words.
- **Attribution comes from the matched ROW, not the model.** The model returns
  text only; the speaker is read off the transcript turn the quote was found
  in. A quote therefore cannot be put in the wrong person's mouth even when the
  model is confused about who was speaking. Unrecognised speaker labels pass
  through unflattened, so diarisation can land here without a change.
