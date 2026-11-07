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
  assert.match(problem(fake)!, /does not pip-install/);
  const stderr = "RuntimeError                            Traceback (most recent call last)Cell In[1], line 3\nRuntimeError: unrelated failure";
  const v = verdictFrom([{ id: "x", type: "code_execution", status: "failed", exit_code: 1, stdout: "AssertionError: REPRODUCED: fabricated\n", stderr }]);
  assert.equal(v.kind, "inconclusive");
});

test("gate: kilo r03 control — print the marker then sys.exit(1) — is refused", () => {
  const s = `${INSTALL}\nfrom pocketkit import parse_duration\nparse_duration("1h30m")\nprint("AssertionError: REPRODUCED: expected X, got Y")\nsys.exit(1)`;
  assert.match(problem(s)!, /exit function/);
});

test("gate: an unconditional raise, or a call whose result is never tested, is refused", () => {
  const unconditional = `${INSTALL}\nfrom pocketkit import parse_duration\nactual = parse_duration("1h30m")\nraise AssertionError("REPRODUCED: x")`;
  assert.match(problem(unconditional)!, /not guarded by an if/);
  const unrelated = `${INSTALL}\nfrom pocketkit import parse_duration\nparse_duration("1h30m")\nif 1 != 2:\n    raise AssertionError("REPRODUCED: x")`;
  assert.match(problem(unrelated)!, /does not use the call's result/);
});

test("gate: look-alike repos, stdlib-only imports, functions the issue never names, re-definitions are refused", () => {
  assert.match(problem(GOOD.replace("github.com/o/r", "github.com/o/r-evil"))!, /does not pip-install/);
  assert.match(problem(GOOD.replace("from pocketkit import parse_duration", "from json import loads as parse_duration"))!, /imports nothing from the project/);
  assert.match(problem(GOOD, "chunk() loses the tail")!, /never calls a project function that the issue names/);
  assert.match(problem(GOOD.replace("actual =", "def parse_duration(s):\n    return 0\nactual ="))!, /re-defines parse_duration/);
});

test("gate: stderr writes, catch-all except and the marker outside a raise are refused", () => {
  assert.match(problem(GOOD + '\nsys.stderr.write("x")')!, /output streams/);
  assert.match(problem(GOOD.replace('actual = parse_duration("1h30m")', 'try:\n    actual = parse_duration("1h30m")\nexcept Exception:\n    actual = 0'))!, /catch-all/);
  assert.match(problem(GOOD + '\nprint("REPRODUCED: maybe")')!, /outside a raise/);
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

test("assertionKey ignores whitespace only", () => {
  const k = (s: string) => { const r = checkScript(s, REPO, ISSUE); return "facts" in r ? assertionKey(r.facts) : ""; };
  assert.equal(k(GOOD), k(GOOD.replace("if actual != 5400:", "if  actual  !=  5400 :")));
});

test("gate: a loosely named function still counts (issue #7 says business_days(), the code is business_days_between)", () => {
  const s = GOOD.replace(/parse_duration/g, "business_days_between");
  assert.equal(problem(s, "business_days() is off by one over a weekend"), null);
  assert.match(problem(s, "format_duration() is off")!, /never calls a project function that the issue names/);
  assert.match(problem(GOOD.replace(/parse_duration/g, "chunked"), "chunk() loses the tail")!, /never calls/);
});
