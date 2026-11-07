import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReproRequest, endUserId, verdictFrom, type Issue } from "../lib/repro.ts";
import { commandIn, imageUrlsIn, parseIssueUrl } from "../lib/github-issue.ts";
import { allowanceOf, readTrace } from "../lib/otari.ts";
import { refusalComment, reproComment, resetLabel } from "../lib/comment.ts";

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
  assert.deepEqual(b.tools.map((t: any) => t.type), ["otari_code_execution", "otari_web_fetch"]);
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
    res: { ok: true, status: 200, content: "Expected: a", toolCalls: [run], costUsd: 0.0123, trace },
    verdict: verdictFrom([run]),
  }, { limit: 0.05, spent: 0.0123, left: 0.0377, resetsAt: null });
  assert.match(c, /Reproduced\*\* — decided by the sandbox exit code/);
  assert.match(c, /exit code `1`/);
  assert.match(c, /\$0\.04 of \$0\.05 left today/);
  assert.match(c, /this run cost \$0\.01/);
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
