import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReproRequest, endUserId, verdictFrom, type Issue } from "../lib/repro.ts";
import { commandIn, imageUrlsIn, parseIssueUrl } from "../lib/github-issue.ts";
import { allowanceOf, readTrace } from "../lib/otari.ts";
import { MAINTAINER, allowanceLine, poolLine, refusalComment, reproComment, resetLabel, welcomeComment } from "../lib/comment.ts";
import { getPool } from "../lib/otari.ts";

const issue: Issue = {
  repo: "o/r",
  number: 7,
  title: "t",
  body: "b",
  author: "alice",
  url: "https://github.com/o/r/issues/7",
  imageUrls: [],
};
const exec = (o: Record<string, unknown>) => ({ id: "x", type: "code_execution", status: "completed", ...o });

test("verdict: failed run with marker = reproduced", () => {
  const v = verdictFrom([exec({ status: "failed", exit_code: 1, stderr: "AssertionError: REPRODUCED: expected ValueError, got 'NaN'" })]);
  assert.equal(v.kind, "reproduced");
  assert.match(v.reason, /^REPRODUCED: expected ValueError/);
});

test("verdict: passing run with NOT REPRODUCED = not_reproduced", () => {
  assert.equal(verdictFrom([exec({ exit_code: 0, stdout: "NOT REPRODUCED\n" })]).kind, "not_reproduced");
});

test("verdict: the model's prose can never produce a verdict", () => {
  assert.equal(verdictFrom([]).kind, "inconclusive");
  assert.equal(verdictFrom([{ id: "w", type: "web_fetch", status: "completed", stdout: "REPRODUCED: yes" }]).kind, "inconclusive");
});

test("verdict: marker in a PASSING run does not count", () => {
  assert.equal(verdictFrom([exec({ exit_code: 0, stdout: "REPRODUCED: fake" })]).kind, "inconclusive");
});

test("verdict: setup failure is inconclusive with reason", () => {
  const v = verdictFrom([exec({ status: "failed", exit_code: 1, stderr: "RuntimeError: SETUP: pip could not resolve foo" })]);
  assert.equal(v.kind, "inconclusive");
  assert.match(v.reason, /SETUP: pip/);
});

test("verdict: only the LAST sandbox run counts", () => {
  const v = verdictFrom([
    exec({ status: "failed", exit_code: 1, stderr: "AssertionError: REPRODUCED: early" }),
    exec({ exit_code: 0, stdout: "NOT REPRODUCED" }),
  ]);
  assert.equal(v.kind, "not_reproduced");
  assert.equal(v.runs, 2);
});

test("request: billed to the contributor, guarded, routed, tooled", () => {
  const b = buildReproRequest(issue, "Alice", { guardUrl: "https://g/validate", mcpServerIds: ["m1"] }) as any;
  assert.equal(b.user, "gh:alice");
  assert.equal(b.model, "allowance-coder");
  assert.deepEqual(b.guardrails, [{ profile: "prompt-injection", mode: "block", url: "https://g/validate" }]);
  assert.deepEqual(b.mcp_server_ids, ["m1"]);
  assert.deepEqual(b.tools.map((t: any) => t.type), ["otari_web_fetch"]); // the model writes; Allowance runs
});

test("request: screenshots become image parts", () => {
  const b = buildReproRequest({ ...issue, imageUrls: ["https://i/x.png"] }, "a", {}) as any;
  assert.equal(b.messages[1].content[1].type, "image_url");
});

test("endUserId is stable and lowercase", () => assert.equal(endUserId("OctoCat"), "gh:octocat"));

test("commands: /repro at line start, quotes ignored", () => {
  assert.equal(commandIn("/repro"), "repro");
  assert.equal(commandIn("thanks!\n/repro please"), "repro");
  assert.equal(commandIn("> /repro\nok"), null);
  assert.equal(commandIn("try /repro later"), null);
  assert.equal(commandIn("/EXPLAIN"), "explain");
});

test("issue parsing: URL and images", () => {
  assert.deepEqual(parseIssueUrl("https://github.com/a/b/issues/12"), { repo: "a/b", number: 12 });
  assert.deepEqual(imageUrlsIn('see ![s](https://x/1.png) and <img src="https://x/2.png">'), ["https://x/1.png", "https://x/2.png"]);
});

test("allowance: limit from the end user's budget, reserved counts as spent", () => {
  const a = allowanceOf(
    { external_id: "gh:a", spend: 0.01, reserved: 0.005, blocked: false, budget_id: "b1", next_budget_reset_at: "2026-11-08T00:00:00+00:00" },
    [{ budget_id: "b1", name: "contributor-allowance", max_budget: 0.05, is_default: true }],
  );
  assert.equal(a.limit, 0.05);
  assert.ok(Math.abs((a.left ?? 0) - 0.035) < 1e-9);
  assert.equal(resetLabel(a.resetsAt), "resets 2026-11-08 00:00 UTC");
});

test("allowance: unseen contributor gets the default budget, full", () => {
  const a = allowanceOf(null, [{ budget_id: "b1", name: "c", max_budget: 0.05, is_default: true }]);
  assert.equal(a.left, 0.05);
});

test("trace headers parsed", () => {
  const t = readTrace(new Headers({ "otari-request-id": "r1", "otari-provider": "deepinfra", "otari-fallback": "true", "otari-attempt-count": "2" }));
  assert.deepEqual([t.requestId, t.provider, t.fallback, t.attempts], ["r1", "deepinfra", true, 2]);
});

const trace = readTrace(new Headers({ "otari-request-id": "r9" }));

test("comment: guardrail refusal says no model was called", () => {
  const c = refusalComment("bob", {
    ok: false, status: 403, code: "guardrail_violation", budgetScope: null, retryAfterSec: null, trace,
    detail: { guardrails: [{ explanation: "qwen3guard: Controversial (Jailbreak)", score: 0.6 }] },
  }, null);
  assert.match(c, /Blocked by the guardrail/);
  assert.match(c, /No model was called/);
  assert.match(c, /Jailbreak/);
});

test("comment: per-user budget refusal names the contributor and the wait", () => {
  const c = refusalComment("bob", { ok: false, status: 403, code: "budget_exceeded", budgetScope: "user", retryAfterSec: 7200, detail: null, trace }, null);
  assert.match(c, /@bob's daily allowance/);
  assert.match(c, /about 2 h/);
});

test("comment: verdict line credits the sandbox", () => {
  const run = exec({ status: "failed", exit_code: 1, code: "assert 1==2", stderr: "AssertionError: REPRODUCED: x" });
  const c = reproComment("a", {
    kind: "ran",
    res: { ok: true, status: 200, content: "```python\nx\n```\nExpected: a", toolCalls: [], costUsd: 0.0123, trace },
    verdict: verdictFrom([run]),
    runs: [run],
    modelCostUsd: 0.0123,
  }, { limit: 0.05, spent: 0.0123, left: 0.0377, resetsAt: null });
  assert.match(c, /Reproduced\*\* — decided by the sandbox, not by the model/);
  assert.match(c, /return code `1`/);
  assert.match(c, /\$0\.04 of \$0\.05 left today/);
  assert.match(c, /model \$0\.01 \+ sandbox ×1/);
  assert.doesNotMatch(c, /```python\nx/); // the model's copy of the script is not repeated
});

test("verdict: reason comes from the raised line, not the echoed f-string source", () => {
  const stderr = [
    '---> 12     raise AssertionError(f"REPRODUCED: expected {expected}, got {actual}")',
    "AssertionError: REPRODUCED: expected 5400, got 3630",
  ].join("\n");
  const v = verdictFrom([exec({ status: "failed", exit_code: 1, stderr })]);
  assert.equal(v.kind, "reproduced");
  assert.equal(v.reason, "REPRODUCED: expected 5400, got 3630");
});

test("verdict: marker only in echoed source (exception was something else) is not a reproduction", () => {
  const stderr = '---> 3 raise AssertionError("REPRODUCED: x")\nModuleNotFoundError: No module named pocketkit';
  assert.equal(verdictFrom([exec({ status: "failed", exit_code: 1, stderr })]).kind, "inconclusive");
});

import { extractScript, scriptProblem, execToToolCall, runRepro } from "../lib/repro.ts";

test("extractScript takes the last python block", () => {
  assert.equal(extractScript("a\n```python\nprint(1)\n```\nb\n```python\nprint(2)\n```"), "print(2)");
  assert.equal(extractScript("no code"), null);
});

test("scriptProblem: must install this repo and assert the marker", () => {
  assert.match(scriptProblem("print(1)", "o/r") ?? "", /does not install o\/r/);
  assert.equal(scriptProblem('pip install git+https://github.com/o/r\nraise AssertionError("REPRODUCED: x")', "o/r"), null);
});

test("execToToolCall maps return code to status", () => {
  assert.equal(execToToolCall("c", { returnCode: 0, stdout: "", stderr: "", requestId: null, httpStatus: 200 }).status, "completed");
  assert.equal(execToToolCall("c", { returnCode: 1, stdout: "", stderr: "", requestId: null, httpStatus: 200 }).status, "failed");
});

function fakeFetch(routes: { chat: string[]; exec: Array<{ return_code: number; stdout?: string; stderr?: string } | { status: number; code: string }> }) {
  let c = 0, e = 0;
  const calls: string[] = [];
  const f = async (url: string, init: any) => {
    calls.push(url);
    if (url.endsWith("/chat/completions")) {
      const content = routes.chat[Math.min(c++, routes.chat.length - 1)];
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost_usd: "0.002" } }), { status: 200 });
    }
    const x: any = routes.exec[Math.min(e++, routes.exec.length - 1)];
    if (x.status) return new Response(JSON.stringify({ detail: "no", code: x.code }), { status: x.status, headers: { "otari-error-code": x.code, "otari-budget-scope": "user" } });
    return new Response(JSON.stringify(x), { status: 200 });
  };
  return { f: f as unknown as typeof fetch, calls };
}
const env = { OTARI_API_KEY: "k", OTARI_SERVICE_KEY: "s", OTARI_BASE_URL: "https://o/api/v1" };
const good = '```python\nimport subprocess, sys\nsubprocess.run(["pip","install","git+https://github.com/o/r"])\nraise AssertionError("REPRODUCED: x")\n```';

test("runRepro: model writes, Allowance runs once, sandbox decides", async () => {
  const { f, calls } = fakeFetch({ chat: [good], exec: [{ return_code: 1, stderr: "AssertionError: REPRODUCED: expected 5, got 4" }] });
  const r = await runRepro(issue, "a", {}, env, f);
  assert.equal(r.kind, "ran");
  if (r.kind === "ran") assert.equal(r.verdict.kind, "reproduced");
  assert.deepEqual(calls.map((u) => u.split("/").pop()), ["completions", "execute"]);
});

test("runRepro: one repair turn on a setup error, then the sandbox decides", async () => {
  const { f, calls } = fakeFetch({ chat: [good, good], exec: [{ return_code: 1, stderr: "ModuleNotFoundError: No module named x" }, { return_code: 0, stdout: "NOT REPRODUCED" }] });
  const r = await runRepro(issue, "a", {}, env, f);
  assert.equal(r.kind === "ran" && r.verdict.kind, "not_reproduced");
  assert.equal(r.kind === "ran" && r.runs.length, 2);
  assert.equal(calls.length, 4);
});

test("runRepro: a script that does not install the repo is never run", async () => {
  const { f, calls } = fakeFetch({ chat: ["```python\ndef parse(): pass\n```"], exec: [] });
  const r = await runRepro(issue, "a", {}, env, f);
  assert.equal(r.kind, "no_script");
  assert.equal(calls.length, 1);
});

test("runRepro: sandbox budget refusal becomes a per-user refusal", async () => {
  const { f } = fakeFetch({ chat: [good], exec: [{ status: 403, code: "budget_exceeded" }] });
  const r = await runRepro(issue, "a", {}, env, f);
  assert.equal(r.kind, "refused");
  if (r.kind === "refused") assert.equal(r.res.code, "budget_exceeded");
});

test("maintainers run on the repo pool key with no end user; contributors on the service key as gh:<login>", async () => {
  const seen: any[] = [];
  const f = (async (url: string, init: any) => {
    seen.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    if (url.endsWith("/chat/completions")) return new Response(JSON.stringify({ choices: [{ message: { content: good } }], usage: { cost_usd: "0" } }), { status: 200 });
    return new Response(JSON.stringify({ return_code: 0, stdout: "NOT REPRODUCED" }), { status: 200 });
  }) as unknown as typeof fetch;
  await runRepro(issue, "Maint", { maintainer: true }, env, f);
  assert.deepEqual(seen.map((s) => [s.auth, s.body.user]), [["Bearer k", undefined], ["Bearer k", undefined]]);
  seen.length = 0;
  await runRepro(issue, "Contrib", {}, env, f);
  assert.deepEqual(seen.map((s) => [s.auth, s.body.user]), [["Bearer s", "gh:contrib"], ["Bearer s", "gh:contrib"]]);
});

test("pool: footer shows the repository pool next to the contributor allowance, and for maintainers", () => {
  const pool = { spentToday: 0.281026, users: 19, ceilingUsd: 5 };
  assert.match(poolLine(pool), /repository pool: \*\*\$0\.28\*\* spent today by 19 contributors, ceiling \$5\.00\/month/);
  assert.equal(poolLine(null), "");
  assert.match(allowanceLine("bob", { limit: 0.05, spent: 0.01, left: 0.04, resetsAt: null }, pool), /\$0\.04 of \$0\.05 left today.*repository pool/);
  assert.match(allowanceLine("ana", MAINTAINER, pool), /maintainer: charged to the repository pool.*\$0\.28/);
});

test("pool: getPool sums end-user spend and counts users", async () => {
  const f = (async () => new Response(JSON.stringify([{ spend: 0.05, reserved: 0 }, { spend: 0.0123, reserved: 0 }]))) as typeof fetch;
  const p = await getPool({ OTARI_SERVICE_KEY: "k" }, 5, f);
  assert.equal(p.users, 2);
  assert.ok(Math.abs(p.spentToday - 0.0623) < 1e-9);
  assert.equal(p.ceilingUsd, 5);
});

test("403 budget_exceeded with scope api_token says the repository pool is exhausted this month", () => {
  const c = refusalComment("ana", { ok: false, status: 403, code: "budget_exceeded", budgetScope: "api_token", retryAfterSec: null, detail: null, trace }, null, { spentToday: 1, users: 3, ceilingUsd: 5 });
  assert.match(c, /Repository pool exhausted this month/);
  assert.match(c, /scope `api_token`/);
  assert.doesNotMatch(c, /ana's daily allowance/);
});

test("welcome comment for a maintainer shows the pool line, not a contributor allowance", () => {
  const c = welcomeComment("ana", { kind: "bug", has_repro_steps: true, summary: "s" }, MAINTAINER, trace, { spentToday: 0.1, users: 2, ceilingUsd: 5 });
  assert.match(c, /maintainer: charged to the repository pool/);
  assert.doesNotMatch(c, /left today/);
});

test("verdict note keeps only the Expected/Claim lines, a scope=user 403 says 'not enough left'", () => {
  const res = { ok: true, status: 200, content: "Let me create a test script.\n```python\nprint(1)\n```\nExpected: [[1]]\nClaim: drops the tail", toolCalls: [], costUsd: 0, trace } as any;
  const c = reproComment("a", { kind: "no_script", reason: "x", res, modelCostUsd: 0 }, null);
  assert.ok(c);
  const ran = reproComment("a", { kind: "ran", res, modelCostUsd: 0, runs: [], verdict: { kind: "reproduced", reason: "r", run: { id: "1", type: "code_execution", status: "failed", code: "c", exit_code: 1 }, runs: 1 } } as any, null);
  assert.match(ran, /Expected: \[\[1\]\]\n\nClaim: drops the tail/);
  assert.doesNotMatch(ran, /Let me create/);
  const e = refusalComment("bob", { ok: false, status: 403, code: "budget_exceeded", budgetScope: "user", retryAfterSec: null, detail: null, trace }, null);
  assert.match(e, /does not have enough left to cover another reproduction run/);
});
