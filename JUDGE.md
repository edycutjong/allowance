# Allowance — for judges

Live page: **https://allowance.edycu.dev/judge**

> Allowance gives every outside contributor a capped Otari allowance; on `/repro` an open-weight model writes a test, Otari's sandbox runs it, and the verdict is what the run did, not what the model believes.

## The 30-second path

1. [Issue #6](https://github.com/edycutjong/allowance-demo/issues/6#issuecomment-6708001599): screenshot bug report → **Reproduced**, return code 1, with the exact script and sandbox output.
2. [Issue #4](https://github.com/edycutjong/allowance-demo/issues/4#issuecomment-6708317077): a bug that is not there → **Not reproduced**, return code 0; footer `mcp ×5`.
3. [Issue #7](https://github.com/edycutjong/allowance-demo/issues/7): the model's repair changed the expected value → Allowance **refused to run it**.
4. [Issue #5](https://github.com/edycutjong/allowance-demo/issues/5#issuecomment-6706212278): prompt injection → `403 guardrail_violation` before any coder model saw it.
5. [Issue #1](https://github.com/edycutjong/allowance-demo/issues/1#issuecomment-6705733501): footer `$0.05 of $0.05 left today`, then [after the runs](https://github.com/edycutjong/allowance-demo/issues/1#issuecomment-6706134836) `$0.0000 of $0.05`.
6. Try it: open an issue on [allowance-demo](https://github.com/edycutjong/allowance-demo/issues/new) and comment `/repro` (your own $0.05/day allowance).

The full feature-by-feature proof table, with Otari request ids, is in [README.md → Otari Integration](README.md#-otari-integration).

## Receipts

- Open-weight models only, all through the hosted Otari gateway.
- 174 tests in CI at 100% line, branch and function coverage, including a property test: across 25,000 generated sandbox runs, a **Reproduced** verdict only ever came from a failed run with the marker's AssertionError in stderr (`test/verdict-property.test.ts`).
- Every verdict comment prints its Otari request id, the model cost and the sandbox run count.

## Reproduce

```bash
git clone -b otari https://github.com/edycutjong/allowance && cd allowance
npm ci && npm test
# dry run against a real issue, no GitHub writes (needs Otari keys):
node --experimental-strip-types scripts/repro.ts https://github.com/edycutjong/allowance-demo/issues/4 --as you
```

There is no mock mode: the dry run calls Otari and the sandbox for real.

## Honest limits

- The demo bugs are in a repository we planted; issues #1–#7 are the development transcript, early failed runs kept.
- The routing fallback to Qwen3-VL has not fired on the GitHub path; the first target accepted the screenshot.
- Web search/fetch and key budgets are not claimed (see README → Limits).
