// Guardrail service for Otari's `guardrails` request field.
// Otari POSTs {profile, input_text, validate_kwargs} to our URL and expects
// {profile, result: {valid, explanation, score}}; valid:false + mode:block => Otari answers 403
// and never calls the provider. The verdict comes from an open-weight guard model
// (Qwen3Guard-Gen-8B) that we ourselves call through Otari.

export const GUARD_MODEL = "alibaba/qwen3guard-gen-8b";
const MAX_INPUT_CHARS = 12_000;

export type Verdict = { valid: boolean | null; explanation: string | null; score: number };

export type ParsedGuard = { safety: "Safe" | "Unsafe" | "Controversial" | null; categories: string[] };

// Qwen3Guard-Gen answers e.g. "Safety: Unsafe\nCategories: Jailbreak, PII"
export function parseGuardOutput(text: string): ParsedGuard {
  const safety = /Safety:\s*(Safe|Unsafe|Controversial)/i.exec(text)?.[1];
  const cats = /Categories:\s*([^\n]+)/i.exec(text)?.[1] ?? "";
  const norm = safety ? (safety[0].toUpperCase() + safety.slice(1).toLowerCase()) as ParsedGuard["safety"] : null;
  return {
    safety: norm,
    categories: cats.split(",").map((c) => c.trim()).filter((c) => c && c.toLowerCase() !== "none"),
  };
}

// Profiles map the guard model's labels onto a block decision.
//  prompt-injection : block jailbreak / instruction-override attempts and secret-exfil asks (PII)
//  issue-safety     : block anything the guard calls Unsafe
export const PROFILES = ["prompt-injection", "issue-safety"] as const;
export type Profile = (typeof PROFILES)[number];

export function decide(profile: string, g: ParsedGuard): Verdict {
  if (!g.safety) return { valid: null, explanation: "guard model gave no verdict", score: 0.5 };
  const label = `${GUARD_MODEL}: ${g.safety}${g.categories.length ? ` (${g.categories.join(", ")})` : ""}`;
  // The guard's category label for one attack varies run to run (Jailbreak / PII / Copyright),
  // while its Safe-vs-not judgement is stable, so prompt-injection blocks on the judgement.
  const flagged = profile === "issue-safety" ? g.safety === "Unsafe" : g.safety !== "Safe";
  const score = g.safety === "Unsafe" ? 0.95 : g.safety === "Controversial" ? 0.6 : 0.05;
  return { valid: !flagged, explanation: label, score };
}

// The guard reads the WHOLE input: text past one window used to be cut off unscreened, so an
// instruction placed after 12,000 characters of padding reached the coder. Windows overlap so a
// payload split across a boundary is still read whole; past MAX_WINDOWS the input is refused.
export const MAX_WINDOWS = 4;
const OVERLAP_CHARS = 1_000;

export function windows(text: string, size = MAX_INPUT_CHARS, overlap = OVERLAP_CHARS): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return out;
}

const RANK = { Safe: 0, Controversial: 1, Unsafe: 2 } as const;

// The least safe window decides; categories are the union.
export function worst(parts: ParsedGuard[]): ParsedGuard {
  if (parts.some((g) => !g.safety)) return { safety: null, categories: [] };
  const safety = parts.reduce<ParsedGuard["safety"]>((a, g) => (RANK[g.safety!] > RANK[a!] ? g.safety : a), "Safe");
  return { safety, categories: [...new Set(parts.flatMap((g) => g.categories))] };
}

const GUARD_TIMEOUT_MS = 20_000;

async function classifyOne(
  text: string,
  env: { OTARI_API_KEY: string; OTARI_BASE_URL?: string },
  fetchImpl: typeof fetch,
): Promise<{ parsed: ParsedGuard; requestId: string | null }> {
  const base = env.OTARI_BASE_URL ?? "https://api.otari.ai/api/v1";
  const r = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OTARI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GUARD_MODEL,
      max_tokens: 40,
      temperature: 0,
      messages: [{ role: "user", content: text }],
      metadata: { component: "allowance-guard" },
    }),
    signal: AbortSignal.timeout(GUARD_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`otari ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return { parsed: parseGuardOutput(d.choices?.[0]?.message?.content ?? ""), requestId: r.headers.get("otari-request-id") };
}

export async function classify(
  inputText: string,
  env: { OTARI_API_KEY: string; OTARI_BASE_URL?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ parsed: ParsedGuard; requestId: string | null; windows: number }> {
  const parts = windows(inputText);
  if (parts.length > MAX_WINDOWS) {
    return { parsed: { safety: "Unsafe", categories: ["too long to screen"] }, requestId: null, windows: parts.length };
  }
  const results = await Promise.all(parts.map((t) => classifyOne(t, env, fetchImpl)));
  return { parsed: worst(results.map((r) => r.parsed)), requestId: results[0].requestId, windows: parts.length };
}
