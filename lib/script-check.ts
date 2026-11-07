// The gate a model-written script must pass before Allowance runs it. The sandbox only reports what a
// script did; this check is what makes "the script failed" mean "the project's code returned the wrong
// value". A script is run only if it:
//   1. installs THIS repository from GitHub (exact URL, no look-alike prefix),
//   2. imports something that is not the standard library,
//   3. calls an imported name that the issue itself mentions,
//   4. raises the REPRODUCED marker only under a condition on that call's result (if/elif/assert),
//   5. cannot fake an outcome: no exit calls, no writes to stderr, no catch-all except, the marker
//      nowhere but on the raise, and no re-definition of the function under test.
// It is a line-based check of the template the system prompt asks for, not a Python parser: anything
// it cannot read is refused, and the refusal is shown to the contributor.

const MARKER = "REPRODUCED:";

const STDLIB = new Set(
  ("abc argparse array ast asyncio base64 bisect builtins calendar collections contextlib copy csv dataclasses datetime " +
    "decimal difflib enum fractions functools glob hashlib heapq html http importlib inspect io ipaddress itertools json " +
    "locale logging math numbers operator os pathlib pickle platform pprint queue random re shlex shutil signal socket " +
    "statistics string struct subprocess sys tempfile textwrap threading time timeit traceback types typing unicodedata " +
    "unittest urllib uuid warnings weakref zlib zoneinfo").split(" "),
);

const FORBIDDEN: [RegExp, string][] = [
  [/\b(sys\.exit|os\._exit|os\.kill|exit|quit)\s*\(/, "calls an exit function"],
  [/\bsys\.(stderr|stdout)\b|\bfile\s*=\s*sys\./, "writes to the output streams directly"],
  [/\bexcept\s*(:|\(?\s*(AssertionError|Exception|BaseException)\b)/, "catches the assertion (catch-all except)"],
  [/\b(exec|eval|compile)\s*\(|__import__\s*\(/, "runs dynamic code"],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const indent = (l: string) => l.length - l.trimStart().length;

export type ScriptFacts = { symbol: string; condition: string; raise: string };

export function installPattern(repo: string): RegExp {
  // git+https://github.com/<repo> then an optional @ref, ending at a quote, whitespace or .git
  return new RegExp(`git\\+https://github\\.com/${escape(repo)}(\\.git)?(@[\\w./-]+)?(?=["'\\s]|$)`);
}

export function checkScript(script: string, repo: string, issueText: string): { problem: string } | { facts: ScriptFacts } {
  const lines = script.split("\n");
  const code = lines.filter((l) => !l.trimStart().startsWith("#"));
  const body = code.join("\n");

  if (!/pip/.test(body) || !installPattern(repo).test(body)) return { problem: `the script does not pip-install ${repo} from GitHub` };
  for (const [re, why] of FORBIDDEN) if (re.test(body)) return { problem: `the script ${why}` };

  // 2. imports: from X import a, b as c  |  import X
  const names = new Map<string, string>(); // callable name -> module
  for (const l of code) {
    const from = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(l);
    if (from && !STDLIB.has(from[1].split(".")[0])) {
      for (const part of from[2].replace(/[()]/g, "").split(",")) {
        const m = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (m) names.set(m[2] ?? m[1], m[1]);
      }
    }
    const imp = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(l);
    if (imp && !STDLIB.has(imp[1].split(".")[0])) names.set(imp[2] ?? imp[1], imp[1]);
  }
  if (!names.size) return { problem: "the script imports nothing from the project" };

  // 3. a call to an imported name that the issue mentions (for `import pkg`, a call to pkg.<name>)
  // Reporters name functions loosely ("business_days()" for business_days_between), so a name counts as
  // mentioned when an identifier in the issue equals it or extends/shortens it at an underscore boundary.
  const tokens = new Set(issueText.match(/[A-Za-z_]\w*/g) ?? []);
  const mentioned = (s: string) =>
    tokens.has(s) || [...tokens].some((t) => (t.length >= 4 && s.startsWith(t + "_")) || (s.length >= 4 && t.startsWith(s + "_")));
  const calls: { symbol: string; re: RegExp }[] = [];
  for (const [local, original] of names) {
    if (new RegExp(`\\b${escape(local)}\\s*\\(`).test(body) && (mentioned(original) || mentioned(local))) {
      calls.push({ symbol: original, re: new RegExp(`\\b${escape(local)}\\s*\\(`) });
    }
    for (const m of body.matchAll(new RegExp(`\\b${escape(local)}\\.(\\w+)\\s*\\(`, "g"))) {
      if (mentioned(m[1])) calls.push({ symbol: m[1], re: new RegExp(`\\b${escape(local)}\\.${escape(m[1])}\\s*\\(`) });
    }
  }
  if (!calls.length) return { problem: "the script never calls a project function that the issue names" };
  for (const c of calls) {
    if (new RegExp(`^\\s*(def|class)\\s+${escape(c.symbol)}\\b`, "m").test(body)) return { problem: `the script re-defines ${c.symbol} instead of testing it` };
  }

  // values that came from the call: `actual = <...call...>`
  const results = new Set<string>();
  for (const l of code) {
    const a = /^\s*(\w+)\s*=\s*(.+)$/.exec(l);
    if (a && calls.some((c) => c.re.test(a[2]))) results.add(a[1]);
  }
  const usesResult = (s: string) => calls.some((c) => c.re.test(s)) || [...results].some((v) => new RegExp(`\\b${escape(v)}\\b`).test(s));

  // 4. the marker: only on raise/assert lines, and each one guarded by a condition on the result
  const markerLines = code.map((l, i) => [l, i] as const).filter(([l]) => l.includes(MARKER));
  if (!markerLines.length) return { problem: "the script has no REPRODUCED assertion" };
  let facts: ScriptFacts | null = null;
  for (const [l, i] of markerLines) {
    const t = l.trim();
    if (/^assert\s/.test(t)) {
      if (!usesResult(t.slice(0, t.indexOf(","))) || !t.includes(",")) return { problem: "the REPRODUCED assert does not test the call's result" };
      facts ??= { symbol: calls[0].symbol, condition: t.slice(0, t.indexOf(",")).trim(), raise: t };
      continue;
    }
    if (!/^raise\s+AssertionError\s*\(/.test(t)) return { problem: "REPRODUCED appears outside a raise AssertionError" };
    // the nearest less-indented line above must be the if/elif that guards it
    let j = i - 1;
    while (j >= 0 && (code[j].trim() === "" || indent(code[j]) >= indent(l))) j--;
    const header = j >= 0 ? code[j].trim() : "";
    if (indent(l) === 0 || !/^(if|elif)\s.+:$/.test(header)) return { problem: "the REPRODUCED raise is not guarded by an if on the result" };
    if (!usesResult(header)) return { problem: "the condition guarding REPRODUCED does not use the call's result" };
    facts ??= { symbol: calls[0].symbol, condition: header, raise: t };
  }
  return { facts: facts! };
}

// The assertion the repair turn must keep: the guarding condition and the raise, whitespace-normalised.
export const assertionKey = (f: ScriptFacts) => `${f.condition}=>${f.raise}`.replace(/\s+/g, "");

// Pin the install to the commit the verdict is about.
export function pinRevision(script: string, repo: string, sha: string | undefined): string {
  if (!sha) return script;
  return script.replace(new RegExp(installPattern(repo).source, "g"), `git+https://github.com/${repo}@${sha}`);
}
