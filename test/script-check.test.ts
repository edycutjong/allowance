import { test } from "node:test";
import assert from "node:assert/strict";
import { assertionKey, checkScript, pinRevision } from "../lib/script-check.ts";
import { runRepro, verdictFrom, type Issue } from "../lib/repro.ts";
import { reproComment } from "../lib/comment.ts";

const REPO = "o/r";
const ISSUE = "parse_duration('1h30m') returns 3630 instead of 5400";
const INSTALL = 'import subprocess, sys\nsubprocess.run([sys.executable, "-m", "pip", "install", "-q", "git+https://github.com/o/r"], check=True)';
const GOOD = `${INSTALL}\nfrom pocketkit import parse_duration\nactual = parse_duration("1h30m")\nif actual != 5400:\n    raise AssertionError("REPRODUCED: expected 5400, got " + repr(actual))\nprint("NOT REPRODUCED")`;
const problem = (s: string, issueText = ISSUE) => {
  const r = checkScript(s, REPO, issueText);
  return "problem" in r ? r.problem : null;
};

test("gate: the template script passes and names the symbol and the guard", () => {
  const r = checkScript(GOOD, REPO, ISSUE);
  assert.ok("facts" in r);
  if ("facts" in r) assert.deepEqual([r.facts.symbol, r.facts.condition], ["parse_duration", "if actual != 5400:"]);
});

test("gate: codex r03 control — fake marker on stdout, no install, unrelated raise — is refused, and its run would not count", () => {
  const fake = '# github.com/o/r\nprint("AssertionError: REPRODUCED: fabricated")\nraise RuntimeError("unrelated failure")';
  assert.match(problem(fake)!, /must pip-install o\/r from GitHub exactly once \(found 0\)/);
  const stderr = "RuntimeError                            Traceback (most recent call last)Cell In[1], line 3\nRuntimeError: unrelated failure";
  const v = verdictFrom([{ id: "x", type: "code_execution", status: "failed", exit_code: 1, stdout: "AssertionError: REPRODUCED: fabricated\n", stderr }]);
  assert.equal(v.kind, "inconclusive");
});

test("gate: kilo r03 control — print the marker then sys.exit(1) — is refused", () => {
  const s = `${INSTALL}\nfrom pocketkit import parse_duration\nparse_duration("1h30m")\nprint("AssertionError: REPRODUCED: expected X, got Y")\nsys.exit(1)`;
  assert.match(problem(s)!, /the test must start with `actual = <project function>/);
});

test("gate: an unconditional raise, or a call whose result is never tested, is refused", () => {
  const unconditional = `${INSTALL}\nfrom pocketkit import parse_duration\nactual = parse_duration("1h30m")\nraise AssertionError("REPRODUCED: x")`;
  assert.match(problem(unconditional)!, /the script must end with `actual = <project function>/);
  const unrelated = `${INSTALL}\nfrom pocketkit import parse_duration\nparse_duration("1h30m")\nif 1 != 2:\n    raise AssertionError("REPRODUCED: x")`;
  assert.match(problem(unrelated)!, /the test must start with/);
});

test("gate: look-alike repos, stdlib-only imports, functions the issue never names, re-definitions are refused", () => {
  assert.match(problem(GOOD.replace("github.com/o/r", "github.com/o/r-evil"))!, /is not the one allowed install/);
  assert.match(problem(GOOD.replace("from pocketkit import parse_duration", "from json import loads as parse_duration"))!, /imports loads from the standard library/);
  assert.match(problem(GOOD, "chunk() loses the tail")!, /calls parse_duration, which the issue never names/);
  assert.match(problem(GOOD.replace("actual =", "def parse_duration(s):\n    return 0\nactual ="))!, /is indented|the test must start with/);
});

test("gate: stderr writes, catch-all except and the marker outside a raise are refused", () => {
  assert.match(problem(GOOD + '\nsys.stderr.write("x")')!, /nothing else/);
  assert.match(problem(GOOD.replace('actual = parse_duration("1h30m")', 'try:\n    actual = parse_duration("1h30m")\nexcept Exception:\n    actual = 0'))!, /is indented; only the raise under the if may be/);
  assert.match(problem(GOOD + '\nprint("REPRODUCED: maybe")')!, /nothing else/);
});

test("gate: assert form and `import pkg` + pkg.fn() are accepted", () => {
  const a = `${INSTALL}\nimport pocketkit\nactual = pocketkit.parse_duration("1h30m")\nassert actual == 5400, "REPRODUCED: expected 5400, got " + repr(actual)\nprint("NOT REPRODUCED")`;
  assert.equal(problem(a), null);
});

test("pinRevision pins the install to the commit; the verdict names it", () => {
  const pinned = pinRevision(GOOD, REPO, "0123456789abcdef");
  assert.match(pinned, /git\+https:\/\/github\.com\/o\/r@0123456789abcdef"/);
  assert.equal(pinRevision(GOOD.replace("github.com/o/r", "github.com/o/r@main"), REPO, "abc").match(/@/g)!.length, 1);
});

const issue: Issue = { repo: REPO, number: 1, title: ISSUE, body: "", author: "a", url: "u", imageUrls: [] };
const env = { OTARI_API_KEY: "k", OTARI_SERVICE_KEY: "s", OTARI_BASE_URL: "https://o/api/v1" };
function fake(chats: string[], execs: object[]) {
  const ran: string[] = [];
  let c = 0, e = 0;
  const f = (async (url: string, init: any) => {
    if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: chats[Math.min(c++, chats.length - 1)] } }], usage: { cost_usd: 0.001 } });
    ran.push(JSON.parse(init.body).code);
    return Response.json(execs[Math.min(e++, execs.length - 1)]);
  }) as unknown as typeof fetch;
  return { f, ran };
}
const tb = (last: string) => `${last.split(":")[0]}     Traceback (most recent call last)Cell In[1], line 4\n${last}`;

test("repair: a repaired script that changes the assertion is not run; the first run stands", async () => {
  const changed = GOOD.replace("actual != 5400", "actual != 3630");
  const { f, ran } = fake(["```python\n" + GOOD + "\n```", "```python\n" + changed + "\n```"], [{ return_code: 1, stderr: tb("ModuleNotFoundError: No module named 'pocketkit'") }]);
  const r = await runRepro(issue, "a", {}, env, f);
  assert.equal(ran.length, 1);
  assert.equal(r.kind === "ran" && r.verdict.kind, "inconclusive");
  assert.match(r.kind === "ran" ? r.repair ?? "" : "", /changed the assertion/);
});

test("repair: a TypeError can be the bug itself, so it gets no repair turn", async () => {
  const { f, ran } = fake(["```python\n" + GOOD + "\n```"], [{ return_code: 1, stderr: tb("TypeError: unsupported operand type(s)") }]);
  const r = await runRepro(issue, "a", {}, env, f);
  assert.equal(ran.length, 1);
  assert.match(r.kind === "ran" ? r.verdict.reason : "", /ended with TypeError/);
});

test("run: the script that runs is pinned to the revision, and the comment says which", async () => {
  const { f, ran } = fake(["```python\n" + GOOD + "\n```"], [{ return_code: 1, stderr: tb("AssertionError: REPRODUCED: expected 5400, got 3630") }]);
  const r = await runRepro(issue, "a", { revision: "fedcba9876543210" }, env, f);
  assert.match(ran[0], /o\/r@fedcba9876543210/);
  assert.equal(r.kind === "ran" && r.verdict.kind, "reproduced");
  const c = reproComment("a", r, null);
  assert.match(c, /installs the real package at `fedcba9`/);
  assert.match(c, /o\/r@fedcba9876543210/);
});

test("repair identity (codex r04 F1): a new input or a changed literal is a different test; a renamed import is not", () => {
  const k = (src: string, issueText = ISSUE) => { const r = checkScript(src, REPO, issueText); return "facts" in r ? assertionKey(r.facts) : "refused: " + r.problem; };
  assert.notEqual(k(GOOD), k(GOOD.replace('parse_duration("1h30m")', 'parse_duration("0s")')));
  assert.notEqual(k(GOOD.replace("5400", '"a b"')), k(GOOD.replace("5400", '"ab"')));
  const renamed = GOOD.replace("from pocketkit import parse_duration", "from pocketkit.time import parse_duration_s as parse_duration");
  assert.equal(k(renamed), k(GOOD));
  const otherFn = GOOD.replace(/parse_duration/g, "parse_durations");
  assert.equal(k(otherFn, ISSUE + " parse_durations"), k(GOOD));
});

test("gate (deepseek r04 P0-1): a broken install cannot go green", () => {
  const swallow = GOOD.replace('from pocketkit import parse_duration\nactual = parse_duration("1h30m")', 'try:\n    from pocketkit import parse_duration\nexcept ImportError:\n    parse_duration = None\nactual = parse_duration("1h30m")');
  assert.match(problem(swallow)!, /is indented/);
  assert.match(problem(GOOD.replace(", check=True", ""))!, /with check=True and nothing else/);
  assert.match(problem(GOOD.replace('print("NOT REPRODUCED")', 'if actual == 5400:\n    print("NOT REPRODUCED")'))!, /must end with one|is indented/);
  assert.match(problem(GOOD + '\nprint("NOT REPRODUCED")')!, /nothing else/);
  assert.match(problem(GOOD.replace('import subprocess, sys', 'import subprocess, sys\nprint("NOT REPRODUCED")'))!, /must pip-install o\/r from GitHub exactly once \(found 0\)|the test must start with/);
});


test("gate: a loosely named function still counts (issue #7 says business_days(), the code is business_days_between)", () => {
  const s = GOOD.replace(/parse_duration/g, "business_days_between");
  assert.equal(problem(s, "business_days() is off by one over a weekend"), null);
  assert.match(problem(s, "format_duration() is off")!, /which the issue never names/);
  assert.match(problem(GOOD.replace(/parse_duration/g, "chunked"), "chunk() loses the tail")!, /which the issue never names/);
});

test("gate: grok r03 control and the fd-level bypasses found while verifying it are refused", () => {
  assert.match(problem(GOOD + '\nsys.stderr.write("AssertionError: REPRODUCED: x\\n")\nraise SystemExit(1)')!, /nothing else/);
  assert.match(problem(GOOD + "\nraise SystemExit(1)")!, /nothing else/);
  assert.match(problem(GOOD + '\nimport os\nos.write(2, b"AssertionError: REPRODUCED: x")\nos.abort()')!, /nothing else/);
  assert.match(problem(GOOD + '\nimport os\nos.write(2, b"Traceback (most recent call last)\\nAssertionError: REPRODUCED: x")')!, /nothing else/);
});

test("gate (found verifying r04): the tested function must come from the installed repository", () => {
  const extraInstall = GOOD.replace('from pocketkit import', 'subprocess.run([sys.executable, "-m", "pip", "install", "-q", "evilkit"], check=True)\nfrom pocketkit import');
  assert.match(problem(extraInstall)!, /is not the one allowed install/);
  assert.match(problem(GOOD.replace("from pocketkit import", 'open("pocketkit.py", "w")\nfrom pocketkit import'))!, /imports nothing from the project/);
  assert.match(problem(GOOD.replace("from pocketkit import", 'sys.path.insert(0, "/tmp")\nfrom pocketkit import'))!, /imports nothing from the project|is not the one allowed install/);
  assert.match(problem(GOOD.replace("from pocketkit import", 'import os\nos.system("pip install evilkit")\nfrom pocketkit import'))!, /imports the standard library module os/);
});

test("gate rejects reports without a named function and scripts without a reproduction assertion", () => {
  assert.match(problem(GOOD, "")!, /which the issue never names/);
  assert.match(problem(GOOD.replace('    raise AssertionError("REPRODUCED: expected 5400, got " + repr(actual))', '    print("wrong result")'))!, /is indented|the line under the if must be raise AssertionError/);
});

test("gate rejects extra green verdict text outside the final print", () => {
  assert.match(problem(GOOD + '\nmessage = "NOT REPRODUCED"')!, /nothing else/);
});

// ── a2a round 07 (heavy panel): the gate is an allowlist of the template, not a denylist ─────────────
import { readdirSync, readFileSync } from "node:fs";
const DEMO = "edycutjong/allowance-demo";
const titles: Record<string, string> = {
  "1": "parse_duration('1h30m') returns 3630 instead of 5400", "2": "business_days_between counts one day too few",
  "3": "chunk() loses the last items", "4": "dedupe() scrambles the order of items",
  "6": "chunk() loses the trailing items (screenshot)", "7": "business_days() is off by one over a weekend",
};

test("gate r07: every real script the model wrote on allowance-demo keeps its outcome (fixtures/real-scripts)", () => {
  const dir = new URL("../fixtures/real-scripts/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".py"));
  assert.ok(files.filter((f) => f.startsWith("pass-")).length >= 9);
  for (const f of files) {
    const issueNo = /-i(\d+)-/.exec(f)![1];
    const r = checkScript(readFileSync(new URL(f, dir), "utf8"), DEMO, titles[issueNo]);
    assert.equal("facts" in r, f.startsWith("pass-"), `${f}: ${"problem" in r ? r.problem : "accepted"}`);
  }
});

const T = (body: string) => `${INSTALL}\nfrom pocketkit import parse_duration\n${body}\nprint("NOT REPRODUCED")`;
const RAISE = '    raise AssertionError("REPRODUCED: x")';

test("gate r07 (codex F1): a call inside a string, or behind if False, never reaches the sandbox", () => {
  assert.match(problem(T(`actual = "parse_duration('1h30m')"\nif actual != 5400:\n${RAISE}`))!, /does not call a function imported from the project/);
  assert.match(problem(T(`if False:\n    actual = parse_duration("1h30m")\n    if actual != 5400:\n    ${RAISE}`))!, /is indented/);
});

test("gate r07 (codex F2, kimi, muse): the expectation cannot be rebound to the result, by alias, import or comment", () => {
  assert.match(problem(T(`actual = parse_duration("1h30m")\nimport math; expected = actual\nif actual != expected:\n${RAISE}`))!, /uses ";"/);
  assert.match(problem(T(`actual = parse_duration("1h30m")\nexpected = actual  # git+https://github.com/o/r\nif actual != expected:\n${RAISE}`))!, /expected value must be a literal/);
  assert.match(problem(T(`actual = parse_duration("1h30m")\nactual = 0\nif actual != 5400:\n${RAISE}`))!, /expected value must be a literal assigned to a new name/);
});

test("gate r07 (grok P0-1): dead ternaries, self-comparison and string comparisons are refused", () => {
  assert.match(problem(T(`actual = parse_duration("1h30m") if False else 0\nif actual != 5400:\n${RAISE}`))!, /nothing may follow the call/);
  assert.match(problem(T(`actual = parse_duration("1h30m")\nif actual != actual:\n${RAISE}`))!, /the check must be/);
  assert.match(problem(T(`actual = parse_duration("1h30m")\nif "actual" != "no":\n${RAISE}`))!, /the check must be/);
});

test("gate r07 (grok P0-2): the one install line cannot carry a second distribution, a chained command or a shell", () => {
  const body = `actual = parse_duration("1h30m")\nif actual != 5400:\n${RAISE}`;
  assert.match(problem(T(body).replace('"git+https://github.com/o/r"]', '"git+https://github.com/o/r", "evil-widgets"]'))!, /is not the one allowed install/);
  assert.match(problem(T(body).replace("check=True)", 'check=True); subprocess.run(["pip", "install", "evil"])'))!, /uses ";"/);
  assert.match(problem(T(body).replace(/subprocess\.run\(.*\)/, 'subprocess.run("pip install git+https://github.com/o/r && pip install evil", shell=True, check=True)'))!, /is not the one allowed install/);
});

test("gate r07 (deepseek P0-1/P1-1, glm P1-2, opus P1): rebinding, monkeypatching, spaced exits, with and except are refused", () => {
  assert.match(problem(T(`parse_duration = lambda s: 0\nactual = parse_duration("1h30m")\nif actual != 5400:\n${RAISE}`))!, /the test must start with/);
  assert.match(problem(T(`actual = parse_duration("1h30m")\npocketkit.parse_duration = None\nif actual != 5400:\n${RAISE}`))!, /after the call comes/);
  assert.match(problem(T(`actual = parse_duration("1h30m")\nif actual != 5400:\n${RAISE}\nsys .exit(0)`))!, /nothing else/);
  assert.match(problem(T(`import contextlib\nactual = parse_duration("1h30m")\nwith contextlib.suppress(AssertionError):\n${RAISE}`))!, /imports the standard library module contextlib/);
  assert.match(problem(T(`try:\n    actual = parse_duration("1h30m")\nexcept ValueError:\n    actual = 5400\nif actual != 5400:\n${RAISE}`))!, /is indented/);
});

test("gate r07 (opus P2): the comparison direction is fixed — the marker raises on != and asserts on ==", () => {
  assert.match(problem(T(`actual = parse_duration("1h30m")\nif actual == 5400:\n${RAISE}`))!, /the check must be `if actual != /);
  assert.match(problem(T(`actual = parse_duration("1h30m")\nassert actual != 5400, "REPRODUCED: x"`))!, /the check must be `assert actual == /);
  assert.equal(problem(T(`actual = parse_duration("1h30m")\nif actual is not None:\n${RAISE}`)), null);
  assert.equal(problem(T(`actual = parse_duration("1h30m")\nassert actual is None, "REPRODUCED: x"`)), null);
});

test("gate r07 (found verifying): arguments and the marker message cannot run other code", () => {
  assert.match(problem(T(`actual = parse_duration(open("/etc/passwd").read())\nif actual != 5400:\n${RAISE}`))!, /arguments must be literals/);
  assert.match(problem(T(`actual = parse_duration("1h30m")\nif actual != 5400:\n    raise AssertionError("REPRODUCED: " + __import__("os").popen("id").read())`))!, /built only from strings/);
  assert.match(problem(T(`actual = parse_duration(")" ("x"))\nif actual != 5400:\n${RAISE}`))!, /arguments must be literals/);
  assert.match(problem(T(`actual = parse_duration("1h30m")\nif actual != 5400:\n    raise AssertionError(f"REPRODUCED: {__import__('os')}")`))!, /built only from strings/);
});

test("gate r07 (kimi P1-3): the assert splits at the top-level comma, so list expectations work", () => {
  assert.equal(problem(T(`actual = parse_duration("1h30m")\nassert actual == [1, (2, 3)], "REPRODUCED: got " + repr(actual)`)), null);
  assert.equal(problem(T(`actual = parse_duration("1h30m")\nexpected = {"a": [1, 2], "b": None}\nassert actual == expected, f"REPRODUCED: {actual!r} vs {expected}"`)), null);
});

test("gate r07: the tokenizer and literal grammar refuse what they cannot read, and accept the literal forms the template needs", () => {
  const C = 'actual = parse_duration("1h30m")', IF = `if actual != 5400:\n${RAISE}`;
  const refused: [string, RegExp][] = [
    [T(`actual = parse_duration("1h30m") \\\nif actual != 5400:\n${RAISE}`), /line continuation/],
    [T(`actual = parse_duration("""1h30m""")\n${IF}`), /triple-quoted/],
    [T(`actual = parse_duration("1h30m)\n${IF}`), /unterminated string/],
    [T(`actual = parse_duration(bf"1h30m")\n${IF}`), /unknown string prefix/],
    [T(`actual = parse_duration("1h30m"))\n${IF}`), /unbalanced brackets/],
    [T(`actual = parse_duration("1h30m"\n${IF}`), /unbalanced brackets \(one statement per line\)/],
    [T(`${C}\nexpected =\n${IF}`), /expected value must be a literal/],
    [T(`${C}\nexpected = -x\n${IF}`), /expected value must be a literal/],
    [T(`${C}\nexpected = [1 2]\n${IF}`), /expected value must be a literal/],
    [T(`${C}\nexpected = [x]\n${IF}`), /expected value must be a literal/],
    [T(`${C}\nexpected = {1: 2, 3}\n${IF}`), /expected value must be a literal/],
    [T(`actual = parse_duration("1h30m", unit=x)\n${IF}`), /arguments must be literals/],
    [T(`actual = parse_duration(unit="s", 5)\n${IF}`), /arguments must be literals/],
    [T(`${C}\nif actual != 5400:\n    raise AssertionError()`), /built only from strings/],
    [T(`${C}\nif actual != 5400:\n    raise AssertionError("oops")`), /built only from strings/],
    [T(`${C}\nif actual != 5400:\n    raise AssertionError("REPRODUCED: x", repr(actual))`), /built only from strings/],
    [T(`${C}\nif actual != 5400:\n\traise AssertionError("REPRODUCED: x")`), /indented with a tab/],
    [T(`${C}\n${IF}`).replace("import parse_duration", "import parse_duration as if"), /is not a plain import/],
    [T(`${C}\n${IF}`).replace("import parse_duration", "import *"), /is not a plain import/],
    [T(`${C}\n${IF}`).replace("import subprocess, sys", "import subprocess"), /must import subprocess and sys/],
    [`${INSTALL}\nfrom pocketkit import parse_duration\n${C}\nexpected = 5400\nif actual != expected:`, /the line under the if must be raise/],
  ];
  for (const [src, why] of refused) assert.match(problem(src) ?? "accepted", why, src.split("\n").slice(2).join(" | "));
  const accepted = [
    T(`${C}\nexpected = -5\n${IF.replace("5400", "expected")}`),
    T(`${C}\nexpected = [1, 2,]\n${IF.replace("5400", "expected")}`),
    T(`actual = parse_duration("1h30m",)\n${IF}`),
    T(`actual = parse_duration("1h30m", unit="s")\n${IF}`),
    T(`actual = sorted(parse_duration({"a", "b"}, (1,), float("nan"), b"x", r"\\d", None))\n${IF}`),
  ];
  for (const src of accepted) assert.equal(problem(src), null, src.split("\n").slice(2).join(" | "));
});
