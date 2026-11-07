// GitHub App webhook logic. api/github.ts wires it to Vercel; tests drive it with a fake fetch.
// Answers GitHub within its 10 s window and finishes the work in the background (waitUntil).
//  issues.opened          -> triage (bot key, Llama-3.3-70B) + welcome comment + labels
//  issue_comment.created  -> "/repro" -> contributor's own allowance (service key) -> sandbox verdict
import { MAINTAINER, RUNNING, failedComment, reproComment, refusalComment, welcomeComment } from "./comment.ts";
import { issueFromApi, commandIn } from "./github-issue.ts";
import { REPRO_WINDOW_MS, TRIAGE_MARKER, marker, reproSkip, triageSkip } from "./idempotency.ts";
import { installationToken, Repo, verifySignature } from "./github.ts";
import { allowanceOf, getEndUser, getEndUserBudgets, getPool, type OtariEnv, type Pool } from "./otari.ts";
import { endUserId, runRepro } from "./repro.ts";
import { runTriage, triageLabels } from "./triage.ts";

export type WebhookEnv = {
  otari: OtariEnv;
  appId: string;
  pem: string;
  secret: string;
  guardUrl?: string;
  mcpServerIds: string[];
  poolCeilingUsd: number;
};

export function envFromProcess(e: Record<string, string | undefined> = process.env): WebhookEnv {
  return {
    otari: { OTARI_BASE_URL: e.OTARI_BASE_URL, OTARI_API_KEY: e.OTARI_API_KEY ?? "", OTARI_SERVICE_KEY: e.OTARI_SERVICE_KEY ?? "" },
    appId: e.GITHUB_APP_ID ?? "",
    pem: (e.GITHUB_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    secret: e.GITHUB_WEBHOOK_SECRET ?? "",
    guardUrl: e.GUARD_TOKEN ? `${e.PUBLIC_BASE_URL ?? "https://allowance.edycu.dev"}/api/guard/${e.GUARD_TOKEN}` : undefined,
    mcpServerIds: e.OTARI_MCP_GITHUB_ID ? [e.OTARI_MCP_GITHUB_ID] : [],
    poolCeilingUsd: Number(e.POOL_CEILING_USD ?? 5),
  };
}

export type Deps = {
  env: WebhookEnv;
  waitUntil: (p: Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
  // tests pass a ready Repo; production mints an installation token per delivery
  repoFor?: (fullName: string, installationId: number) => Promise<Repo>;
};

const isMaintainer = (association: string | undefined) => ["OWNER", "MEMBER", "COLLABORATOR"].includes(association ?? "");

async function allowanceFor(login: string, o: OtariEnv, f: typeof fetch) {
  try {
    return allowanceOf(await getEndUser(endUserId(login), o, f), await getEndUserBudgets(o, f));
  } catch {
    return null;
  }
}

async function poolFor(E: WebhookEnv, f: typeof fetch): Promise<Pool | null> {
  try {
    return await getPool(E.otari, E.poolCeilingUsd, f);
  } catch {
    return null;
  }
}

export async function onIssueOpened(p: any, repo: Repo, E: WebhookEnv, f: typeof fetch = fetch) {
  const issue = issueFromApi(repo.fullName, p.issue);
  // A redelivered issues.opened must not triage (and comment) twice.
  const skip = triageSkip(await repo.listComments(issue.number, p.issue.created_at));
  if (skip) {
    console.log("allowance skip triage", issue.number, "already-handled");
    return;
  }
  const { res, triage } = await runTriage(issue, { guardUrl: E.guardUrl }, E.otari, f);
  const maintainer = isMaintainer(p.issue.author_association);
  const [a, pool] = await Promise.all([maintainer ? Promise.resolve(MAINTAINER) : allowanceFor(issue.author, E.otari, f), poolFor(E, f)]);
  if (!res.ok) {
    if (res.code === "guardrail_violation") await repo.addLabels(issue.number, ["allowance:blocked"]);
    await repo.comment(issue.number, refusalComment(issue.author, res, a, pool) + "\n" + TRIAGE_MARKER);
    return;
  }
  if (triage) await repo.addLabels(issue.number, triageLabels(triage));
  await repo.comment(issue.number, welcomeComment(issue.author, triage, a, res.trace, pool) + "\n" + TRIAGE_MARKER);
}

export async function onRepro(p: any, repo: Repo, E: WebhookEnv, f: typeof fetch = fetch, now = Date.now()) {
  const login: string = p.comment.user.login;
  const maintainer = isMaintainer(p.comment.author_association);
  const issue = issueFromApi(repo.fullName, p.issue);
  // Only comments touched since the trigger (or inside the in-flight window) can carry its marker;
  // `since` keeps long threads from pushing them past the first page.
  const since = new Date(Math.min(Date.parse(p.comment.created_at) || now, now - REPRO_WINDOW_MS)).toISOString();
  const skip = reproSkip(await repo.listComments(issue.number, since), p.comment.id, now);
  if (skip.skip) {
    console.log("allowance skip /repro", p.comment.id, skip.why);
    return;
  }
  await repo.react(p.comment.id, "eyes");
  const placeholder = await repo.comment(issue.number, RUNNING(login, p.comment.id));
  try {
    const result = await runRepro(issue, login, { guardUrl: E.guardUrl, mcpServerIds: E.mcpServerIds, maintainer }, E.otari, f);
    const [a, pool] = await Promise.all([maintainer ? Promise.resolve(MAINTAINER) : allowanceFor(login, E.otari, f), poolFor(E, f)]);
    await repo.editComment(placeholder.id, reproComment(login, result, a, pool) + "\n" + marker(p.comment.id));
    if (result.kind === "ran") {
      for (const l of ["repro:yes", "repro:no", "repro:inconclusive", "repro:ready", "repro:needs-steps"]) await repo.removeLabel(issue.number, l);
      const label = { reproduced: "repro:yes", not_reproduced: "repro:no", inconclusive: "repro:inconclusive" }[result.verdict.kind];
      await repo.addLabels(issue.number, [label]);
      await repo.react(p.comment.id, result.verdict.kind === "inconclusive" ? "-1" : "rocket");
    } else if (result.kind === "no_script") {
      await repo.addLabels(issue.number, ["repro:inconclusive"]);
    } else if (result.res.code === "guardrail_violation") {
      await repo.addLabels(issue.number, ["allowance:blocked"]);
    }
  } catch (e) {
    // Never leave "⏳ Reproducing…" behind: the placeholder becomes an error the contributor can act on.
    console.error("allowance /repro failed", issue.number, p.comment.id, String(e));
    await repo.editComment(placeholder.id, failedComment(login, e) + "\n" + marker(p.comment.id)).catch(() => null);
    await repo.react(p.comment.id, "-1");
  }
}

export async function handleWebhook(req: Request, deps: Deps): Promise<Response> {
  const E = deps.env;
  const f = deps.fetchImpl ?? fetch;
  const raw = await req.text();
  if (!verifySignature(E.secret, raw, req.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  const event = req.headers.get("x-github-event");
  let p: any;
  try {
    p = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (p?.sender?.type === "Bot") return Response.json({ ignored: "bot" });

  let job: ((repo: Repo) => Promise<void>) | null = null;
  if (event === "issues" && p.action === "opened") job = (r) => onIssueOpened(p, r, E, f);
  if (event === "issue_comment" && p.action === "created" && !p.issue?.pull_request && commandIn(p.comment?.body ?? "") === "repro") {
    job = (r) => onRepro(p, r, E, f);
  }
  if (!job || !p.installation?.id || !p.repository?.full_name) return Response.json({ ignored: `${event}.${p.action}` });

  const run = job;
  const repoFor = deps.repoFor ?? (async (name: string, id: number) => new Repo(name, await installationToken(E.appId, E.pem, id, f), f));
  deps.waitUntil(
    (async () => {
      try {
        await run(await repoFor(p.repository.full_name, p.installation.id));
      } catch (e) {
        console.error("allowance job failed", event, p.action, String(e));
      }
    })(),
  );
  return Response.json({ accepted: `${event}.${p.action}` }, { status: 202 });
}
