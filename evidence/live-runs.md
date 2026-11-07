# Live runs

Figures come from a public issue comment on `edycutjong/allowance-demo`, or from a direct Otari API call or app log (dry run, probes, redelivery, response headers). The direct-call ones are not reproducible from this repository alone.
Request ids are Otari's `otari-request-id`.

## Screenshot report (issue #6)

Issue: https://github.com/edycutjong/allowance-demo/issues/6 · a bug report that carries a terminal screenshot
(`docs/chunk-terminal.png` in the allowance-demo repository) of `chunk([1, 2, 3, 4, 5], 2)` returning `[[1, 2], [3, 4]]`.

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
(HTTP 202, `redelivery: true`) and produced no new comment: at that point issue #6 still had exactly 5 comments
(triage, two `/repro`, two bot replies); later runs below added more. Each bot reply to a `/repro` carries a hidden marker with the triggering
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

## Script gate and pinned revision (2026-11-07, after the architecture review)

Every `/repro` now installs the default branch's head commit and names it; a model-written script runs only if it
installs this repository, calls a project function the issue names and raises the marker under a condition on that
call's result (`lib/script-check.ts`); the verdict reads only the exception that ends the sandbox's stderr.

- Sandbox stream probe (direct `POST /code/execute`, no issue): a script printing to both streams and raising
  `AssertionError` came back with the traceback in `stderr`, ending in `AssertionError: probe-marker`, `return_code` 1.
  Request `7e3c139f-a519-447a-ac41-00f69a9d46df`.
- Issue #6, `/repro` by the maintainer: **Reproduced**, installed at `9259e59`,
  `REPRODUCED: expected [[1, 2], [3, 4], [5]], got [[1, 2], [3, 4]]`; model $0.0046 + sandbox ×1; tools: mcp ×5;
  request `33fc9230-e3e2-4e56-b2a3-6fef055974e2`.
  https://github.com/edycutjong/allowance-demo/issues/6#issuecomment-6707763033
- Issue #7, `/repro` by the maintainer: **Inconclusive**, installed at `9259e59`. The model imported a package named
  `allowance` (`ModuleNotFoundError`); its repair turn also changed the expected value from 5 to 4, so Allowance did
  not run the repaired script and said so in the comment. Model $0.0077 + sandbox ×1; tools: mcp ×5; requests
  `32ef6998-cc88-46fc-a6d2-32041c5b3fbd` (write) and `afd99192-d555-4431-b845-54b31ae4aa21` (repair turn).
  https://github.com/edycutjong/allowance-demo/issues/7#issuecomment-6707750286
- Redelivery: the issue #6 `/repro` delivery (answered 202) was redelivered through the GitHub App API; the issue still
  had one verdict comment for that trigger and 7 comments in total at that point.
- Repair-turn screening probe (direct `chat/completions` shaped like a repair turn, no issue): Otari sent the guard an
  `input_text` of 281 characters — the last user message, which quoted #5's injection text as a `ModuleNotFoundError`
  line — and the guard model judged it Safe, so the request was not blocked. Request
  `194e59da-d5ea-4835-8366-be476338d2f9`. Since then the repair turn quotes only the line that ended the run, clipped
  to 300 characters, and a repaired script must keep every non-import line of the first one.
- Issue #6, `/repro` after the one-deadline change: **Could not finish** (`TimeoutError`) — the write turn (screenshot
  + five MCP reads) outran a 90 s ceiling; the placeholder was replaced, not left running.
  https://github.com/edycutjong/allowance-demo/issues/6#issuecomment-6707963195
- Issue #4, `/repro` by the maintainer (2026-11-07 14:39 UTC, after the review of the judge-facing docs): **Not reproduced**,
  installed at `9259e59`; the test asserts `dedupe([3, 1, 3, 2, 1]) == [3, 1, 2]` and passed, sandbox return code 0;
  model $0.0060 + sandbox ×1; tools: mcp ×5; request `b606e6b5-7158-4d5b-ba2c-cfaebdfd935c`; 19 s from comment to verdict.
  https://github.com/edycutjong/allowance-demo/issues/4#issuecomment-6708317077
- Issue #6 again with a 150 s ceiling for the write turn: **Reproduced** at `9259e59`; model $0.0082 + sandbox ×1;
  tools: mcp ×5; request `c3709369-eae7-4d55-8c88-dba391c10472`; about 127 s from comment to verdict.
  https://github.com/edycutjong/allowance-demo/issues/6#issuecomment-6708001599
