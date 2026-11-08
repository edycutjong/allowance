import { test } from "node:test";
import assert from "node:assert/strict";
import { allowanceOf, chat, executeCode, getEndUser, getEndUserBudgets, getPool } from "../lib/otari.ts";

const env = { OTARI_API_KEY: "bot", OTARI_SERVICE_KEY: "service", OTARI_BASE_URL: undefined };

test("chat tolerates non-JSON errors and resolves error codes from headers, body and nested detail", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("upstream offline", { status: 502 }));
  const plain = await chat("key", {}, env);
  assert.equal(plain.ok, false);
  if (!plain.ok) assert.deepEqual([plain.code, plain.detail, plain.retryAfterSec], [null, "upstream offline", null]);
  for (const [body, headers, code] of [
    [{ code: "body" }, {}, "body"],
    [{ detail: { code: "nested" } }, {}, "nested"],
    [{ code: "body" }, { "otari-error-code": "header", "retry-after": "60" }, "header"],
  ] as const) {
    const res = await chat("key", {}, env, async () => Response.json(body, { status: 403, headers }));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, code);
      assert.equal(res.retryAfterSec, code === "header" ? 60 : null);
    }
  }
});

test("chat defaults missing content and invalid costs while retaining gateway tool calls", async () => {
  for (const body of [{}, { choices: [{}], usage: { cost_usd: "invalid" } }, { choices: [{ message: { content: 123 } }] }, null]) {
    const res = await chat("key", {}, env, async () => Response.json(body));
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual([res.content, res.costUsd, res.toolCalls], ["", 0, []]);
  }
  const tools = [{ id: "1", type: "mcp", status: "completed" }];
  const res = await chat("key", {}, env, async () => Response.json({ choices: [{ message: { content: "answer" } }], otari_tool_calls: tools, usage: { cost_usd: "0.01" } }));
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual([res.content, res.costUsd, res.toolCalls], ["answer", 0.01, tools]);
});

test("end-user reads find only the requested contributor and reject failed or malformed listings", async (t) => {
  const user = { external_id: "gh:a", spend: 0.01 };
  t.mock.method(globalThis, "fetch", async () => Response.json([user]));
  assert.deepEqual(await getEndUser("gh:a", env), user);
  assert.equal(await getEndUser("gh:a", env, async () => Response.json({})), null);
  await assert.rejects(getEndUser("gh:a", env, async () => new Response("", { status: 500 })), /end-users 500/);
  assert.deepEqual(await getEndUserBudgets(env), [user]);
  await assert.rejects(getEndUserBudgets(env, async () => new Response("", { status: 503 })), /end-user-budgets 503/);
});

test("allowance remains unknown without a matching or default budget", () => {
  assert.deepEqual(allowanceOf(null, []), { limit: null, spent: 0, left: null, resetsAt: null });
  assert.equal(allowanceOf(null, [{ budget_id: "other", name: "other", max_budget: 5, is_default: false }]).limit, null);
});

test("sandbox execution defaults omitted streams and turns malformed JSON into an upstream fault", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ return_code: 0 }));
  assert.deepEqual(await executeCode("pass", null, env), { returnCode: 0, stdout: "", stderr: "", requestId: null, httpStatus: 200, dispatches: 1 });
  const malformed = await executeCode("pass", null, env, async () => new Response("not JSON", { status: 500 }));
  assert.equal(malformed.httpStatus, 500);
  assert.equal(malformed.error?.code, null);
  const refused = await executeCode("pass", "gh:a", env, async () => Response.json({ code: "body-code", detail: "denied" }, { status: 403, headers: { "retry-after": "30" } }));
  assert.equal(refused.error?.code, "body-code");
  assert.equal(refused.error?.retryAfterSec, 30);
  assert.match(refused.stderr, /denied/);
});

test("repository pool defaults its ceiling and treats omitted spend as zero", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json([{}]));
  assert.deepEqual(await getPool(env), { spentToday: 0, users: 1, ceilingUsd: 5, truncated: false });
  await assert.rejects(getPool(env, 5, async () => new Response("", { status: 401 })), /end-users 401/);
  await assert.rejects(getPool(env, 5, async () => Response.json({})), /filter is not a function/);
});
