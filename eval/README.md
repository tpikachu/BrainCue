# eval/ — the automated PR evaluation pipeline

The machinery behind the scorecard comment on every PR. Design of record:
[docs/13-GITTENSOR.md](../docs/13-GITTENSOR.md). Contributor-facing rules:
[CONTRIBUTING.md](../CONTRIBUTING.md).

## What exists today (Phases 0–1)

| Piece | What it does |
| --- | --- |
| `config/weights.json` | Dimension weights, gates, size caps. |
| `config/rubric.md` | The LLM review contract — ground rules, per-dimension criteria, gaming findings. The scorecard pins `sha256(weights.json + rubric.md)` so miners can verify which rubric scored them; changing either is a rubric version bump, via PR only. |
| `config/labels.json` | The label taxonomy (areas, difficulty, `bounty:*`, `eval:*`). Pushed to GitHub with `node scripts/sync-labels.mjs`. |
| `gates/intake.mjs` | Size caps (waived for maintainers), binary/generated-path bans, lockfile-without-manifest, linked-issue requirement (external PRs must carry `Closes #N` — enforced, since this gate is a required check). |
| `gates/secret-scan.mjs` | Scans the PR's added lines for real credential patterns. A hit is a hard failure and means the credential is already compromised. |
| `gates/coverage-diff.mjs` | Runs the unit suite (hard gate), then measures unit coverage of **this PR's changed executable lines** in `src/main` + `src/shared` (advisory floor 70%). Runs inside `ci.yml`, where dependencies are already installed. The renderer is out of scope — it's exercised by the e2e suite against the built app. |
| `llm/review.mjs` | The rubric-pinned LLM review: OpenAI Responses API, `gpt-5` reasoning, `strict: true` json_schema scorecard (the model *cannot* output anything else), advisory-only — every failure path exits 0. |
| `package.json` | Isolated dependency tree for the LLM stage (`openai` only). The report workflow runs `npm ci --prefix eval` in seconds; the app's dependency tree — and any PR's changes to it — never enters the privileged context. |

## How the workflows split privilege

```
pull_request (untrusted, read-only token, NO secrets)
├─ pr-eval.yml   intake + secret scan → uploads eval-reports artifact
└─ ci.yml        typecheck · tests + coverage-diff · build → uploads eval-coverage
        │
        ▼ workflow_run (trusted default-branch code, write token, secrets)
   pr-eval-report.yml
        fetches the diff via the API (data, never checked out)
        runs eval/llm/review.mjs   ← the only place OPENAI_API_KEY mounts
        posts the sticky scorecard + eval:* labels (works for fork PRs)
```

The LLM review runs once per push — on the CI completion, only when the gates
and CI are green (no spend on diffs that don't build). Firings converge: each
re-renders the comment from whatever artifacts exist.

**Activation:** add an `OPENAI_API_KEY` repository secret
(Settings → Secrets and variables → Actions). Without it the scorecard simply
notes the LLM review was skipped. `EVAL_LLM_MODEL` / `EVAL_LLM_EFFORT` env
overrides in the workflow tune model and reasoning effort (default
`gpt-5` / `medium`).

## Running locally

```bash
BASE_REF=master node eval/gates/intake.mjs
BASE_REF=master node eval/gates/secret-scan.mjs
BASE_REF=master node eval/gates/coverage-diff.mjs   # needs npm install first

# LLM review of your branch (needs OPENAI_API_KEY, ~cents per run):
npm ci --prefix eval
git diff master...HEAD > /tmp/pr.diff
DIFF_FILE=/tmp/pr.diff node eval/llm/review.mjs
```

All write their reports (`eval-*.json`, gitignored) at the repo root and print
GitHub-annotation-style findings.

## Principles the pipeline must never violate

1. **Never auto-merge.** On SN74 the maintainer's merge is the trust anchor;
   the pipeline pre-makes the decision, a human commits it. (GitHub's native
   auto-merge — armed by `auto-merge.yml`, firing on the maintainer's
   **approval** — doesn't violate this: the human approval is the decision,
   automation just saves the second click. No score, gate, or bot approval
   can trigger a merge.)
2. **Never auto-close, never file "changes requested" reviews.** Miner
   credibility = merged/(merged+closed) with a 0.80 floor, and each
   changes-requested review costs 15% of a PR's score — bot feedback stays in
   comments and labels so iteration is free.
3. **The diff is adversarial input.** Nothing from a PR is executed by the
   privileged pipeline, and the LLM reviewer reads diff content as fenced
   data — instructions found inside it are reported as
   `gaming.prompt-injection`, and strict structured output leaves a hijacked
   reviewer no prose channel to speak through.
4. **The LLM stage is advisory.** It informs the maintainer and the
   contributor; it never blocks a check. (Its first live run flagged two real
   regex bugs in our own gates — and also confidently mis-flagged
   `import.meta.dirname` as unsupported. Both halves of that story are why
   it advises rather than gates.)

## Planned layout (Phase 2+, see the roadmap in docs/13-GITTENSOR.md)

```
eval/impact/       tree-sitter AST token scorer — same algorithm + weights as
                   the SN74 validator, so our impact axis predicts earnings
eval/antigaming/   churn discount · novelty/near-dup detection · test-gaming
                   (mutation sampling) · split-farming detection
eval/calibration/  golden PR set + outcome log (reverted? bug-linked in 30d?)
                   → quarterly weight re-fit
```

Also Phase 2: a second LLM pass with disagreement escalation (>25 points on
any dimension → `eval:human`), per the two-pass contract in `config/rubric.md`.
