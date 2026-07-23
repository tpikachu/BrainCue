# GitTensor (Bittensor SN74) — listing plan & automated PR evaluation

> Status: designed 2026-07-22 from the SN74 validator source
> ([entrius/gittensor](https://github.com/entrius/gittensor)). Phase 0 (repo
> readiness) shipped with this doc; later phases land as their PRs do.
> Contributor-facing rules live in [CONTRIBUTING.md](../CONTRIBUTING.md); this
> doc is the design of record for the evaluation system.

## 1. What SN74 is, mechanically

GitTensor pays TAO for **merged PRs to whitelisted repositories**. Miners
register a GitHub PAT; validators verify account ownership, fetch each miner's
merged PRs in a **30-day rolling window**, and score them. 90% of emissions go
to the OSS track, split across ~24 "master repositories" by `emission_share`;
10% funds issue competitions. Repo maintainers earn a `maintainer_cut`.

The scoring formula (from `oss_contributions/scoring.py`,
`tree_sitter_scoring.py`, `constants.py`):

```
token_score = Σ_files [ Σ AST-node weights (tree-sitter symmetric diff) ]
              × language_weight(ext) × file_type_weight
earned      = base(25 + saturating bonus ≤5)
              × issue_mult (1.33 linked / 1.66 maintainer-labeled)
              × label_mult (per-repo)
              × review_quality (1 − 0.15 × changes_requested)
              × time_decay (sigmoid: 12h grace, 10-day midpoint, floor 0.05)
              × spam_mult (0/1: open-PR threshold per repo)
```

Facts that shape everything below:

- **AST diff counts semantic-change volume, not value.** Structural nodes are
  type-only (moving code ≈ 0); leaf nodes are type+text (renames DO score);
  comments are 0.
- **Language weights:** Rust/Go/C/C++/Java 2.0 · Python 1.5 · **.tsx 1.25 ·
  .ts 1.20** · .js 1.15 · JSON 0.1 · Markdown 0.08. **Test files × 0.05** —
  the subnet structurally under-pays tests and docs.
- **Miner credibility** = merged/(merged+closed) must stay **≥ 0.80**, with ≥3
  merged PRs — closing a miner's PR is existential for them.
- **Open PRs lock collateral** (20% of the would-be score, up to ×2 when
  reviews request changes) — slow reviews actively cost miners.
- **Anti-gaming is identity-level only** (PAT ownership, duplicate GitHub
  accounts across UIDs → zeroed, hotkey re-registration checks). Code quality
  has exactly one oracle: the maintainer's merge.

## 2. Our position

Being listed makes external miners build BrainCue's backlog for TAO, with a
maintainer cut. The price is that the maintainer's merge decision becomes the
subnet's quality oracle — which does not scale subjectively. So the repo ships
an **automated evaluation pipeline**: deterministic gates + measured impact +
(later) rubric-pinned LLM review, producing a public scorecard per PR. The
maintainer audits a ranked queue instead of reviewing blind, and our labels
become trustworthy enough to hold SN74's `trusted_label_pipeline` status.

Listing criteria per the SN74 README: contributing guidelines, active /
community-driven, provides value / has users. The route is a recommendation to
the GitTensor team (governance decision, not code).

## 3. Policies that make us miner-attractive (and gaming-resistant)

1. **Issue-first.** Score-bearing work starts from a maintainer-labeled issue
   (`bounty:*`) — that's SN74's ×1.66 path, and it means we define the work,
   not the miner. The PR template requires a linked issue.
2. **We don't casually close PRs.** A failed evaluation gets `eval:needs-work`
   and a fix window; close happens on abandonment or bad faith. Protects miner
   credibility (0.80 gate) — stated publicly, it's a recruiting feature.
3. **Bot feedback isn't a review.** The pipeline comments and labels; it never
   files a GitHub "changes requested" review, so miners iterate without eating
   the 0.15 review penalty. Maintainer reviews are reserved for the final human
   pass.
4. **Tests and docs are bounty-priced.** SN74 pays 0.05/0.08 for them, so
   miners won't volunteer them; our `bounty:test` / `bounty:docs` issues carry
   the maintainer-label multiplier to price them back in.
5. **Size caps.** External PRs: ≤ 40 files / ≤ 2500 changed lines, no binaries,
   no generated dirs. One concern per PR; oversized work must be split (and
   split-farming the other way is detected downstream).

## 4. Evaluation pipeline

```
Stage 0  Intake guards        size caps · binary/vendored ban · linked issue ·
         (eval/gates)         secret scan on added lines — instant, deterministic
Stage 1  Hard gates           typecheck · vitest · build (ci.yml) ·
                              privacy invariants (architecture.test.ts) ·
                              coverage-on-diff (advisory: % of changed
                              executable lines the unit suite runs)
Stage 2  Impact measurement   OUR tree-sitter token scorer — same algorithm and
         (planned)            weights as the SN74 validator, so our impact axis
                              predicts miner earnings · churn/novelty discounts
Stage 3  LLM review           rubric-pinned, evidence-anchored (file:line per
         (eval/llm)           claim), strict schema-constrained scorecard on
                              the OpenAI Responses API (gpt-5 reasoning) —
                              single-pass today; second pass + disagreement
                              escalation → eval:human is Phase 2
Stage 4  Verdict              sticky scorecard comment + eval:pass /
         (pr-eval-report)     eval:needs-work / eval:human labels ·
                              maintainer merges from queue
```

Non-negotiables: the pipeline **never auto-merges** (the maintainer merge is
SN74's trust anchor — the pipeline pre-makes the decision, a human commits it)
and **never auto-closes**. Fork-PR safety is a privilege split across two
workflow tiers: `pr-eval.yml` + `ci.yml` run on `pull_request` in the PR's own
context — read-only token, no secrets, and they only *upload artifacts* —
while `pr-eval-report.yml` runs on `workflow_run` from trusted default-branch
code with the write token and the `OPENAI_API_KEY` secret, fetches the diff
via the API as data, and posts the scorecard. The diff is adversarial input
end to end: nothing from it executes, the LLM reads it as fenced data, output
is constrained to the scorecard schema, and instructions found inside it are
themselves reported as `gaming.prompt-injection`. A PR that edits `eval/` or
`.github/` runs its *own* copy of the gates, so the scorecard flags those PRs
for review-the-pipeline-first.

## 5. Scoring algorithm (target state)

```
FinalScore = GATES × Σ wᵢ·dimᵢ × AntiGaming        GATES ∈ {0,1}

  .22 Correctness    tests pass + coverage-on-diff + LLM failure-scenario hunt
  .15 Architecture   engine-first rule, IPC contract, repo idiom (lintable
                     subset: renderer→main imports, hardcoded channels,
                     native <select>) + LLM conformance pass
  .15 Tests          changed behavior has tests; mutation-sample on the diff
  .12 Security       audit clean · IPC zod-validated · key isolation untouched
  .12 Impact         SN74-mirrored AST token score, log-saturating
  .08 Documentation  docs/ updated when described behavior changed
  .08 Performance    hot-path heuristics; benchmark deltas later
  .08 Maintenance    inverse churn risk: bug-history of touched files,
                     complexity delta, dead-code delta

AntiGaming = churn-discount (identifier-normalized AST ÷ raw AST)
           × novelty-discount (near-dup vs corpus + past PRs)
           × test-gaming check (tests that can't fail count as none)
           × split-detection (N same-concern PRs re-scored as one)
```

Weights live in `eval/config/weights.json`; every scorecard embeds the config
hash. Rubric and weights change only via PR — miners can diff the rules that
score them.

## 6. Miner/validator interaction

```
MINER                       BRAINCUE                        SN74 VALIDATOR
 pick bounty issue ──▶ PR ──▶ pipeline scorecard ─▶ fix loop (bot-only)
                              maintainer merges + labels
                                        ◀── PAT-verified fetch, 30-day window
                              AST scoring × issue × labels × review × decay
 TAO ∝ score (credibility ≥ .80) ◀──────────────  maintainer_cut ─▶ us
```

## 7. Repo structure for the system

```
.github/workflows/pr-eval.yml   Stage 0 + scorecard       (shipped, Phase 0)
.github/ISSUE_TEMPLATE/          bug · feature · bounty    (shipped)
.github/PULL_REQUEST_TEMPLATE.md linked issue required     (shipped)
.github/CODEOWNERS               maintainer review routing (shipped)
SECURITY.md · CODE_OF_CONDUCT.md governance                (shipped)
eval/config/                     weights.json · labels.json · rubric.md
eval/gates/                      intake.mjs · secret-scan.mjs · coverage-diff.mjs (shipped)
eval/llm/                        review.mjs — OpenAI Responses API, schema-
                                 constrained scorecard, advisory (shipped)
eval/package.json                isolated deps for the LLM stage (the app's
                                 dependency tree never enters the privileged
                                 report workflow)
eval/impact/                     tree-sitter token scorer  (Phase 2)
eval/antigaming/                 churn · novelty · splits  (Phase 2)
eval/calibration/                golden PRs · outcome log  (Phase 4)
scripts/sync-labels.mjs          push eval/config/labels.json to GitHub
```

## 8. Roadmap

- **Phase 0 — readiness (this PR):** governance files, templates, CODEOWNERS,
  label taxonomy + sync script, intake gates + secret scan + scorecard
  workflow, this doc. Follow-up (maintainer, on GitHub): branch protection on
  `master` requiring CI + PR evaluation; run `sync-labels`; seed 15–20
  labeled bounty issues from the real backlog (Interviewer Assist, Tutor,
  second provider, playwright smoke, perf).
- **Phase 1 — MVP evaluation (shipped):** coverage-on-diff (advisory floor
  70% on changed executable lines, wired into CI), single-pass rubric-pinned
  LLM review (OpenAI Responses API, `gpt-5` reasoning, strict json_schema
  scorecard, advisory-only), and the privileged split: `pr-eval.yml`/`ci.yml`
  run untrusted with read-only tokens and only upload artifacts, while
  `pr-eval-report.yml` (a `workflow_run` follower on trusted default-branch
  code) posts the sticky scorecard + labels — which makes fork PRs get
  feedback and is the ONLY place the `OPENAI_API_KEY` secret mounts.
  Remaining from Phase 1: calibration against ~40 historical PRs.
- **Phase 2 — scoring + anti-gaming:** port SN74's token scorer (their weights
  JSONs are public), churn/novelty/split detection, two-pass LLM with
  disagreement escalation, frozen rubric v1.
- **Phase 3 — listing (governance, parallel):** recommend BrainCue to the
  GitTensor team with the pipeline as the headline; register maintainer PAT;
  negotiate `maintainer_cut` / `label_multipliers` / `trusted_label_pipeline`.
- **Phase 4 — continuous optimization:** every scorecard logged against
  outcome truth (reverted? bug-linked within 30 days? survived 90?);
  quarterly weight re-fit; adversarial golden-set growth; public transparency
  report.
