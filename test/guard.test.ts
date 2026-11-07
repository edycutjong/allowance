import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, parseGuardOutput } from "../lib/guard.ts";

test("parses unsafe with categories", () => {
  assert.deepEqual(parseGuardOutput("Safety: Unsafe\nCategories: Jailbreak, PII"), {
    safety: "Unsafe",
    categories: ["Jailbreak", "PII"],
  });
});

test("parses safe with None category", () => {
  assert.deepEqual(parseGuardOutput("Safety: Safe\nCategories: None"), { safety: "Safe", categories: [] });
});

test("no verdict is inconclusive, not a pass", () => {
  const v = decide("prompt-injection", parseGuardOutput("garbage"));
  assert.equal(v.valid, null);
});

test("prompt-injection blocks unsafe and controversial jailbreak, passes safe", () => {
  assert.equal(decide("prompt-injection", parseGuardOutput("Safety: Unsafe\nCategories: PII")).valid, false);
  assert.equal(decide("prompt-injection", parseGuardOutput("Safety: Controversial\nCategories: Jailbreak")).valid, false);
  assert.equal(decide("prompt-injection", parseGuardOutput("Safety: Controversial\nCategories: Copyright Violation")).valid, false);
  assert.equal(decide("prompt-injection", parseGuardOutput("Safety: Safe")).valid, true);
});

test("issue-safety blocks only Unsafe", () => {
  assert.equal(decide("issue-safety", parseGuardOutput("Safety: Controversial\nCategories: Jailbreak")).valid, true);
  assert.equal(decide("issue-safety", parseGuardOutput("Safety: Unsafe\nCategories: Violent")).valid, false);
});
