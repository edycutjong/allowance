import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Repo, installationToken, verifySignature } from "../lib/github.ts";
import { fetchIssue, issueFromApi, parseIssueUrl } from "../lib/github-issue.ts";
import { parseTriage, runTriage } from "../lib/triage.ts";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();

test("installation tokens use a signed app credential and surface GitHub failures", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.github.com/app/installations/9/access_tokens");
    assert.equal(init.method, "POST");
    assert.match(new Headers(init.headers).get("Authorization")!, /^Bearer ey/);
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ token: "installation-secret" });
  });
  assert.equal(await installationToken("1", pem, 9), "installation-secret");
  await assert.rejects(installationToken("1", pem, 9, async () => new Response("denied", { status: 403 })), /installation token 403/);
});

test("repository reads omit a since filter when none is supplied and reject malformed head revisions", async (t) => {
  const replies = [[], { sha: "bad" }, {}, null, { sha: 42 }];
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    paths.push(url);
    return Response.json(replies.shift());
  });
  const repo = new Repo("o/r", "token");
  assert.deepEqual(await repo.listComments(7), []);
  assert.equal(paths[0], "https://api.github.com/repos/o/r/issues/7/comments?per_page=100");
  for (let i = 0; i < 4; i++) assert.equal(await repo.headSha(), undefined);
});

test("empty labels make no request and optional reaction and label failures are tolerated", async () => {
  let calls = 0;
  const repo = new Repo("o/r", "token", async () => { calls++; return new Response("denied", { status: 403 }); });
  assert.equal(await repo.addLabels(7, []), null);
  assert.equal(calls, 0);
  assert.equal(await repo.removeLabel(7, "repro:yes"), null);
  assert.equal(await repo.react(55, "-1"), null);
  await assert.rejects(repo.claim("/issues/7"), /GitHub claim \/issues\/7 -> 403/);
  assert.equal(calls, 3);
});

test("short or non-sha256 webhook signatures are rejected", () => {
  assert.equal(verifySignature("secret", "body", "sha1=abc"), false);
  assert.equal(verifySignature("secret", "body", "sha256=abc"), false);
});

test("issue loading uses optional authentication and normalizes missing issue fields", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.github.com/repos/o/r/issues/7");
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    return Response.json({ number: 7 });
  });
  assert.deepEqual(await fetchIssue("o/r", 7), {
    repo: "o/r", number: 7, title: "", body: "", author: "unknown", url: "https://github.com/o/r/issues/7", imageUrls: [],
  });
  const issue = await fetchIssue("o/r", 7, "secret", async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret");
    return Response.json({ number: 7, title: "bug", body: "steps", user: {}, html_url: "https://example.test/7" });
  });
  assert.deepEqual(issue, issueFromApi("o/r", { number: 7, title: "bug", body: "steps", user: {}, html_url: "https://example.test/7" }));
  await assert.rejects(fetchIssue("o/r", 7, undefined, async () => new Response("missing", { status: 404 })), /GitHub 404 for o\/r#7/);
  assert.throws(() => parseIssueUrl("https://example.test/no-issue"), /not a GitHub issue URL/);
});

test("triage skips malformed braces and preserves JSON summaries containing nested braces", () => {
  assert.deepEqual(parseTriage('broken {nope} then {"kind":"feature","summary":"a } brace"}'), { kind: "feature", summary: "a } brace", has_repro_steps: false });
  assert.equal(parseTriage("{broken}"), null);
  assert.equal(parseTriage('{"summary":{"toString":null}}'), null);
});

test("triage sends its guardrail and returns gateway refusals without inventing labels", async (t) => {
  const issue = issueFromApi("o/r", { number: 7 });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)).guardrails, [{ profile: "prompt-injection", mode: "block", url: "https://guard.test" }]);
    return new Response("refused", { status: 403 });
  });
  const result = await runTriage(issue, { guardUrl: "https://guard.test" }, { OTARI_API_KEY: "key", OTARI_SERVICE_KEY: "service" });
  assert.equal(result.res.ok, false);
  assert.equal(result.triage, null);
});
