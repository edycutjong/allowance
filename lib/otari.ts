// Thin Otari gateway client. Everything Allowance does with a model goes through here,
// so the response headers (request id, provider, model, fallback) are captured in one place.

export type OtariEnv = {
  OTARI_BASE_URL?: string;
  OTARI_API_KEY: string; // bot's own key: triage, guard
  OTARI_SERVICE_KEY: string; // service key: contributor work, billed per end user
};

export const baseUrl = (env: Pick<OtariEnv, "OTARI_BASE_URL">) => env.OTARI_BASE_URL ?? "https://api.otari.ai/api/v1";

export type ToolCall = {
  id: string;
  type: string; // code_execution | web_fetch | web_search | mcp ...
  status: string; // completed | failed
  code?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  [k: string]: unknown;
};

export type Trace = {
  requestId: string | null;
  provider: string | null;
  model: string | null;
  fallback: boolean;
  attempts: number;
  endUserBudget: string | null;
  durationMs: number | null;
};

export type ChatOk = {
  ok: true;
  status: number;
  content: string;
  toolCalls: ToolCall[];
  costUsd: number;
  trace: Trace;
};

export type ChatErr = {
  ok: false;
  status: number;
  code: string | null; // Otari-Error-Code: budget_exceeded | guardrail_violation | ...
  detail: unknown;
  budgetScope: string | null;
  retryAfterSec: number | null;
  trace: Trace;
};

export function readTrace(h: Headers): Trace {
  const n = (k: string) => {
    const v = h.get(k);
    return v == null ? null : Number(v);
  };
  return {
    requestId: h.get("otari-request-id"),
    provider: h.get("otari-provider"),
    model: h.get("otari-model"),
    fallback: h.get("otari-fallback") === "true",
    attempts: n("otari-attempt-count") ?? 1,
    endUserBudget: h.get("otari-end-user-budget"),
    durationMs: n("otari-response-duration-ms"),
  };
}

export async function chat(
  key: string,
  body: Record<string, unknown>,
  env: Pick<OtariEnv, "OTARI_BASE_URL">,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatOk | ChatErr> {
  const r = await fetchImpl(`${baseUrl(env)}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const trace = readTrace(r.headers);
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  if (!r.ok) {
    // guardrail refusals nest the code inside detail; budget refusals put it at top level
    const code = r.headers.get("otari-error-code") ?? json?.code ?? json?.detail?.code ?? null;
    const ra = r.headers.get("retry-after");
    return {
      ok: false,
      status: r.status,
      code,
      detail: json?.detail ?? text.slice(0, 500),
      budgetScope: r.headers.get("otari-budget-scope"),
      retryAfterSec: ra == null ? null : Number(ra),
      trace,
    };
  }
  return {
    ok: true,
    status: r.status,
    content: json?.choices?.[0]?.message?.content ?? "",
    toolCalls: (json?.otari_tool_calls ?? []) as ToolCall[],
    costUsd: Number(json?.usage?.cost_usd ?? 0),
    trace,
  };
}

export type EndUser = {
  external_id: string;
  spend: number;
  reserved: number;
  blocked: boolean;
  budget_id: string | null;
  next_budget_reset_at: string | null;
};

export type EndUserBudget = { budget_id: string; name: string; max_budget: number | null; is_default: boolean };

export async function getEndUser(
  externalId: string,
  env: Pick<OtariEnv, "OTARI_BASE_URL" | "OTARI_SERVICE_KEY">,
  fetchImpl: typeof fetch = fetch,
): Promise<EndUser | null> {
  const r = await fetchImpl(`${baseUrl(env)}/end-users?external_id=${encodeURIComponent(externalId)}`, {
    headers: { Authorization: `Bearer ${env.OTARI_SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`end-users ${r.status}`);
  const list = (await r.json()) as EndUser[];
  return list[0] ?? null;
}

export async function getEndUserBudgets(
  env: Pick<OtariEnv, "OTARI_BASE_URL" | "OTARI_SERVICE_KEY">,
  fetchImpl: typeof fetch = fetch,
): Promise<EndUserBudget[]> {
  const r = await fetchImpl(`${baseUrl(env)}/end-user-budgets`, {
    headers: { Authorization: `Bearer ${env.OTARI_SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`end-user-budgets ${r.status}`);
  return (await r.json()) as EndUserBudget[];
}

export type Allowance = { limit: number | null; spent: number; left: number | null; resetsAt: string | null };

export function allowanceOf(user: EndUser | null, budgets: EndUserBudget[]): Allowance {
  const b = budgets.find((x) => x.budget_id === user?.budget_id) ?? budgets.find((x) => x.is_default) ?? null;
  const limit = b?.max_budget ?? null;
  const spent = (user?.spend ?? 0) + (user?.reserved ?? 0);
  return {
    limit,
    spent,
    left: limit == null ? null : Math.max(0, limit - spent),
    resetsAt: user?.next_budget_reset_at ?? null,
  };
}
