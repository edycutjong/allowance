// GitHub App webhook endpoint. The logic lives in lib/webhook.ts (tested); this file wires it to Vercel.
import { waitUntil } from "@vercel/functions";
import { envFromProcess, handleWebhook } from "../lib/webhook.js";

export const config = { maxDuration: 300 };

export function POST(req: Request): Promise<Response> {
  return handleWebhook(req, { env: envFromProcess(), waitUntil });
}

export async function GET(): Promise<Response> {
  return Response.json({ ok: true, service: "allowance webhook" });
}
