# Demo: six beats

Everything below is on the public repo [`edycutjong/allowance-demo`](https://github.com/edycutjong/allowance-demo), the repository used for this demo. Each beat links the exact comment. Request ids are Otari's `otari-request-id`; the same id is printed in each comment footer. Issues #1 to #7 are the development transcript and keep their early failed runs. Beats 1 to 3 ran under the current script gate and pinned install (`9259e59`); beat 6 shows where it started. Measured details: [evidence/live-runs.md](evidence/live-runs.md).

## 1. The verdict gate refuses a changed assertion

On issue [#7](https://github.com/edycutjong/allowance-demo/issues/7#issuecomment-6707750286) the model's first script imported a package that does not exist. Its repair also changed the expected value from 5 to 4. Allowance did not run the repaired script and the [Inconclusive comment](https://github.com/edycutjong/allowance-demo/issues/7#issuecomment-6707750286) says why. Requests `32ef6998-cc88-46fc-a6d2-32041c5b3fbd` (write) and `afd99192-d555-4431-b845-54b31ae4aa21` (repair turn).

## 2. A real bug is reproduced, from a screenshot, through the routing policy

Issue [#6](https://github.com/edycutjong/allowance-demo/issues/6) attaches a terminal screenshot of `chunk([1, 2, 3, 4, 5], 2)` returning `[[1, 2], [3, 4]]`.
[Reproduced](https://github.com/edycutjong/allowance-demo/issues/6#issuecomment-6708001599) at `9259e59`: `REPRODUCED: expected [[1, 2], [3, 4], [5]], got [[1, 2], [3, 4]]`, sandbox return code 1, request `c3709369-eae7-4d55-8c88-dba391c10472`, about 127 s from comment to verdict. It was served by policy step 1 (the footer carries no fallback marker); the Qwen3-VL fallback did not fire, and [live-runs.md](evidence/live-runs.md) says so.

## 3. A report with no bug is not reproduced

Issue [#4](https://github.com/edycutjong/allowance-demo/issues/4) claims `dedupe()` scrambles order. It does not.
[Not reproduced](https://github.com/edycutjong/allowance-demo/issues/4#issuecomment-6708317077) at `9259e59`: the test asserts `dedupe([3, 1, 3, 2, 1]) == [3, 1, 2]`, it passed, sandbox return code 0, `tools: mcp ×5`, request `b606e6b5-7158-4d5b-ba2c-cfaebdfd935c`, 19 s from comment to verdict. The model's own test passed, so the verdict follows.

## 4. The guardrail blocks an issue carrying injection text

Issue [#5](https://github.com/edycutjong/allowance-demo/issues/5) carries prompt-injection text. Allowance screens it through Otari's guardrail, backed by Qwen3Guard.
[Comment](https://github.com/edycutjong/allowance-demo/issues/5#issuecomment-6706212278): `403 guardrail_violation`. The guard model `alibaba/qwen3guard-gen-8b` classified the text as `Controversial (PII), score 0.6`: the block is real, and the category it printed is PII, not injection. No triage or coder model was called and nothing was charged to the contributor (the guard check runs on the repository key). Request `435df9c0-93c0-461c-849b-1cf269873d34`.

## 5. The per-user allowance in the footer

On issue #1 the triage welcome ([comment](https://github.com/edycutjong/allowance-demo/issues/1#issuecomment-6705733501), request `5b11e044-9616-4a58-b755-857edfc104fb`) reads `$0.05 of $0.05 left today`, read back from the Otari end-user record. After that user's `/repro` runs, the [next footer](https://github.com/edycutjong/allowance-demo/issues/1#issuecomment-6706134836) reads `$0.0000 of $0.05 left today · resets 2026-11-08 00:00 UTC · this run cost $0.01`. That user was the repository owner, charged as a contributor before maintainers were moved to the pool. A maintainer's issue now ([#7](https://github.com/edycutjong/allowance-demo/issues/7#issuecomment-6707516143), request `db089b2e-a84e-4bc3-8ece-6d74dfe0a5d1`) shows the repository pool instead: "charged to the repository pool, not a contributor allowance". Earlier footers call the $5.00/month pool ceiling "Otari key budget"; it is the app's own setting, and `lib/comment.ts` now labels it "app setting".

## 6. Where it started

Issue [#1](https://github.com/edycutjong/allowance-demo/issues/1): `parse_duration('1h30m')` returns 3630, the report says it should be 5400.
Final comment: [Reproduced](https://github.com/edycutjong/allowance-demo/issues/1#issuecomment-6706198622), `REPRODUCED: expected 5400, got 3630`, sandbox return code 1, model `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo` on DeepInfra, request `4a61771c-6c32-4e5a-ab19-d38168304386`, `tools: mcp ×2`. The model wrote the script; Allowance ran it. This run predates the script gate and the pinned install.

## Reproduce it yourself

Open an issue on `allowance-demo` and comment `/repro`. Dry run without GitHub writes: `node --experimental-strip-types scripts/repro.ts <issue-url> --as <login>` with Otari keys in the environment.
