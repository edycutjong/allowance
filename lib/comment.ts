// Renders the bot's GitHub comment. Every number in it comes from an Otari response.
import type { Allowance, ChatErr, ChatOk, Trace } from "./otari.ts";
import type { ReproResult, Verdict } from "./repro.ts";

const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export function resetLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `resets ${d.toISOString().slice(0, 10)} ${hh}:${mm} UTC`;
}

export const MAINTAINER = Symbol("maintainer");
export function allowanceLine(login: string, a: Allowance | null | typeof MAINTAINER): string {
  if (a === MAINTAINER) return `@${login} is a maintainer: charged to the repository pool, not a contributor allowance`;
  if (!a || a.limit == null) return `@${login}'s allowance: unavailable`;
  const reset = resetLabel(a.resetsAt);
  return `@${login}'s allowance: **${usd(a.left ?? 0)} of ${usd(a.limit)} left today**${reset ? " · " + reset : ""}`;
}

export function traceLine(t: Trace): string {
  const parts = [`model \`${t.model ?? "?"}\``, `provider \`${t.provider ?? "?"}\``];
  if (t.fallback) parts.push(`**fallback** after ${t.attempts - 1} failed attempt${t.attempts > 2 ? "s" : ""}`);
  if (t.requestId) parts.push(`Otari request \`${t.requestId}\``);
  return parts.join(" · ");
}

const BADGE: Record<Verdict["kind"], string> = {
  reproduced: "🔴 **Reproduced**",
  not_reproduced: "🟢 **Not reproduced**",
  inconclusive: "⚪ **Inconclusive**",
};

// pip's root/upgrade notices are sandbox noise, not evidence
const NOISE = /^(WARNING: Running pip as the 'root' user|\[notice\]|\s*warn\()/;
const tail = (s: string | undefined, n = 1200) => {
  const t = (s ?? "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((l) => !NOISE.test(l))
    .join("\n")
    .replace(/-{20,}(\w+Error)/g, "$1")
    .trim();
  return t.length > n ? "…" + t.slice(-n) : t;
};

export function toolSummary(res: ChatOk): string {
  const counts = new Map<string, number>();
  for (const c of res.toolCalls) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  if (!counts.size) return "no tools used";
  return [...counts].map(([k, v]) => `${k} ×${v}`).join(", ");
}

export function reproComment(login: string, r: ReproResult, a: Allowance | null | typeof MAINTAINER): string {
  if (r.kind === "refused") return refusalComment(login, r.res, a);
  const footer = (res: ChatOk, model: number, runs: number) =>
    `<sub>${allowanceLine(login, a)} · this run: model ${usd(model)}${runs ? ` + sandbox ×${runs}` : ""} · tools: ${toolSummary(res)}<br>${traceLine(res.trace)}</sub>`;
  if (r.kind === "no_script") {
    return [
      "### ⚪ **Inconclusive**: no runnable script",
      "",
      `> ${r.reason}`,
      "",
      "Nothing was run in the sandbox. Adding exact steps (input, expected, actual) to the issue usually fixes this.",
      "",
      "---",
      footer(r.res, r.modelCostUsd, 0),
    ].join("\n");
  }
  const { res, verdict, runs } = r;
  const run = verdict.run;
  const lines = [
    `### ${BADGE[verdict.kind]} — decided by the sandbox, not by the model`,
    "",
    `> ${verdict.reason}`,
    "",
    "The model only wrote the script. Allowance ran it in Otari's sandbox" + (runs.length > 1 ? ` (${runs.length} runs: the first failed to set up and the model repaired it)` : "") + ".",
    "",
  ];
  if (run) {
    lines.push(
      `Sandbox: return code \`${run.exit_code ?? "?"}\``,
      "",
      "<details><summary>Script that ran</summary>",
      "",
      "```python",
      (run.code ?? "").trim(),
      "```",
      "</details>",
      "",
      "<details><summary>Output</summary>",
      "",
      "```",
      tail([run.stdout, run.stderr].filter(Boolean).join("\n")),
      "```",
      "</details>",
      "",
    );
  }
  const note = res.content.replace(/```[\s\S]*?```/g, "").trim();
  if (note) lines.push(note, "");
  lines.push("---", footer(res, r.modelCostUsd, runs.length));
  return lines.join("\n");
}

export function refusalComment(login: string, e: ChatErr, a: Allowance | null | typeof MAINTAINER): string {
  if (e.code === "guardrail_violation") {
    const g = (e.detail as any)?.guardrails?.[0];
    return [
      "### 🛡️ Blocked by the guardrail",
      "",
      `The issue text was screened before any model saw it and was flagged${g?.explanation ? ` (${g.explanation}, score ${g.score})` : ""}.`,
      "No model was called and nothing was charged. A maintainer can review the issue and run `/repro` themselves.",
      "",
      `<sub>${allowanceLine(login, a)} · Otari \`403 guardrail_violation\` · request \`${e.trace.requestId ?? "?"}\`</sub>`,
    ].join("\n");
  }
  if (e.code === "budget_exceeded") {
    const who = e.budgetScope === "user" ? `@${login}'s daily allowance` : "this repository's shared pool";
    const wait = e.retryAfterSec ? ` Try again in about ${Math.ceil(e.retryAfterSec / 3600)} h.` : "";
    return [
      `### ⏳ Out of allowance`,
      "",
      `${who} cannot cover another reproduction run.${wait}`,
      "Other contributors are unaffected: every contributor has an allowance of their own.",
      "",
      `<sub>${allowanceLine(login, a)} · Otari \`403 budget_exceeded\` scope \`${e.budgetScope ?? "?"}\` · request \`${e.trace.requestId ?? "?"}\`</sub>`,
    ].join("\n");
  }
  if (e.status === 422 && /max_tool_iterations/.test(JSON.stringify(e.detail))) {
    return [
      "### ⚪ Inconclusive: the agent ran out of steps",
      "",
      "The model used every tool round it was allowed before reaching a sandbox verdict. Adding exact steps (input, expected, actual) to the issue usually fixes this.",
      "",
      `<sub>${allowanceLine(login, a)} · Otari \`422\` ${String((e.detail as string) ?? "")} · request \`${e.trace.requestId ?? "?"}\`</sub>`,
    ].join("\n");
  }
  return [
    "### ⚠️ Could not run",
    "",
    `Otari answered \`${e.status}${e.code ? " " + e.code : ""}\`.`,
    "",
    `<sub>request \`${e.trace.requestId ?? "?"}\`</sub>`,
  ].join("\n");
}

export function welcomeComment(login: string, t: { kind: string; has_repro_steps: boolean; summary: string } | null, a: Allowance | null, trace: Trace): string {
  const lines = [`👋 Thanks @${login}.`];
  if (t) lines.push("", `Triage: **${t.kind}**${t.kind === "bug" ? (t.has_repro_steps ? " with reproduction steps" : ", no reproduction steps yet") : ""}. ${t.summary}`);
  lines.push(
    "",
    "Comment `/repro` and I will write a minimal script, run it in a sandbox, and report whether the bug is real. The verdict comes from the sandbox exit code, not from a model.",
    "",
    `<sub>${allowanceLine(login, a)} · triage by ${traceLine(trace)}</sub>`,
  );
  return lines.join("\n");
}

export const RUNNING = (login: string) => `⏳ Reproducing for @${login} in a sandbox… this comment will update.`;
