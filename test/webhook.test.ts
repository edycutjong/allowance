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
};

type Comment = { id: number; body: string; created_at: string; user: { type: string } };

// One fake for GitHub + Otari: records every call, keeps the issue's comments in memory.
function world(opts: { comments?: Comment[]; chat?: (body: any) => Response; exec?: (body: any) => Response } = {}) {
  const calls: { method: string; url: string; body: any }[] = [];
  const comments: Comment[] = [...(opts.comments ?? [])];
  let nextId = 1000;
  const f = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const u = new URL(url);
    if (u.host === "api.github.com") {
      if (method === "GET" && u.pathname.endsWith("/comments")) return Response.json(comments);
      if (method === "POST" && /\/issues\/\d+\/comments$/.test(u.pathname)) {
        const c = { id: nextId++, body: body.body, created_at: new Date().toISOString(), user: { type: "Bot" } };
        comments.push(c);
        return Response.json(c, { status: 201 });
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
