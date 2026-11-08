import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleWebhook, onIssueOpened, onRepro, type WebhookEnv } from "../lib/webhook.ts";
import { Repo } from "../lib/github.ts";
import { TRIAGE_MARKER, marker } from "../lib/idempotency.ts";

const E: WebhookEnv = {
  otari: { OTARI_API_KEY: "k", OTARI_SERVICE_KEY: "s", OTARI_BASE_URL: "https://o/api/v1" },
  appId: "1",
  pem: "",
  secret: "shh",
  mcpServerIds: [],
  poolCeilingUsd: 5,
  guardUrl: "https://g/api/guard/t",
};

type Comment = { id: number; body: string; created_at: string; user: { type: string } };

// One fake for GitHub + Otari: records every call, keeps the issue's comments in memory.
function world(opts: { comments?: Comment[]; chat?: (body: any) => Response; exec?: (body: any) => Response; failLabels?: boolean; failComment?: boolean } = {}) {
  const calls: { method: string; url: string; body: any }[] = [];
  const comments: Comment[] = [...(opts.comments ?? [])];
  const reactions = new Set<string>();
  let nextId = 1000;
  const f = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const u = new URL(url);
    if (u.host === "api.github.com") {
      if (method === "GET" && u.pathname.endsWith("/comments")) return Response.json(comments);
      if (method === "GET" && u.pathname.endsWith("/commits/HEAD")) return Response.json({ sha: "a".repeat(40) });
      if (opts.failLabels && u.pathname.endsWith("/labels")) return new Response("boom", { status: 500 });
      if (opts.failComment && method === "POST" && /\/issues\/\d+\/comments$/.test(u.pathname)) return new Response("boom", { status: 502 });
      if (method === "POST" && /\/issues\/\d+\/comments$/.test(u.pathname)) {
        const c = { id: nextId++, body: body.body, created_at: new Date().toISOString(), user: { type: "Bot" } };
        comments.push(c);
        return Response.json(c, { status: 201 });
      }
      if (method === "POST" && u.pathname.endsWith("/reactions")) {
        const k = u.pathname + body.content; // GitHub: one reaction per user and content
        const isNew = !reactions.has(k);
        reactions.add(k);
        return Response.json({ content: body.content }, { status: isNew ? 201 : 200 });
      }
      if (method === "PATCH") {
        const c = comments.find((x) => x.id === Number(u.pathname.split("/").pop()));
        if (c) c.body = body.body;
        return Response.json(c ?? {});
      }
      return method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({});
    }
    if (u.pathname.endsWith("/chat/completions")) {
      return opts.chat ? opts.chat(body) : Response.json({ choices: [{ message: { content: '{"kind":"bug","has_repro_steps":true,"summary":"s"}' } }], usage: { cost_usd: 0.0002 } });
    }
    if (u.pathname.endsWith("/code/execute")) return opts.exec ? opts.exec(body) : Response.json({ return_code: 0, stdout: "NOT REPRODUCED", stderr: "" });
    if (u.pathname.endsWith("/end-user-budgets")) return Response.json([{ budget_id: "b", name: "contributor-allowance", max_budget: 0.05, is_default: true }]);
    if (u.pathname.endsWith("/end-users")) return Response.json([]);
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  return { f, calls, comments, repo: new Repo("o/r", "t", f) };
}

const issue = {
  number: 7,
  title: "chunk drops the tail",
  body: "chunk([1,2,3], 2) returns [[1, 2]]",
  user: { login: "alice" },
  html_url: "https://github.com/o/r/issues/7",
  created_at: "2026-11-07T10:00:00Z",
  author_association: "NONE",
};
const reproEvent = (id = 55) => ({
  action: "created",
  issue,
  comment: { id, body: "/repro", user: { login: "alice" }, author_association: "NONE", created_at: new Date().toISOString() },
  repository: { full_name: "o/r" },
  installation: { id: 9 },
  sender: { type: "User" },
});

const sign = (raw: string, secret = "shh") => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
const delivery = (event: string, payload: unknown, sig?: string) => {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Request("https://x/api/github", { method: "POST", body: raw, headers: { "x-github-event": event, "x-hub-signature-256": sig ?? sign(raw) } });
};

test("webhook: forged signature 401, signed malformed JSON 400, bot sender and plain comments ignored", async () => {
  const jobs: Promise<unknown>[] = [];
  const deps = { env: E, waitUntil: (p: Promise<unknown>) => void jobs.push(p) };
  assert.equal((await handleWebhook(delivery("issue_comment", reproEvent(), sign("x", "wrong")), deps)).status, 401);
  assert.equal((await handleWebhook(delivery("issue_comment", "{not json"), deps)).status, 400);
  const bot = await handleWebhook(delivery("issue_comment", { ...reproEvent(), sender: { type: "Bot" } }), deps);
  assert.deepEqual(await bot.json(), { ignored: "bot" });
  const chatter = { ...reproEvent(), comment: { ...reproEvent().comment, body: "> /repro\nthanks!" } };
  assert.match(JSON.stringify(await (await handleWebhook(delivery("issue_comment", chatter), deps)).json()), /ignored/);
  assert.equal(jobs.length, 0);
});

test("webhook: a signed /repro is acknowledged 202 at once and the work runs in waitUntil", async () => {
  const w = world();
  const jobs: Promise<unknown>[] = [];
  const res = await handleWebhook(delivery("issue_comment", reproEvent()), { env: E, waitUntil: (p) => void jobs.push(p), fetchImpl: w.f, repoFor: async () => w.repo });
  assert.equal(res.status, 202);
  assert.equal(jobs.length, 1);
  await Promise.all(jobs);
  assert.ok(w.calls.some((c) => c.url.endsWith("/chat/completions")), "the repro ran");
});

test("triage: a redelivered issues.opened posts one welcome, not two", async () => {
  const w = world();
  await onIssueOpened({ issue }, w.repo, E, w.f);
  await onIssueOpened({ issue }, w.repo, E, w.f);
  assert.equal(w.comments.length, 1);
  assert.ok(w.comments[0].body.includes(TRIAGE_MARKER));
  assert.equal(w.calls.filter((c) => c.url.endsWith("/chat/completions")).length, 1, "triage model called once");
});

test("/repro: an Otari timeout turns the placeholder into 'Could not finish', and a redelivery does not rerun it", async () => {
  const w = world({ chat: () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); } });
  await onRepro(reproEvent(), w.repo, E, w.f);
  assert.equal(w.comments.length, 1);
  assert.match(w.comments[0].body, /Could not finish/);
  assert.match(w.comments[0].body, /did not answer in time/);
  assert.ok(w.comments[0].body.includes(marker(55)));
  assert.ok(!w.comments[0].body.startsWith("⏳"), "no stale placeholder left behind");
  const chats = w.calls.filter((c) => c.url.endsWith("/chat/completions")).length;
  await onRepro(reproEvent(), w.repo, E, w.f);
  assert.equal(w.comments.length, 1);
  assert.equal(w.calls.filter((c) => c.url.endsWith("/chat/completions")).length, chats, "no second model call");
});

test("/repro: comments are listed with since=, so a long thread cannot hide the marker past page 1", async () => {
  const w = world();
  await onRepro(reproEvent(), w.repo, E, w.f);
  const list = w.calls.find((c) => c.method === "GET" && c.url.includes("/issues/7/comments"));
  assert.match(list!.url, /since=2026-/);
});

test("/repro: the run installs the default branch's head commit, and the verdict names it", async () => {
  const script = '```python\nimport subprocess, sys\nsubprocess.run([sys.executable, "-m", "pip", "install", "-q", "git+https://github.com/o/r"], check=True)\nfrom pocketkit import chunk\nactual = chunk([1, 2, 3], 2)\nif actual != [[1, 2], [3]]:\n    raise AssertionError("REPRODUCED: got " + repr(actual))\nprint("NOT REPRODUCED")\n```';
  const w = world({
    chat: () => Response.json({ choices: [{ message: { content: script } }], usage: { cost_usd: 0.01 } }),
    exec: () => Response.json({ return_code: 1, stdout: "", stderr: "AssertionError     Traceback (most recent call last)Cell In[1]\nAssertionError: REPRODUCED: got [[1, 2]]" }),
  });
  await onRepro(reproEvent(), w.repo, { ...E, guardUrl: "https://g/api/guard/t" }, w.f);
  const ran = w.calls.find((c) => c.url.endsWith("/code/execute"));
  assert.match(ran!.body.code, new RegExp("o/r@" + "a".repeat(40)));
  assert.match(w.comments[0].body, /Reproduced/);
  assert.match(w.comments[0].body, /at `aaaaaaa`/);
});

test("claim: two deliveries of one /repro racing past the comment check run it once (👀 is the lock)", async () => {
  const w = world();
  await Promise.all([onRepro(reproEvent(), w.repo, E, w.f), onRepro(reproEvent(), w.repo, E, w.f)]);
  assert.equal(w.comments.length, 1);
  assert.equal(w.calls.filter((c) => c.url.endsWith("/chat/completions")).length, 1);
});

test("webhook: without a guard URL no model is called (503, fail closed)", async () => {
  const jobs: Promise<unknown>[] = [];
  const res = await handleWebhook(delivery("issue_comment", reproEvent()), { env: { ...E, guardUrl: undefined }, waitUntil: (p) => void jobs.push(p) });
  assert.equal(res.status, 503);
  assert.equal(jobs.length, 0);
});

const reproScript = '```python\nimport subprocess, sys\nsubprocess.run([sys.executable, "-m", "pip", "install", "-q", "git+https://github.com/o/r"], check=True)\nfrom pocketkit import chunk\nactual = chunk([1, 2, 3], 2)\nif actual != [[1, 2], [3]]:\n    raise AssertionError("REPRODUCED: got " + repr(actual))\nprint("NOT REPRODUCED")\n```';

test("codex r04 F3: a label failure after the verdict is published does not overwrite it", async () => {
  const w = world({
    failLabels: true,
    chat: () => Response.json({ choices: [{ message: { content: reproScript } }], usage: { cost_usd: 0.01 } }),
    exec: () => Response.json({ return_code: 1, stdout: "", stderr: "AssertionError   Traceback (most recent call last)Cell In[1]\nAssertionError: REPRODUCED: got [[1, 2]]" }),
  });
  await onRepro(reproEvent(), w.repo, E, w.f);
  assert.match(w.comments[0].body, /Reproduced/);
  assert.doesNotMatch(w.comments[0].body, /Could not finish/);
});

test("deepseek r04 P1-2: claimed but the placeholder cannot be posted → 👎 on the trigger, no throw", async () => {
  const w = world({ failComment: true });
  await onRepro(reproEvent(), w.repo, E, w.f);
  assert.ok(w.calls.some((c) => c.url.endsWith("/reactions") && c.body.content === "-1"));
  assert.equal(w.calls.filter((c) => c.url.endsWith("/chat/completions")).length, 0);
});

test("webhook environment defaults fail closed and expand escaped private-key newlines", async (t) => {
  const { envFromProcess } = await import("../lib/webhook.ts");
  assert.deepEqual(envFromProcess({}), { otari: { OTARI_BASE_URL: undefined, OTARI_API_KEY: "", OTARI_SERVICE_KEY: "" }, appId: "", pem: "", secret: "", guardUrl: undefined, mcpServerIds: [], poolCeilingUsd: 5 });
  const previous = process.env;
  process.env = { GITHUB_APP_ID: "42", GITHUB_PRIVATE_KEY: "line1\\nline2", GITHUB_WEBHOOK_SECRET: "secret", GUARD_TOKEN: "token", OTARI_API_KEY: "bot", OTARI_SERVICE_KEY: "service", OTARI_BASE_URL: "https://gateway.test", OTARI_MCP_GITHUB_ID: "mcp", POOL_CEILING_USD: "10" };
  t.after(() => { process.env = previous; });
  assert.deepEqual(envFromProcess(), { otari: { OTARI_BASE_URL: "https://gateway.test", OTARI_API_KEY: "bot", OTARI_SERVICE_KEY: "service" }, appId: "42", pem: "line1\nline2", secret: "secret", guardUrl: "https://allowance.edycu.dev/api/guard/token", mcpServerIds: ["mcp"], poolCeilingUsd: 10 });
  assert.equal(envFromProcess({ GUARD_TOKEN: "t", PUBLIC_BASE_URL: "https://custom.test" }).guardUrl, "https://custom.test/api/guard/t");
});

test("triage racing deliveries claim the issue once before calling the model", async (t) => {
  const w = world();
  t.mock.method(globalThis, "fetch", w.f);
  await Promise.all([onIssueOpened({ issue }, w.repo, E), onIssueOpened({ issue }, w.repo, E)]);
  assert.equal(w.comments.length, 1);
  assert.equal(w.calls.filter((c) => c.url.endsWith("/chat/completions")).length, 1);
});

test("triage guard refusals add a blocked label and retain their idempotency marker", async () => {
  const w = world({ chat: () => Response.json({ code: "guardrail_violation" }, { status: 403 }) });
  await onIssueOpened({ issue: { ...issue, author_association: "OWNER" } }, w.repo, E, w.f);
  assert.match(w.comments[0].body, /Blocked by the guardrail/);
  assert.ok(w.comments[0].body.endsWith(TRIAGE_MARKER));
  assert.ok(w.calls.some((c) => c.body?.labels?.includes("allowance:blocked")));
});

test("triage upstream refusals post a reply without a blocked label and tolerate missing allowance reads", async () => {
  const w = world({ chat: () => new Response("offline", { status: 503 }) });
  const f: typeof fetch = async (url, init) => String(url).includes("/end-user") ? new Response("offline", { status: 503 }) : w.f(url, init);
  await onIssueOpened({ issue: { ...issue, author_association: undefined } }, w.repo, E, f);
  assert.match(w.comments[0].body, /Could not run/);
  assert.ok(w.comments[0].body.endsWith(TRIAGE_MARKER));
  assert.ok(!w.calls.some((c) => c.url.endsWith("/labels")));
});

test("triage with an unparseable model reply welcomes the author without assigning labels", async () => {
  const w = world({ chat: () => Response.json({ choices: [{ message: { content: "not JSON" } }] }) });
  await onIssueOpened({ issue }, w.repo, E, w.f);
  assert.match(w.comments[0].body, /Thanks @alice/);
  assert.doesNotMatch(w.comments[0].body, /Triage:/);
  assert.ok(!w.calls.some((c) => c.url.endsWith("/labels")));
});

test("maintainer repro uses the repository pool even when the head revision cannot be read", async (t) => {
  const w = world({ chat: () => Response.json({ choices: [{ message: { content: reproScript } }] }), exec: () => Response.json({ return_code: 0, stdout: "NOT REPRODUCED" }) });
  const f: typeof fetch = async (url, init) => String(url).endsWith("/commits/HEAD") ? new Response("offline", { status: 503 }) : w.f(url, init);
  const repo = new Repo("o/r", "token", f);
  t.mock.method(globalThis, "fetch", f);
  const p = reproEvent();
  p.comment.author_association = "MEMBER";
  p.comment.created_at = "invalid date";
  await onRepro(p, repo, E);
  assert.match(w.comments[0].body, /is a maintainer/);
  assert.match(w.comments[0].body, /Not reproduced/);
  const chat = w.calls.find((c) => c.url.endsWith("/chat/completions"))!;
  assert.equal(chat.body.user, undefined);
  assert.ok(w.calls.some((c) => c.body?.labels?.includes("repro:no")));
});

test("inconclusive sandbox runs label the issue and react with a thumbs down", async () => {
  const w = world({ chat: () => Response.json({ choices: [{ message: { content: reproScript } }] }), exec: () => Response.json({ return_code: 0, stdout: "no verdict" }) });
  await onRepro(reproEvent(), w.repo, E, w.f);
  assert.match(w.comments[0].body, /Inconclusive/);
  assert.ok(w.calls.some((c) => c.body?.labels?.includes("repro:inconclusive")));
  assert.ok(w.calls.some((c) => c.url.endsWith("/reactions") && c.body.content === "-1"));
});

test("repro guard refusals preserve old verdict labels and flag blocked input", async () => {
  const w = world({ chat: () => Response.json({ code: "guardrail_violation" }, { status: 403 }) });
  await onRepro(reproEvent(), w.repo, E, w.f);
  assert.match(w.comments[0].body, /Blocked by the guardrail/);
  assert.ok(!w.calls.some((c) => c.method === "DELETE"));
  assert.ok(w.calls.some((c) => c.body?.labels?.includes("allowance:blocked")));
});

test("repro upstream refusals leave labels alone", async () => {
  const w = world({ chat: () => new Response("offline", { status: 503 }) });
  await onRepro(reproEvent(), w.repo, E, w.f);
  assert.match(w.comments[0].body, /Could not run/);
  assert.ok(!w.calls.some((c) => c.url.includes("/labels")));
});

test("repro failures still react when both the verdict and error comment edits fail", async () => {
  const w = world();
  const repo = new Repo("o/r", "token", async (url, init) => init?.method === "PATCH" ? new Response("offline", { status: 502 }) : w.f(url, init));
  await onRepro(reproEvent(), repo, E, w.f);
  assert.ok(w.calls.some((c) => c.url.endsWith("/reactions") && c.body.content === "-1"));
});

test("webhook ignores noncommands, pull requests and events lacking installation or repository data", async () => {
  const deps = { env: E, waitUntil: () => assert.fail("ignored event scheduled a job") };
  for (const p of [
    { ...reproEvent(), action: "edited" },
    { ...reproEvent(), issue: { ...issue, pull_request: {} } },
    { ...reproEvent(), comment: {} },
    { ...reproEvent(), installation: undefined },
    { ...reproEvent(), repository: undefined },
    { ...reproEvent(), installation: {}, repository: {} },
  ]) {
    const res = await handleWebhook(delivery("issue_comment", p), deps);
    assert.equal(res.status, 200);
    assert.ok((await res.json()).ignored);
  }
  assert.equal((await handleWebhook(delivery("issues", { action: "closed" }), deps)).status, 200);
});

test("webhook schedules issue-opened triage and contains background authentication failures", async (t) => {
  const w = world();
  const jobs: Promise<unknown>[] = [];
  const p = { action: "opened", issue, installation: { id: 9 }, repository: { full_name: "o/r" } };
  const res = await handleWebhook(delivery("issues", p), { env: E, fetchImpl: w.f, repoFor: async () => w.repo, waitUntil: (p) => void jobs.push(p) });
  assert.equal(res.status, 202);
  await Promise.all(jobs);
  assert.ok(w.comments[0].body.endsWith(TRIAGE_MARKER));
  const errors = t.mock.method(console, "error", () => {});
  const failed = await handleWebhook(delivery("issues", p), { env: E, repoFor: async () => { throw new Error("authentication offline"); }, waitUntil: (p) => void jobs.push(p) });
  assert.equal(failed.status, 202);
  await Promise.all(jobs);
  assert.ok(errors.mock.calls.some((c) => c.arguments[0] === "allowance job failed"));
});
