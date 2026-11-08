import { test } from "node:test";
import assert from "node:assert/strict";
import { RUNNING, allowanceLine, failedComment, poolLine, refusalComment, reproComment, resetLabel, toolSummary, traceLine, welcomeComment } from "../lib/comment.ts";
import { readTrace, type ChatErr, type ChatOk, type ToolCall } from "../lib/otari.ts";
import { verdictFrom } from "../lib/repro.ts";

const trace = readTrace(new Headers());
const res: ChatOk = { ok: true, status: 200, content: "", costUsd: 0.001, toolCalls: [], trace };
const error = (overrides: Partial<ChatErr> = {}): ChatErr => ({ ok: false, status: 403, code: null, budgetScope: null, retryAfterSec: null, detail: null, trace, ...overrides });

test("allowance footers distinguish invalid resets, unknown limits, zero remaining funds and one contributor", () => {
  assert.equal(resetLabel("invalid-date"), "");
  assert.equal(resetLabel("2026-11-08T02:03:00Z"), "resets 2026-11-08 02:03 UTC");
  assert.match(allowanceLine("alice", { limit: null, spent: 0, left: null, resetsAt: null }), /allowance: unavailable/);
  assert.match(allowanceLine("alice", { limit: 0.05, spent: 0.05, left: null, resetsAt: "2026-11-08T02:03:00Z" }), /\$0\.0000 of \$0\.05 left today.*resets 2026-11-08 02:03 UTC/);
  assert.match(poolLine({ spentToday: 0.01, users: 1, ceilingUsd: 5 }), /by 1 contributor, ceiling/);
});

test("trace footers name singular and plural fallback attempts and tool summaries count repeated calls", () => {
  assert.match(traceLine({ ...trace, fallback: true, attempts: 2 }), /fallback\*\* after 1 failed attempt$/);
  assert.match(traceLine({ ...trace, fallback: true, attempts: 3 }), /fallback\*\* after 2 failed attempts$/);
  const tool = { id: "m", type: "mcp", status: "completed" };
  assert.equal(toolSummary([{ ...res, toolCalls: [tool] }, { ...res, toolCalls: [tool, { ...tool, type: "web_fetch" }] }]), "mcp ×2, web_fetch ×1");
});

test("repro comments show repair runs, missing sandbox fields and clipped output without ANSI or pip noise", () => {
  const run: ToolCall = { id: "x", type: "code_execution", status: "failed", stdout: "[notice] pip notice\n" + "x".repeat(1300) + "\u001b[31mTHE END\u001b[0m" };
  const comment = reproComment("alice", { kind: "ran", res, turns: [res, res], runs: [run, run], verdict: verdictFrom([run, run]), modelCostUsd: 0.002, repair: "setup repaired" }, null);
  assert.match(comment, /2 runs: the first failed to set up/);
  assert.match(comment, /_Note: setup repaired\._/);
  assert.match(comment, /return code `\?`/);
  assert.match(comment, /repair turn: Otari request `\?`/);
  assert.match(comment, /…x+THE END/);
  assert.doesNotMatch(comment, /pip notice/);
  assert.equal(comment.includes("\u001b"), false);
});

test("tool iteration exhaustion explains the missing verdict and other upstream errors keep their code", () => {
  const exhausted = refusalComment("alice", error({ status: 422, detail: "max_tool_iterations reached" }), null);
  assert.match(exhausted, /agent ran out of steps/);
  assert.match(exhausted, /Otari `422` max_tool_iterations reached/);
  assert.match(exhausted, /request `\?`/);
  assert.match(refusalComment("alice", error({ status: 422, detail: "invalid model", code: "bad_model" }), null), /Otari answered `422 bad_model`/);
});

test("welcome comments distinguish a bug without steps from a non-bug report", () => {
  assert.match(welcomeComment("alice", { kind: "bug", has_repro_steps: false, summary: "Needs inputs" }, null, trace), /bug\*\*, no reproduction steps yet\. Needs inputs/);
  assert.match(welcomeComment("alice", { kind: "feature", has_repro_steps: false, summary: "Add export" }, null, trace), /feature\*\*\. Add export/);
});

test("running comments allow no trigger marker and failed comments expose only error names", () => {
  assert.doesNotMatch(RUNNING("alice"), /allowance:repro:/);
  assert.match(failedComment("alice", "private response body"), /Allowance hit an error/);
  assert.doesNotMatch(failedComment("alice", "private response body"), /private response body/);
  assert.match(failedComment("alice", new DOMException("secret URL", "AbortError")), /did not answer in time/);
  assert.match(failedComment("alice", new Error("secret URL")), /Allowance hit an error/);
});
