// The gate a model-written script must pass before Allowance runs it. The sandbox only reports what a
// script did, so the gate fixes WHAT the script may do: it is an allowlist of one shape, the template the
// system prompt asks for (lib/repro.ts), not a list of forbidden tricks. Every line is tokenised (strings,
// comments and brackets are understood, not matched as substrings) and must be one of:
//
//   import subprocess, sys                                    setup: exactly these, once
//   subprocess.run([sys.executable, "-m", "pip", "install", "-q", "git+https://github.com/<repo>"], check=True)
//   from <project module> import <fn>  |  import <project module> [as m]
//   from datetime import date          (stdlib only for the value constructors in VALUE_CTORS)
//   actual = [list(]<fn>(<literals>)[)]                         the ONE call, at module level, result stored once
//   expected = <literal>                                      optional, a literal only
//   if actual != <literal | expected>:                        or: assert actual == <...>, "REPRODUCED: ..."
//       raise AssertionError("REPRODUCED: ..." + repr(actual))
//   print("NOT REPRODUCED")                                   last line
//
// Arguments and expectations are literals (numbers, strings, True/False/None, lists, tuples, dicts, sets,
// and pure constructors such as float("nan") or date(2026, 11, 2)): no other names, so nothing can rebind,
// alias, skip or swallow the call. What it does NOT prove: that the model's expected value is the right one
// (README "How a verdict is made"); the comparison direction is fixed (`!=` raises, `==` asserts).
// Anything else is refused, and the refusal is shown to the contributor.

// The one definition of the verdict marker: the gate, the system prompt and verdictFrom all read it (glm r07).
export const MARKER = "REPRODUCED:";

const STDLIB = new Set(
  ("abc argparse array ast asyncio base64 bisect builtins calendar collections contextlib copy csv dataclasses datetime " +
    "decimal difflib enum fractions functools glob hashlib heapq html http importlib inspect io ipaddress itertools json " +
    "locale logging math numbers operator os pathlib pickle platform pprint queue random re shlex shutil signal socket " +
    "statistics string struct subprocess sys tempfile textwrap threading time timeit traceback types typing unicodedata " +
    "unittest urllib uuid warnings weakref zlib zoneinfo").split(" "),
);
// Standard-library names a script may import to BUILD argument/expected values. Pure constructors only.
const VALUE_CTORS: Record<string, Set<string>> = {
  datetime: new Set(["date", "datetime", "time", "timedelta", "timezone"]),
  decimal: new Set(["Decimal"]),
  fractions: new Set(["Fraction"]),
  collections: new Set(["OrderedDict", "Counter", "deque"]),
};
// Builtins allowed inside a literal (pure constructors) and as a wrapper around the project call.
const BUILTIN_CTORS = new Set(["float", "int", "str", "bytes", "complex", "tuple", "list", "set", "frozenset", "dict", "range"]);
const WRAPPERS = new Set(["list", "tuple", "set", "frozenset", "sorted", "dict", "str", "repr", "len", "bool", "int", "float"]);
const KEYWORDS = new Set(("False None True and as assert async await break class continue def del elif else except finally for " +
  "from global if import in is lambda nonlocal not or pass raise return try while with yield match case").split(" "));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `body`: the test statements (everything after the setup lines), tokenised and re-joined, with the called
// project function written as § — a repair may change which module/function is imported, nothing else.
export type ScriptFacts = { symbol: string; condition: string; raise: string; body: string };

export function installPattern(repo: string): RegExp {
  // git+https://github.com/<repo> then an optional @ref, ending at a quote, whitespace or .git
  return new RegExp(`git\\+https://github\\.com/${escape(repo)}(\\.git)?(@[\\w./-]+)?(?=["'\\s]|$)`);
}

// ── tokenizer: one physical line ─────────────────────────────────────────────────────────────────────
// String tokens carry their text in `s` and a neutral `v`, so a string can never impersonate an operator or a name.
type Tok = { t: "name" | "num" | "str" | "fstr" | "op"; v: string; s?: string };

function tokenize(line: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "#") break; // comment to end of line
    if (c === "\\") return "uses a line continuation";
    const s = /^([rRbBuUfF]{0,2})(['"])/.exec(line.slice(i));
    if (s && (s[1] === "" || /^[A-Za-z]+$/.test(s[1]))) {
      const prefix = s[1].toLowerCase(), q = s[2];
      if (line.startsWith(q.repeat(3), i + s[1].length)) return "uses a triple-quoted string";
      let j = i + s[0].length, val = "";
      while (j < line.length && line[j] !== q) {
        if (line[j] === "\\") { val += line.slice(j, j + 2); j += 2; continue; }
        val += line[j++];
      }
      if (j >= line.length) return "has an unterminated string";
      if (prefix.includes("b") && prefix.includes("f")) return "uses an unknown string prefix";
      out.push({ t: prefix.includes("f") ? "fstr" : "str", v: "<string>", s: val });
      i = j + 1;
      continue;
    }
    const name = /^[A-Za-z_]\w*/.exec(line.slice(i));
    if (name) { out.push({ t: "name", v: name[0] }); i += name[0].length; continue; }
    const num = /^(\d[\d_]*\.?\d*([eE][+-]?\d+)?j?|\.\d+([eE][+-]?\d+)?j?)/.exec(line.slice(i));
    if (num) { out.push({ t: "num", v: num[0] }); i += num[0].length; continue; }
    const op = /^(==|!=|\*\*|[()[\]{},:.=+\-*])/.exec(line.slice(i));
    if (op) { out.push({ t: "op", v: op[0] }); i += op[0].length; continue; }
    return `uses "${c}", which the template does not allow`;
  }
  let depth = 0;
  for (const k of out) {
    if (k.t !== "op") continue;
    if ("([{".includes(k.v)) depth++;
    if (")]}".includes(k.v) && --depth < 0) return "has unbalanced brackets";
  }
  return depth === 0 ? out : "has unbalanced brackets (one statement per line)";
}

// ── recursive descent over tokens ────────────────────────────────────────────────────────────────────
class P {
  i = 0;
  k: Tok[];
  ctors: Set<string>;
  constructor(k: Tok[], ctors: Set<string>) { this.k = k; this.ctors = ctors; }
  peek(v?: string) { const t = this.k[this.i]; return t && (v === undefined || t.v === v) ? t : undefined; }
  eat(v: string) { if (this.peek(v)?.t === "op") { this.i++; return true; } return false; }
  done() { return this.i === this.k.length; }

  // literal := [+-] num | str+ | True | False | None | [items] | (items) | {items | k: v} | CTOR(args)
  literal(): boolean {
    const t = this.peek();
    if (!t) return false;
    if (t.t === "op" && (t.v === "-" || t.v === "+")) { this.i++; return this.peek()?.t === "num" ? (this.i++, true) : false; }
    if (t.t === "num") { this.i++; return true; }
    if (t.t === "str") { while (this.peek()?.t === "str") this.i++; return true; }
    if (t.t === "name" && (t.v === "True" || t.v === "False" || t.v === "None")) { this.i++; return true; }
    if (t.t === "name" && this.ctors.has(t.v) && this.k[this.i + 1]?.v === "(") { this.i += 2; return this.args(")"); }
    if (t.t === "op" && t.v === "[") { this.i++; return this.items("]", false); }
    if (t.t === "op" && t.v === "(") { this.i++; return this.items(")", false); }
    if (t.t === "op" && t.v === "{") { this.i++; return this.items("}", true); }
    return false;
  }
  items(close: string, dict: boolean): boolean {
    let first = true, isDict: boolean | null = null;
    while (!this.eat(close)) {
      if (!first && !this.eat(",")) return false;
      if (this.eat(close)) return true;
      if (!this.literal()) return false;
      if (dict) {
        const colon = this.eat(":");
        if (isDict === null) isDict = colon;
        if (colon !== isDict || (colon && !this.literal())) return false;
      }
      first = false;
    }
    return true;
  }
  // call arguments: literals, then name=literal keywords
  args(close = ")"): boolean {
    let first = true, kw = false;
    while (!this.eat(close)) {
      if (!first && !this.eat(",")) return false;
      if (this.eat(close)) return true;
      const t = this.peek(), next = this.k[this.i + 1];
      if (t?.t === "name" && next?.t === "op" && next.v === "=" && !KEYWORDS.has(t.v)) { this.i += 2; kw = true; if (!this.literal()) return false; }
      else if (kw || !this.literal()) return false;
      first = false;
    }
    return true;
  }
}

const join = (ks: Tok[]) => ks.map((k) => (k.t === "str" ? JSON.stringify(k.s) : k.t === "fstr" ? "f" + JSON.stringify(k.s) : k.v)).join(" ");

// "REPRODUCED: ..." [+ "..." | + repr(v) | + str(v)]*   or   f"REPRODUCED: ... {v!r} ..."
function markerMessage(k: Tok[], names: Set<string>): boolean {
  if (!k.length) return false;
  if (k[0].t === "fstr") {
    if (k.length !== 1 || !k[0].s!.startsWith(MARKER)) return false;
    return [...k[0].s!.matchAll(/\{([^}]*)\}/g)].every((m) => /^(\w+)(![rs])?$/.test(m[1]) && names.has(m[1].replace(/!.*/, "")));
  }
  if (k[0].t !== "str" || !k[0].s!.startsWith(MARKER)) return false;
  let i = 1;
  while (i < k.length) {
    if (k[i].t !== "op" || k[i].v !== "+") return false;
    if (k[i + 1]?.t === "str") { i += 2; continue; }
    const [f, open, v, close] = k.slice(i + 1, i + 5);
    if (!(f && open && v && close && (f.v === "repr" || f.v === "str") && open.v === "(" && names.has(v.v) && v.t === "name" && close.v === ")")) return false;
    i += 5;
  }
  return true;
}

type Line = { n: number; indent: number; text: string; toks: Tok[] };

export function checkScript(script: string, repo: string, issueText: string): { problem: string } | { facts: ScriptFacts } {
  const lines: Line[] = [];
  for (const [n, raw] of script.split("\n").entries()) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    if (raw.slice(0, raw.length - raw.trimStart().length).includes("\t")) return { problem: `line ${n + 1} is indented with a tab` };
    const toks = tokenize(raw);
    if (typeof toks === "string") return { problem: `line ${n + 1} ${toks}` };
    lines.push({ n: n + 1, indent: raw.length - raw.trimStart().length, text: raw.trim(), toks });
  }
  const at = (l: Line) => `line ${l.n} (\`${l.text.slice(0, 80)}\`)`;
  for (const l of lines) if (l.indent > 0 && !/^raise\b/.test(l.text)) return { problem: `${at(l)} is indented; only the raise under the if may be` };

  // ── setup ──────────────────────────────────────────────────────────────────────────────────────────
  const install = new RegExp(
    `^subprocess\\.run\\(\\[sys\\.executable,\\s*(["'])-m\\1,\\s*\\1pip\\1,\\s*\\1install\\1,(\\s*\\1-q\\1,)?\\s*\\1${installPattern(repo).source}\\1\\],\\s*check\\s*=\\s*True\\)$`,
  );
  const project = new Map<string, string>(); // local name -> original function name (from-imports)
  const modules = new Set<string>(); // local names bound to a project module (import pkg [as m])
  const ctors = new Set(BUILTIN_CTORS);
  let installs = 0, sysImported = false, subImported = false, i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i], t = l.text;
    if (/^import\s+(subprocess|sys)(\s*,\s*(subprocess|sys))?$/.test(t)) {
      if (/\bsys\b/.test(t)) sysImported = true;
      if (/\bsubprocess\b/.test(t)) subImported = true;
      continue;
    }
    if (/^subprocess\./.test(t)) {
      if (!install.test(t)) return { problem: `${at(l)} is not the one allowed install: pip install of github.com/${repo} with check=True and nothing else` };
      installs++;
      continue;
    }
    const from = /^from\s+([A-Za-z_][\w.]*)\s+import\s+(.+)$/.exec(t);
    if (from) {
      const top = from[1].split(".")[0];
      for (const part of from[2].replace(/^\((.*)\)$/, "$1").split(",")) {
        const m = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (!m || KEYWORDS.has(m[1]) || (m[2] && KEYWORDS.has(m[2]))) return { problem: `${at(l)} is not a plain import` };
        if (STDLIB.has(top)) {
          if (!VALUE_CTORS[from[1]]?.has(m[1])) return { problem: `${at(l)} imports ${m[1]} from the standard library; only value constructors (e.g. from datetime import date) are allowed` };
          ctors.add(m[2] ?? m[1]);
        } else project.set(m[2] ?? m[1], m[1]);
      }
      continue;
    }
    const imp = /^import\s+([A-Za-z_][\w.]*)(?:\s+as\s+(\w+))?$/.exec(t);
    if (imp) {
      if (STDLIB.has(imp[1].split(".")[0])) return { problem: `${at(l)} imports the standard library module ${imp[1]}; only subprocess and sys are allowed` };
      if (imp[1].includes(".") && !imp[2]) return { problem: `${at(l)} must alias a dotted import (import ${imp[1]} as m)` };
      modules.add(imp[2] ?? imp[1]);
      continue;
    }
    break;
  }
  if (installs !== 1) return { problem: `the script must pip-install ${repo} from GitHub exactly once (found ${installs})` };
  if (!sysImported || !subImported) return { problem: "the script must import subprocess and sys for the install" };
  if (!project.size && !modules.size) return { problem: "the script imports nothing from the project" };

  // ── the test: call, [expected], check, final print ─────────────────────────────────────────────────
  const body = lines.slice(i);
  const want = ["`actual = <project function>(...)`", "`if actual != <expected>:` + raise, or `assert actual == <expected>, ...`", '`print("NOT REPRODUCED")`'];
  if (body.length < 3) return { problem: `the script must end with ${want.join(", then ")}` };

  // mentioned: the issue names the function, loosely ("business_days()" for business_days_between)
  const words = new Set(issueText.match(/[A-Za-z_]\w*/g) ?? []);
  const mentioned = (s: string) =>
    words.has(s) || [...words].some((w) => (w.length >= 4 && s.startsWith(w + "_")) || (s.length >= 4 && w.startsWith(s + "_")));

  // 1. result = [WRAP(] CALL [)]
  const call = body[0], ck = call.toks;
  if (ck[0]?.t !== "name" || ck[1]?.v !== "=" || KEYWORDS.has(ck[0].v) || project.has(ck[0].v) || modules.has(ck[0].v) || ctors.has(ck[0].v)) {
    return { problem: `${at(call)}: the test must start with ${want[0]}` };
  }
  const result = ck[0].v;
  let j = 2, wrapped = false;
  if (ck[j]?.t === "name" && WRAPPERS.has(ck[j].v) && ck[j + 1]?.v === "(" && ck[j + 2]?.t === "name" && !ctors.has(ck[j + 2].v)) { j += 2; wrapped = true; }
  let symbol: string, symToks: number;
  if (ck[j]?.t === "name" && project.has(ck[j].v) && ck[j + 1]?.v === "(") { symbol = project.get(ck[j].v)!; symToks = 1; }
  else if (ck[j]?.t === "name" && modules.has(ck[j].v) && ck[j + 1]?.v === "." && ck[j + 2]?.t === "name" && ck[j + 3]?.v === "(") { symbol = ck[j + 2].v; symToks = 3; }
  else return { problem: `${at(call)} does not call a function imported from the project` };
  const local = ck[j].v;
  if (!mentioned(symbol) && !(symToks === 1 && mentioned(local))) return { problem: `the script calls ${symbol}, which the issue never names` };
  const p = new P(ck, ctors);
  p.i = j + symToks + 1;
  if (!p.args(")") || (wrapped && !p.eat(")")) || !p.done()) return { problem: `${at(call)}: the call's arguments must be literals (numbers, strings, lists, date(...) ...), and nothing may follow the call` };

  // 2. optional: expected = <literal>
  let k = 1, expected: string | null = null;
  const ek = body[k].toks;
  if (ek[0]?.t === "name" && ek[1]?.v === "=" && !/^(if|assert)$/.test(ek[0].v)) {
    const q = new P(ek, ctors);
    q.i = 2;
    if (ek[0].v === result || KEYWORDS.has(ek[0].v) || project.has(ek[0].v) || modules.has(ek[0].v) || ctors.has(ek[0].v) || !q.literal() || !q.done()) {
      return { problem: `${at(body[k])}: the expected value must be a literal assigned to a new name` };
    }
    expected = ek[0].v;
    k++;
  }
  const names = new Set([result, ...(expected ? [expected] : [])]);
  // the right-hand side of the comparison: a literal, or the expected name
  const rhs = (toks: Tok[], from: number, stop: number) => {
    if (stop === from + 1 && toks[from].t === "name" && toks[from].v === expected) return true;
    const q = new P(toks.slice(0, stop), ctors);
    q.i = from;
    return q.literal() && q.done();
  };

  // 3. the check
  const chk = body[k], kk = chk.toks;
  let condition: string, raise: string, last: number;
  if (kk[0]?.v === "if") {
    const okHead = kk[1]?.t === "name" && kk[1].v === result && kk[kk.length - 1].v === ":";
    const isNot = kk[2]?.v === "is" && kk[3]?.v === "not" && kk.length === 6 && /^(None|True|False)$/.test(kk[4].v);
    if (!okHead || !(isNot || (kk[2]?.v === "!=" && rhs(kk, 3, kk.length - 1)))) {
      return { problem: `${at(chk)}: the check must be \`if ${result} != <literal or expected>:\`` };
    }
    const r = body[k + 1];
    const rk = r?.toks ?? [];
    if (!r || r.indent === 0 || rk[0]?.v !== "raise" || rk[1]?.v !== "AssertionError" || rk[2]?.v !== "(" || rk[rk.length - 1].v !== ")" || !markerMessage(rk.slice(3, -1), names)) {
      return { problem: `the line under the if must be raise AssertionError("${MARKER} ...") built only from strings and repr(${result})` };
    }
    condition = chk.text; raise = r.text; last = k + 2;
  } else if (kk[0]?.v === "assert") {
    let depth = 0;
    const comma = kk.findIndex((x) => { if (x.t === "op" && "([{".includes(x.v)) depth++; if (x.t === "op" && ")]}".includes(x.v)) depth--; return depth === 0 && x.t === "op" && x.v === ","; });
    const isNone = kk[2]?.v === "is" && comma === 4 && /^(None|True|False)$/.test(kk[3].v);
    if (kk[1]?.v !== result || comma < 0 || !(isNone || (kk[2]?.v === "==" && rhs(kk, 3, comma))) || !markerMessage(kk.slice(comma + 1), names)) {
      return { problem: `${at(chk)}: the check must be \`assert ${result} == <literal or expected>, "${MARKER} ..."\`` };
    }
    condition = join(kk.slice(0, comma)); raise = chk.text; last = k + 1;
  } else return { problem: `${at(chk)}: after the call comes ${want[1]}` };

  // 4. the final print, and nothing after it
  const fin = body[last];
  if (!fin || fin.text.replace(/'/g, '"') !== 'print("NOT REPRODUCED")' || last !== body.length - 1) {
    return { problem: fin ? `${at(fin)}: the script must end with one ${want[2]} and nothing else` : `the script must end with ${want[2]}` };
  }

  const testBody = body
    .map((l) => join(l.toks.map((t, n): Tok => (l === call && n === j ? { t: "op", v: "§" } : t))))
    .join("\n");
  return { facts: { symbol, condition, raise, body: (symToks === 3 ? testBody.replace(` . ${symbol} (`, " (") : testBody) } };
}

// What a repair turn must keep token for token (string literals included): the whole test body.
export const assertionKey = (f: ScriptFacts) => f.body;

// Pin the install to the commit the verdict is about.
export function pinRevision(script: string, repo: string, sha: string | undefined): string {
  if (!sha) return script;
  return script.replace(new RegExp(installPattern(repo).source, "g"), `git+https://github.com/${repo}@${sha}`);
}
