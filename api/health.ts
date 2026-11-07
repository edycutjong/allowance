// Liveness probe: deploy checks and the landing page read this.
import pkg from "../package.json" with { type: "json" };

export async function GET(): Promise<Response> {
  return Response.json(
    { status: "ok", service: "allowance", version: pkg.version, commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
