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

export function allowanceLine(login: string, a: Allowance | null): string {
  if (!a || a.limit == null) return `@${login}'s allowance: unavailable`;
  return `@${login}'s allowance: **${usd(a.left ?? 0)} of ${usd(a.limit)} left today** · ${resetLabel(a.resetsAt)}`.trim();
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

const tail = (s: string | undefined, n = 1200) => {
  const t = (s ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim();
  return t.length > n ? "…" + t.slice(-n) : t;
};

export function toolSummary(res: ChatOk): string {
  const counts = new Map<string, number>();
  for (const c of res.toolCalls) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  if (!counts.size) return "no tools used";
  return [...counts].map(([k, v]) => `${k} ×${v}`).join(", ");
}

export function reproComment(login: string, r: ReproResult, a: Allowance | null): string {
  if (r.kind === "refused") return refusalComment(login, r.res, a);
  const { res, verdict } = r;
  const run = verdict.run;
  const lines = [
    `### ${BADGE[verdict.kind]} — decided by the sandbox exit code, not by the model`,
    "",
    `> ${verdict.reason}`,
    "",
  ];
  if (run) {
    lines.push(
      `Sandbox: status \`${run.status}\`, exit code \`${run.exit_code ?? "?"}\` (run ${verdict.runs} of ${verdict.runs}).`,
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
  if (res.content.trim()) lines.push(res.content.trim(), "");
  lines.push(
    "---",
    `<sub>${allowanceLine(login, a)} · this run cost ${usd(res.costUsd)} · tools: ${toolSummary(res)}<br>${traceLine(res.trace)}</sub>`,
  );
  return lines.join("\n");
}

export function refusalComment(login: string, e: ChatErr, a: Allowance | null): string {
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
