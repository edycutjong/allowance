// https://<deploy>/api/guard/<GUARD_TOKEN>/validate  — Otari guardrails contract
// https://<deploy>/api/guard/<GUARD_TOKEN>/profiles  — optional profile listing
// The token lives in the path because a request-body guardrail entry carries only a URL.
import { classify, decide, GUARD_MODEL, MAX_WINDOWS, PROFILES, windows } from "../../../lib/guard.js";

// Up to MAX_WINDOWS guard calls run in parallel, each capped at 20 s (lib/guard.ts).
export const config = { maxDuration: 60 };

function authorized(req: Request): boolean {
  const parts = new URL(req.url).pathname.split("/");
  const token = parts[parts.length - 2];
  const want = process.env.GUARD_TOKEN;
  return Boolean(want) && token === want;
}

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) return new Response("not found", { status: 404 });
  return Response.json(PROFILES.map((name) => ({ name, guardrail_name: GUARD_MODEL })));
}

export async function POST(req: Request): Promise<Response> {
  const ua = req.headers.get("user-agent") ?? "?";
  if (!authorized(req)) {
    console.log("guard 404", new URL(req.url).pathname.split("/").slice(-1)[0], ua);
    return new Response("not found", { status: 404 });
  }
  const raw = await req.text();
  let body: { profile?: string; input_text?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    console.log("guard bad json", ua, raw.slice(0, 200));
    return Response.json({ detail: "invalid json" }, { status: 400 });
  }
  console.log("guard request", ua, "keys=" + Object.keys(body).join(","), "len=" + (body.input_text ?? "").length);
  if (typeof body !== "object" || body === null || (body.input_text != null && typeof body.input_text !== "string")) {
    return Response.json({ detail: "input_text must be a string" }, { status: 400 });
  }
  const profile = typeof body.profile === "string" ? body.profile : "prompt-injection";
  const input = body.input_text ?? "";
  if (!input.trim()) return Response.json({ profile, result: { valid: true, explanation: "empty input", score: 0 } });
  // Every character the model will read is screened, or the request is refused (never truncated).
  if (windows(input).length > MAX_WINDOWS) {
    return Response.json({ profile, result: { valid: false, explanation: `input too long to screen (${input.length} characters)`, score: 1 } });
  }
  try {
    const { parsed, requestId } = await classify(input, {
      OTARI_API_KEY: process.env.OTARI_API_KEY ?? "",
      OTARI_BASE_URL: process.env.OTARI_BASE_URL,
    });
    const result = decide(profile, parsed);
    // No Safe/Unsafe verdict is not a pass: answer 5xx so a block-mode guardrail fails closed.
    if (result.valid === null) return Response.json({ detail: result.explanation }, { status: 502 });
    return Response.json({ profile, result }, { headers: requestId ? { "x-guard-otari-request-id": requestId } : {} });
  } catch (e) {
    // 5xx => Otari treats the check as unevaluable; a block entry then fails closed (502).
    return Response.json({ detail: String(e).slice(0, 200) }, { status: 502 });
  }
}
