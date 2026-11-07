# Live runs

Every figure here comes from a public issue comment on `edycutjong/allowance-demo` or an Otari response header.
Request ids are Otari's `otari-request-id`.

## Screenshot report (issue #6)

Issue: https://github.com/edycutjong/allowance-demo/issues/6 · a bug report that carries a terminal screenshot
(`docs/chunk-terminal.png`) of `chunk([1, 2, 3, 4, 5], 2)` returning `[[1, 2], [3, 4]]`.

| Step | Result | Model · provider | Otari request | Fallback header |
|---|---|---|---|---|
| Triage welcome (issue opened) | bug, with repro steps; footer shows the repository pool: `$0.28 spent today by 19 contributors, ceiling $5.00/month` | `meta.llama3-3-70b-instruct-v1:0` · bedrock | `8bbf9108-bed8-4437-b572-d9cbfdc54400` | none |
| `/repro` #1 (comment 6707468549) | Inconclusive: the model returned no script, nothing ran in the sandbox | `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo` · deepinfra | `f6141c22-6f01-4831-81dc-8082485ca781` | `Otari-Fallback: false`, 1 attempt |
| `/repro` #2 (comment 6707477932) | **Reproduced**, decided by the sandbox exit code; model $0.0046 + sandbox ×1 | `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo` · deepinfra | `eb483b82-0440-465b-9777-2c7fd41dd5b7` | `Otari-Fallback: false`, 1 attempt |

What this shows, and what it does not:

- The routing policy `allowance-coder` did not fall back to Qwen3-VL on this screenshot. The first target
  (Qwen3-Coder 480B Turbo on DeepInfra) accepted the image request instead of refusing it, so there was no failed attempt
  to fall back from. The screenshot-fallback path was last observed in the day-0 test, under an earlier policy order.
- The first `/repro` was the model's miss (no script). A second `/repro` on the same issue ran normally. Both comments are kept.

## Idempotency

A GitHub redelivery of the delivery that produced `/repro` #2 (comment 6707477932) was accepted by the webhook
(HTTP 202, `redelivery: true`) and produced no new comment: issue #6 still has exactly 5 comments after it
(triage, two `/repro`, two bot replies). Each bot reply to a `/repro` carries a hidden marker with the triggering
comment id; a second `/repro` while a "Reproducing…" placeholder is under 5 minutes old is ignored.
Unit tests: `test/idempotency.test.ts`.

## Dry run (no GitHub write)

`scripts/repro.ts` on issue #6 as the contributor end user `demo-gus` (service key, per-user allowance):
Reproduced in 13.3 s, model $0.0035 + sandbox ×1, request `fb8e5eb1-1309-4b85-b8ff-89664915c096`, 1 attempt, no fallback.

## Maintainer triage footer (issue #7)

https://github.com/edycutjong/allowance-demo/issues/7 · opened by the repository owner. The triage welcome footer reads
"is a maintainer: charged to the repository pool, not a contributor allowance · repository pool: $0.29 spent today by 19
contributors, ceiling $5.00/month (Otari key budget)", triage by `meta.llama3-3-70b-instruct-v1:0` on bedrock,
request `db089b2e-a84e-4bc3-8ece-6d74dfe0a5d1`. Before this fix the owner's issues showed a contributor allowance of `$0.0000 of $0.05`.
