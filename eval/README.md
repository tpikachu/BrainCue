# eval/ — the automated PR evaluation pipeline

The machinery behind the scorecard comment on every PR. Design of record:
[docs/13-GITTENSOR.md](../docs/13-GITTENSOR.md). Contributor-facing rules:
[CONTRIBUTING.md](../CONTRIBUTING.md).

## What exists today (Stage 0)

| Piece | What it does |
| --- | --- |
| `config/weights.json` | Dimension weights, gates, size caps. Hash-pinned into every scorecard — changing it is a rubric version bump, via PR only. |
| `config/labels.json` | The label taxonomy (areas, difficulty, `bounty:*`, `eval:*`). Pushed to GitHub with `node scripts/sync-labels.mjs`. |
| `config/rubric.md` | The LLM review contract (Phase 1) — ground rules, per-dimension criteria, gaming findings. |
| `gates/intake.mjs` | Size caps (waived for maintainers), binary/generated-path bans, lockfile-without-manifest, linked-issue check (advisory). |
| `gates/secret-scan.mjs` | Scans the PR's added lines for real credential patterns. A hit is a hard failure and means the credential is already compromised. |

`.github/workflows/pr-eval.yml` runs both and posts a sticky scorecard
comment + `eval:pass` / `eval:needs-work` labels. It installs nothing
(`npm ci` never runs), so a contributor's dependency changes cannot execute
code inside this workflow.

## Running locally

```bash
BASE_REF=master node eval/gates/intake.mjs
BASE_REF=master node eval/gates/secret-scan.mjs
```

Both diff `BASE_REF...HEAD`, print GitHub-annotation-style findings, and write
`eval-intake.json` / `eval-secrets.json` (gitignored) at the repo root.

## Principles the pipeline must never violate

1. **Never auto-merge.** On SN74 the maintainer's merge is the trust anchor;
   the pipeline pre-makes the decision, a human commits it.
2. **Never auto-close, never file "changes requested" reviews.** Miner
   credibility = merged/(merged+closed) with a 0.80 floor, and each
   changes-requested review costs 15% of a PR's score — bot feedback stays in
   comments and labels so iteration is free.
3. **The diff is adversarial input.** Nothing from a PR is executed by the
   pipeline, and (Phase 1) the LLM reviewer treats diff content as data —
   instructions found inside it are reported as `gaming.prompt-injection`.

## Planned layout (Phases 1–2, see the roadmap in docs/13-GITTENSOR.md)

```
eval/impact/       tree-sitter AST token scorer — same algorithm + weights as
                   the SN74 validator, so our impact axis predicts earnings
eval/llm/          two-pass rubric-pinned review, schema-constrained output
eval/antigaming/   churn discount · novelty/near-dup detection · test-gaming
                   (mutation sampling) · split-farming detection
eval/calibration/  golden PR set + outcome log (reverted? bug-linked in 30d?)
                   → quarterly weight re-fit
```
