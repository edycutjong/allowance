# Demo: six beats

Everything below is on the public repo [`edycutjong/allowance-demo`](https://github.com/edycutjong/allowance-demo), the repository used for this demo. Each beat links the exact comment. Request ids are Otari's `otari-request-id`; the same id is printed in each comment footer. Issues #1 to #7 are the development transcript and keep their early failed runs; #1 and #4 ran before the script gate and pinned install. Measured details: [evidence/live-runs.md](evidence/live-runs.md).

## 1. A real bug is reproduced

Issue [#1](https://github.com/edycutjong/allowance-demo/issues/1): `parse_duration('1h30m')` returns 3630, the report says it should be 5400.
Final comment: [Reproduced](https://github.com/edycutjong/allowance-demo/issues/1#issuecomment-6706198622), `REPRODUCED: expected 5400, got 3630`, sandbox return code 1, model `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo` on DeepInfra, request `4a61771c-6c32-4e5a-ab19-d38168304386`, `tools: mcp ×2`. The model wrote the script; Allowance ran it.

## 2. A report with no bug is not reproduced

Issue [#4](https://github.com/edycutjong/allowance-demo/issues/4) claims `dedupe()` scrambles order. It does not.
Final comment: [Not reproduced](https://github.com/edycutjong/allowance-demo/issues/4#issuecomment-6706220636), sandbox return code 0, `tools: mcp ×5`, request `35de16cb-5126-4417-a174-5db39f6a365b`. The model's own test passed, so the verdict follows.

## 3. The guardrail blocks an injection

Issue [#5](https://github.com/edycutjong/allowance-demo/issues/5) carries prompt-injection text. Allowance screens it through Otari's guardrail, backed by Qwen3Guard.
[Comment](https://github.com/edycutjong/allowance-demo/issues/5#issuecomment-6706212278): `403 guardrail_violation`, flagged as `Controversial (PII), score 0.6` by `alibaba/qwen3guard-gen-8b`, no triage or coder model called, nothing charged to the contributor (the guard check runs on the repository key), request `435df9c0-93c0-461c-849b-1cf269873d34`.

## 4. The per-user allowance in the footer

The triage welcome on [#4](https://github.com/edycutjong/allowance-demo/issues/4#issuecomment-6706212151) contains `$0.0000 of $0.05 left today · resets 2026-11-08 00:00 UTC`, read back from the Otari end-user record, plus the triage model (`meta.llama3-3-70b-instruct-v1:0`, Bedrock) and request `e6f27738-99be-4629-aeab-125d371eb737`. A maintainer's issue ([#7](https://github.com/edycutjong/allowance-demo/issues/7#issuecomment-6707516143), request `db089b2e-a84e-4bc3-8ece-6d74dfe0a5d1`) shows the repository pool instead: "charged to the repository pool, not a contributor allowance".

## 5. A screenshot report through the routing policy

Issue [#6](https://github.com/edycutjong/allowance-demo/issues/6) attaches a terminal screenshot of `chunk([1, 2, 3, 4, 5], 2)` returning `[[1, 2], [3, 4]]`.
[Reproduced](https://github.com/edycutjong/allowance-demo/issues/6#issuecomment-6708001599) at `9259e59`, request `c3709369-eae7-4d55-8c88-dba391c10472`, about 127 s from comment to verdict. It was served by policy step 1 (the footer carries no fallback marker); the Qwen3-VL fallback did not fire, and [live-runs.md](evidence/live-runs.md) says so.

## 6. The verdict gate refuses a changed assertion

On issue [#7](https://github.com/edycutjong/allowance-demo/issues/7#issuecomment-6707750286) the model's first script imported a package that does not exist. Its repair also changed the expected value from 5 to 4. Allowance did not run the repaired script and the [Inconclusive comment](https://github.com/edycutjong/allowance-demo/issues/7#issuecomment-6707750286) says why. Requests `32ef6998-cc88-46fc-a6d2-32041c5b3fbd` (write) and `afd99192-d555-4431-b845-54b31ae4aa21` (repair turn).

## Reproduce it yourself

Open an issue on `allowance-demo` and comment `/repro`. Dry run without GitHub writes: `node --experimental-strip-types scripts/repro.ts <issue-url> --as <login>` with Otari keys in the environment.
