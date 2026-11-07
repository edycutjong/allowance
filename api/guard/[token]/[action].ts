// https://<deploy>/api/guard/<GUARD_TOKEN>/validate  — Otari guardrails contract
// https://<deploy>/api/guard/<GUARD_TOKEN>/profiles  — optional profile listing
// The token lives in the path because a request-body guardrail entry carries only a URL.
import { classify, decide, GUARD_MODEL, PROFILES } from "../../../lib/guard.js";

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
  const profile = body.profile ?? "prompt-injection";
  const input = body.input_text ?? "";
  if (!input.trim()) return Response.json({ profile, result: { valid: true, explanation: "empty input", score: 0 } });
  try {
    const { parsed, requestId } = await classify(input, {
      OTARI_API_KEY: process.env.OTARI_API_KEY ?? "",
      OTARI_BASE_URL: process.env.OTARI_BASE_URL,
    });
    const result = decide(profile, parsed);
    return Response.json({ profile, result }, { headers: requestId ? { "x-guard-otari-request-id": requestId } : {} });
  } catch (e) {
    // 5xx => Otari treats the check as unevaluable; a block entry then fails closed (502).
    return Response.json({ detail: String(e).slice(0, 200) }, { status: 502 });
  }
}
