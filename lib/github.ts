// Minimal GitHub App client: webhook signature check, app JWT, installation token, comments, labels.
import { createHmac, createSign, timingSafeEqual } from "node:crypto";

export function verifySignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const want = Buffer.from("sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function appJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: nowSec - 60, exp: nowSec + 540, iss: appId })}`;
  return `${data}.${createSign("RSA-SHA256").update(data).sign(privateKeyPem, "base64url")}`;
}

const API = "https://api.github.com";
// GitHub answers in well under a second; a hung call must fail inside the function's 300 s budget.
const GITHUB_TIMEOUT_MS = 15_000;
const baseHeaders = { Accept: "application/vnd.github+json", "User-Agent": "allowance-bot", "X-GitHub-Api-Version": "2022-11-28" };

export async function installationToken(appId: string, pem: string, installationId: number, fetchImpl: typeof fetch = fetch) {
  const r = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...baseHeaders, Authorization: `Bearer ${appJwt(appId, pem)}` },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`installation token ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}

export class Repo {
  readonly fullName: string;
  private token: string;
  private fetchImpl: typeof fetch;
  constructor(fullName: string, token: string, fetchImpl: typeof fetch = fetch) {
    this.fullName = fullName;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  private async call(method: string, path: string, body?: unknown) {
    const r = await this.fetchImpl(`${API}/repos/${this.fullName}${path}`, {
      method,
      headers: { ...baseHeaders, Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`GitHub ${method} ${path} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? null : r.json();
  }

  comment(issue: number, body: string) {
    return this.call("POST", `/issues/${issue}/comments`, { body }) as Promise<{ id: number; html_url: string }>;
  }
  // `since` (ISO time) limits the page to comments updated at or after it, so a long thread cannot push
  // the newest bot comments past the first 100.
  async listComments(issue: number, since?: string): Promise<{ id: number; body: string; created_at: string; user?: { type?: string } }[]> {
    const q = since ? `&since=${encodeURIComponent(since)}` : "";
    return (await this.call("GET", `/issues/${issue}/comments?per_page=100${q}`)) as any;
  }
  // The default branch's head commit: a /repro installs and names exactly this revision.
  async headSha(): Promise<string | undefined> {
    const j = (await this.call("GET", "/commits/HEAD")) as { sha?: unknown };
    return typeof j?.sha === "string" && /^[0-9a-f]{40}$/.test(j.sha) ? j.sha : undefined;
  }
  editComment(id: number, body: string) {
    return this.call("PATCH", `/issues/comments/${id}`, { body });
  }
  addLabels(issue: number, labels: string[]) {
    return labels.length ? this.call("POST", `/issues/${issue}/labels`, { labels }) : Promise.resolve(null);
  }
  removeLabel(issue: number, label: string) {
    return this.call("DELETE", `/issues/${issue}/labels/${encodeURIComponent(label)}`).catch(() => null);
  }
  // Atomic claim on an issue ("/issues/7") or comment ("/issues/comments/55"): GitHub keeps one reaction
  // per user and content, answering 201 when this app's 👀 is new and 200 when it already exists. Two
  // deliveries racing on the same event therefore get one 201 between them; only that one does the work.
  async claim(path: string): Promise<boolean> {
    const r = await this.fetchImpl(`${API}/repos/${this.fullName}${path}/reactions`, {
      method: "POST",
      headers: { ...baseHeaders, Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "eyes" }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (r.status === 201) return true;
    if (r.status === 200) return false;
    throw new Error(`GitHub claim ${path} -> ${r.status}`);
  }
    react(commentId: number, content: "eyes" | "rocket" | "-1" | "+1") {
    return this.call("POST", `/issues/comments/${commentId}/reactions`, { content }).catch(() => null);
  }
}
