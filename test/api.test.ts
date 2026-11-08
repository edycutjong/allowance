import { beforeEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { registerHooks } from "node:module";
import pkg from "../package.json" with { type: "json" };
import { GUARD_MODEL, PROFILES } from "../lib/guard.ts";

// Vercel resolves these compiled .js imports; the source-only Node runner needs .ts instead.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL("../api/", import.meta.url).href) && specifier.endsWith(".js")) {
      return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
    }
    return nextResolve(specifier, context);
  },
});
const [github, guard, health] = await Promise.all([
  import("../api/github.ts"), import("../api/guard/[token]/[action].ts"), import("../api/health.ts"),
]).finally(() => hooks.deregister());

beforeEach((context) => {
  const t = context as TestContext;
  const previous = process.env;
  process.env = { ...previous };
  for (const key of ["GUARD_TOKEN", "OTARI_API_KEY", "OTARI_BASE_URL", "VERCEL_GIT_COMMIT_SHA"]) delete process.env[key];
  t.after(() => { process.env = previous; });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network request"); });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
});

const request = (body: unknown, token = "secret", headers: HeadersInit = {}) => new Request(`https://app.test/api/guard/${token}/validate`, {
  method: "POST", body: JSON.stringify(body), headers,
});

test("guard routes reject absent and incorrect tokens without calling the model", async () => {
  assert.equal((await guard.GET(new Request("https://app.test/api/guard/secret/profiles"))).status, 404);
  assert.equal((await guard.POST(request({ input_text: "hello" }))).status, 404);
  process.env.GUARD_TOKEN = "secret";
  assert.equal((await guard.GET(new Request("https://app.test/api/guard/wrong/profiles"))).status, 404);
  assert.equal((await guard.POST(request({ input_text: "hello" }, "wrong", { "user-agent": "gateway" }))).status, 404);
});

test("guard profiles list the supported names and model for an authorized caller", async () => {
  process.env.GUARD_TOKEN = "secret";
  assert.equal(guard.config.maxDuration, 60);
  const res = await guard.GET(new Request("https://app.test/api/guard/secret/profiles"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), PROFILES.map((name) => ({ name, guardrail_name: GUARD_MODEL })));
});

test("guard malformed JSON and non-string input return actionable validation errors", async () => {
  process.env.GUARD_TOKEN = "secret";
  const invalid = await guard.POST(new Request("https://app.test/api/guard/secret/validate", { method: "POST", body: "{broken" }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { detail: "invalid json" });
  for (const body of ["text", 5, true, { input_text: 42 }, { input_text: [] }]) {
    const res = await guard.POST(request(body));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { detail: "input_text must be a string" });
  }
  // Logging currently dereferences null before validation; pin the existing behavior.
  await assert.rejects(guard.POST(request(null)), TypeError);
});

test("guard empty input passes locally and selects the supplied or default profile", async () => {
  process.env.GUARD_TOKEN = "secret";
  for (const [body, profile] of [[{}, "prompt-injection"], [{ input_text: null, profile: 42 }, "prompt-injection"], [{ input_text: " \n ", profile: "issue-safety" }, "issue-safety"]] as const) {
    assert.deepEqual(await (await guard.POST(request(body))).json(), { profile, result: { valid: true, explanation: "empty input", score: 0 } });
  }
});

test("guard refuses text exceeding all screening windows without calling the model", async () => {
  process.env.GUARD_TOKEN = "secret";
  const res = await guard.POST(request({ input_text: "x".repeat(60_000) }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { profile: "prompt-injection", result: { valid: false, explanation: "input too long to screen (60000 characters)", score: 1 } });
});

test("guard forwards credentials and the model request id with a safe verdict", async (t) => {
  process.env.GUARD_TOKEN = "secret";
  process.env.OTARI_API_KEY = "bot-key";
  process.env.OTARI_BASE_URL = "https://gateway.test/api/v1";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://gateway.test/api/v1/chat/completions");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer bot-key");
    assert.equal(JSON.parse(String(init.body)).messages[0].content, "ordinary issue");
    return Response.json({ choices: [{ message: { content: "Safety: Safe" } }] }, { headers: { "otari-request-id": "guard-123" } });
  });
  const res = await guard.POST(request({ input_text: "ordinary issue" }, "secret", { "user-agent": "gateway" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-guard-otari-request-id"), "guard-123");
  assert.deepEqual(await res.json(), { profile: "prompt-injection", result: { valid: true, explanation: `${GUARD_MODEL}: Safe`, score: 0.05 } });
});

test("guard blocks unsafe input without requiring a gateway request id or configured API key", async (t) => {
  process.env.GUARD_TOKEN = "secret";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.otari.ai/api/v1/chat/completions");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer");
    return Response.json({ choices: [{ message: { content: "Safety: Unsafe\nCategories: PII" } }] });
  });
  const res = await guard.POST(request({ profile: "issue-safety", input_text: "secret extraction" }));
  assert.equal(res.headers.has("x-guard-otari-request-id"), false);
  assert.equal((await res.json()).result.valid, false);
});

test("guard fails closed when the gateway omits a verdict or returns an error", async (t) => {
  process.env.GUARD_TOKEN = "secret";
  for (const body of [{}, { choices: [] }, { choices: [{}] }, { choices: [{ message: {} }] }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(body));
    const res = await guard.POST(request({ input_text: "issue" }));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { detail: "guard model gave no verdict" });
  }
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  const res = await guard.POST(request({ input_text: "issue" }));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { detail: "Error: otari 503: unavailable" });
});

test("health reports the package version, disables caching and shortens an optional deployment SHA", async () => {
  let res = await health.GET();
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await res.json(), { status: "ok", service: "allowance", version: pkg.version, commit: null });
  process.env.VERCEL_GIT_COMMIT_SHA = "0123456789abcdef";
  res = await health.GET();
  assert.equal((await res.json()).commit, "0123456");
});

const delivery = (payload: unknown) => {
  const raw = JSON.stringify(payload);
  return new Request("https://app.test/api/github", { method: "POST", body: raw, headers: {
    "x-github-event": "issues", "x-hub-signature-256": "sha256=" + createHmac("sha256", "secret").update(raw).digest("hex"),
  } });
};

test("GitHub API exposes liveness and rejects invalid webhook signatures", async () => {
  assert.equal(github.config.maxDuration, 300);
  assert.deepEqual(await (await github.GET()).json(), { ok: true, service: "allowance webhook" });
  const res = await github.POST(new Request("https://app.test/api/github", { method: "POST", body: "{}" }));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "bad signature" });
});

test("GitHub API schedules signed issue triage through Vercel and mints an installation token", async (t) => {
  process.env.GITHUB_WEBHOOK_SECRET = "secret";
  process.env.GUARD_TOKEN = "secret";
  process.env.GITHUB_APP_ID = "1";
  process.env.GITHUB_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const jobs: Promise<unknown>[] = [];
  const symbol = Symbol.for("@vercel/request-context");
  const previous = Reflect.get(globalThis, symbol);
  Reflect.set(globalThis, symbol, { get: () => ({ waitUntil: (p: Promise<unknown>) => jobs.push(p) }) });
  t.after(() => { if (previous === undefined) Reflect.deleteProperty(globalThis, symbol); else Reflect.set(globalThis, symbol, previous); });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    if (url.endsWith("/access_tokens")) return Response.json({ token: "installation" });
    if (url.endsWith("/reactions")) return Response.json({}, { status: 201 });
    if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: '{"kind":"question"}' } }] });
    if (url.endsWith("/comments") || url.endsWith("/labels")) return Response.json({ id: 1 });
    return Response.json([]);
  });
  const res = await github.POST(delivery({ action: "opened", installation: { id: 9 }, repository: { full_name: "o/r" }, issue: { number: 7, author_association: "OWNER" } }));
  assert.equal(res.status, 202);
  assert.equal(jobs.length, 1);
  await Promise.all(jobs);
  assert.ok(calls.includes("https://api.github.com/app/installations/9/access_tokens"));
  assert.ok(calls.includes("https://api.github.com/repos/o/r/issues/7/comments"));
  assert.ok(calls.includes("https://api.otari.ai/api/v1/chat/completions"));
});
