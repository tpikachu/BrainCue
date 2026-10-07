# Dev session log

Working notes from AI-assisted development sessions, one file per day
(`YYYY-MM-DD.md`). Each entry records what was changed, why, decisions made, and
anything left open — so work can be picked up cleanly across sessions without
re-deriving context.

This complements (not replaces) the changelog: `changelog/` is user-facing release
notes; this folder is the developer-facing running log.

| Date | Summary |
| --- | --- |
| [2026-10-06](./2026-10-06.md) | Local engine clipped the first word after silence — sherpa-onnx rule 1 endpoint off (60 s); experiment A–D |
| [2026-09-07](./2026-09-07.md) | v2.2 train: meetings answer questions (balanced default); local STT + multi-provider + Settings/onboarding; live question-detection test on both engines (endpoint rules, warm-up, unpunctuated questions); system audio + mic capture |
| [2026-09-06](./2026-09-06.md) | Toolchain: Node 24 + better-sqlite3 12 · GitTensor/eval pipeline removed · in-session history (question N sees question N-1) · meeting question-detection + local-STT findings |
| [2026-07-22](./2026-07-22.md) | Prompt 4: provider capability seam (registry, OpenAI reference impls, embedding identity, 0010) · Prompt 5: generic ContributionCard + Overlay decomposition, dual-emit contribution events · Prompt 6: Spaces UX — universal Home + shared start flow + Library tabs + Sessions/Insights split · Prompt 7: Meeting Copilot — ambient trigger ladder, presence levels, grounded cards + report · Prompt 8: trustworthy local memory — consent-gated extraction, review-first lifecycle, scoped hybrid recall (0011) · Prompt 9: voice/summon layer — dialogue-controller FSM, push-to-talk anywhere, sentence-streamed TTS + barge-in, no-session quick ask · Prompt 10: Companion mode — InterjectionPolicy gate chain, persona single-source, cost governance + budgets, evaluation harness (0012) |
| [2026-07-21](./2026-07-21.md) | v2 direction set: ambient companion — vision/PRD/roadmap (00/01/10), README repositioned, multi-provider specced, mode-first nav design (11) |
| [2026-06-23](./2026-06-23.md) | v0.2.0 tray/shortcuts/logo + v0.3.0 status panel, custom titlebar, reset/wipe, exit hotkey |
