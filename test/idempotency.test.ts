import { test } from "node:test";
import assert from "node:assert/strict";
import { marker, reproSkip, REPRO_WINDOW_MS } from "../lib/idempotency.ts";
import { RUNNING } from "../lib/comment.ts";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const bot = (body: string, ms: number) => ({ body, created_at: ago(ms), user: { type: "Bot" } });

test("first /repro on an issue runs", () => {
  assert.deepEqual(reproSkip([], 100, NOW), { skip: false });
});

test("redelivery of the same /repro is skipped once a verdict comment carries its marker", () => {
  const done = bot("### 🔴 **Reproduced**\n" + marker(100), 60 * 60 * 1000);
  assert.deepEqual(reproSkip([done], 100, NOW), { skip: true, why: "already-handled" });
});

test("redelivery is skipped from the placeholder alone (marker is on the placeholder)", () => {
  assert.deepEqual(reproSkip([bot(RUNNING("ana", 100), 5_000)], 100, NOW), { skip: true, why: "already-handled" });
});

test("a different /repro while a placeholder is younger than 5 min is ignored", () => {
  assert.deepEqual(reproSkip([bot(RUNNING("ana", 100), 60_000)], 101, NOW), { skip: true, why: "in-flight" });
});

test("a stale placeholder (older than 5 min, crashed run) does not block a new /repro", () => {
  assert.deepEqual(reproSkip([bot(RUNNING("ana", 100), REPRO_WINDOW_MS + 1000)], 101, NOW), { skip: false });
});

test("a finished verdict for another /repro does not block a new one", () => {
  assert.deepEqual(reproSkip([bot("### 🟢 done\n" + marker(100), 10_000)], 101, NOW), { skip: false });
});

test("human comments quoting the marker or the placeholder text do not count", () => {
  const human = { body: RUNNING("x", 100) + marker(100), created_at: ago(1000), user: { type: "User" } };
  assert.deepEqual(reproSkip([human], 100, NOW), { skip: false });
});
