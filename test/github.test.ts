import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import { appJwt, verifySignature } from "../lib/github.ts";
import { parseTriage, triageLabels } from "../lib/triage.ts";

test("webhook signature: valid accepted, tampered and missing rejected", () => {
  const body = '{"action":"created"}';
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(verifySignature("s3cret", body, sig), true);
  assert.equal(verifySignature("s3cret", body + " ", sig), false);
  assert.equal(verifySignature("s3cret", body, null), false);
  assert.equal(verifySignature("", body, sig), false);
});

test("app JWT is RS256, verifiable, iss = app id, short-lived", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const jwt = appJwt("5654928", pem, 1_000_000);
  const [h, p, s] = jwt.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, s, "base64url"));
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(payload.iss, "5654928");
  assert.ok(payload.exp - payload.iat <= 600);
});

test("triage: parses JSON inside prose, unknown kind becomes other", () => {
  assert.deepEqual(parseTriage('Sure: {"kind":"bug","has_repro_steps":true,"summary":"x"}'), { kind: "bug", has_repro_steps: true, summary: "x" });
  assert.equal(parseTriage('{"kind":"rant"}')?.kind, "other");
  assert.equal(parseTriage("no json"), null);
});

test("triage labels", () => {
  assert.deepEqual(triageLabels({ kind: "bug", has_repro_steps: false, summary: "" }), ["kind:bug", "repro:needs-steps"]);
  assert.deepEqual(triageLabels({ kind: "question", has_repro_steps: false, summary: "" }), ["kind:question"]);
});

test("GET /api/health returns status ok and the package version", async () => {
  const { GET } = await import("../api/health.ts");
  const body = await (await GET()).json();
  assert.equal(body.status, "ok");
  assert.match(body.version, /^\d+\.\d+\.\d+(-development)?$/); // the deploy stamps the release version
});
