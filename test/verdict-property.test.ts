// Property tests for the one decision that must never be wrong: the verdict.
// Thousands of generated sandbox runs (stdout, stderr, exit code, status, earlier runs) are fed to verdictFrom,
// and the invariants below must hold for every one. Case counts are printed so README numbers stay greppable.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { MARKER, verdictFrom } from "../lib/repro.ts";
import type { ToolCall } from "../lib/otari.ts";

const RUNS = 5000;

const fragment = fc.oneof(
  fc.constant(`AssertionError: ${MARKER} expected 5400, got 3630`),
  fc.constant(`    raise AssertionError("${MARKER} expected " + repr(x))`),
  fc.constant(`${MARKER} expected 1, got 2`),
  fc.constant("NOT REPRODUCED"),
  fc.constant("RuntimeError: SETUP: pip install failed"),
  fc.constant("Traceback (most recent call last):"),
  fc.constant('  File "<stdin>", line 7, in <module>'),
  fc.constant("ValueError: invalid literal"),
  fc.constant("ModuleNotFoundError: No module named 'pocketkit'"),
  fc.constant("Successfully installed pocketkit-0.3.1"),
  fc.constant("[notice] A new release of pip is available"),
  fc.constant("\x1b[31mAssertionError\x1b[0m: " + MARKER + " colored"),
  fc.string({ maxLength: 40 }),
);
const stream = fc.array(fragment, { maxLength: 8 }).map((xs) => xs.join("\n"));
const exitCode = fc.constantFrom(0, 1, 2, -1, 137);
const status = fc.constantFrom("completed", "failed");

const run = fc.record({ stdout: stream, stderr: stream, exit_code: exitCode, status }).map(
  (r, i = 0): ToolCall => ({ id: `r${i}`, type: "code_execution", code: "print()", ...r }),
);
const failedOf = (r: ToolCall) => r.status === "failed" || (typeof r.exit_code === "number" && r.exit_code !== 0);

let cases = 0;
const seen = { reproduced: 0, not_reproduced: 0 };
const prop = <T>(arb: fc.Arbitrary<T>, f: (x: T) => void) =>
  fc.assert(
    fc.property(arb, (x) => {
      cases++;
      f(x);
    }),
    { numRuns: RUNS, seed: 20261108 },
  );

test("property: Reproduced only ever comes from a FAILED run whose stderr ends in the marker assertion", () => {
  prop(run, (r) => {
    const v = verdictFrom([r]);
    if (v.kind === "reproduced") {
      seen.reproduced++;
      assert.ok(failedOf(r), "a passing run produced Reproduced");
      assert.ok(v.reason.startsWith(MARKER), "Reproduced without the marker in its reason");
      assert.ok((r.stderr ?? "").includes("AssertionError"), "Reproduced without an AssertionError in stderr");
    }
  });
});

test("property: Not reproduced only ever comes from a run that exited cleanly with NOT REPRODUCED on stdout", () => {
  prop(run, (r) => {
    const v = verdictFrom([r]);
    if (v.kind === "not_reproduced") {
      seen.not_reproduced++;
      assert.ok(!failedOf(r), "a failed run produced Not reproduced");
      assert.ok((r.stdout ?? "").includes("NOT REPRODUCED"));
    }
  });
});

test("property: the marker printed to stdout (stderr clean) can never produce Reproduced", () => {
  prop(fc.tuple(run, stream), ([r, out]) => {
    const v = verdictFrom([{ ...r, stdout: `${out}\nAssertionError: ${MARKER} fake\n`, stderr: "" }]);
    assert.notEqual(v.kind, "reproduced");
  });
});

test("property: only the LAST run decides — any earlier runs change nothing", () => {
  prop(fc.tuple(fc.array(run, { maxLength: 4 }), run), ([earlier, last]) => {
    assert.equal(verdictFrom([...earlier, last]).kind, verdictFrom([last]).kind);
  });
});

test("property: non-sandbox tool calls (model prose, web fetch, MCP) never change the verdict", () => {
  const noise = fc.record({ id: fc.string(), type: fc.constantFrom("web_fetch", "mcp", "web_search"), status, stdout: stream, stderr: stream });
  prop(fc.tuple(fc.array(noise, { maxLength: 4 }), run), ([extra, r]) => {
    assert.equal(verdictFrom([r, ...(extra as ToolCall[])]).kind, verdictFrom([r]).kind);
  });
});

test("property: case count", () => {
  assert.equal(cases, RUNS * 5);
  // not vacuous: the generator reaches both positive verdicts
  assert.ok(seen.reproduced > 20 && seen.not_reproduced > 20, JSON.stringify(seen));
  console.log(`verdict property cases: ${cases} (reproduced ${seen.reproduced}, not reproduced ${seen.not_reproduced})`);
});
