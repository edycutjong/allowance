// GitHub App webhook. Answers GitHub within its 10 s window and finishes the work with waitUntil.
//  issues.opened          -> triage (bot key, Llama-3.3-70B) + welcome comment + labels
//  issue_comment.created  -> "/repro" -> contributor's own allowance (service key) -> sandbox verdict
import { waitUntil } from "@vercel/functions";
import { RUNNING, reproComment, refusalComment, welcomeComment } from "../lib/comment.js";
import { issueFromApi, commandIn } from "../lib/github-issue.js";
import { installationToken, Repo, verifySignature } from "../lib/github.js";
import { allowanceOf, getEndUser, getEndUserBudgets, type OtariEnv } from "../lib/otari.js";
import { endUserId, runRepro } from "../lib/repro.js";
import { runTriage, triageLabels } from "../lib/triage.js";

export const config = { maxDuration: 300 };

function env() {
  const e = process.env;
  const otari: OtariEnv = {
    OTARI_BASE_URL: e.OTARI_BASE_URL,
    OTARI_API_KEY: e.OTARI_API_KEY ?? "",
    OTARI_SERVICE_KEY: e.OTARI_SERVICE_KEY ?? "",
  };
  return {
    otari,
    appId: e.GITHUB_APP_ID ?? "",
    pem: (e.GITHUB_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    secret: e.GITHUB_WEBHOOK_SECRET ?? "",
    guardUrl: e.GUARD_TOKEN ? `${e.PUBLIC_BASE_URL ?? "https://allowance.edycu.dev"}/api/guard/${e.GUARD_TOKEN}` : undefined,
    mcpServerIds: e.OTARI_MCP_GITHUB_ID ? [e.OTARI_MCP_GITHUB_ID] : [],
  };
}

async function allowanceFor(login: string, o: OtariEnv) {
  try {
    return allowanceOf(await getEndUser(endUserId(login), o), await getEndUserBudgets(o));
  } catch {
    return null;
  }
}

async function onIssueOpened(p: any, repo: Repo) {
  const issue = issueFromApi(repo.fullName, p.issue);
  const E = env();
  const { res, triage } = await runTriage(issue, { guardUrl: E.guardUrl }, E.otari);
  const a = await allowanceFor(issue.author, E.otari);
  if (!res.ok) {
    if (res.code === "guardrail_violation") await repo.addLabels(issue.number, ["allowance:blocked"]);
    await repo.comment(issue.number, refusalComment(issue.author, res, a));
    return;
  }
  if (triage) await repo.addLabels(issue.number, triageLabels(triage));
  await repo.comment(issue.number, welcomeComment(issue.author, triage, a, res.trace));
}

async function onRepro(p: any, repo: Repo) {
  const login: string = p.comment.user.login;
  const issue = issueFromApi(repo.fullName, p.issue);
  const E = env();
  await repo.react(p.comment.id, "eyes");
  const placeholder = await repo.comment(issue.number, RUNNING(login));
  const result = await runRepro(issue, login, { guardUrl: E.guardUrl, mcpServerIds: E.mcpServerIds }, E.otari);
  const a = await allowanceFor(login, E.otari);
  await repo.editComment(placeholder.id, reproComment(login, result, a));
  if (result.kind === "ran") {
    for (const l of ["repro:yes", "repro:no", "repro:inconclusive", "repro:ready", "repro:needs-steps"]) await repo.removeLabel(issue.number, l);
    const label = { reproduced: "repro:yes", not_reproduced: "repro:no", inconclusive: "repro:inconclusive" }[result.verdict.kind];
    await repo.addLabels(issue.number, [label]);
    await repo.react(p.comment.id, result.verdict.kind === "inconclusive" ? "-1" : "rocket");
  } else if (result.res.code === "guardrail_violation") {
    await repo.addLabels(issue.number, ["allowance:blocked"]);
  }
}

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  const E = env();
  if (!verifySignature(E.secret, raw, req.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  const event = req.headers.get("x-github-event");
  const p = JSON.parse(raw);
  if (p.sender?.type === "Bot") return Response.json({ ignored: "bot" });

  let job: ((repo: Repo) => Promise<void>) | null = null;
  if (event === "issues" && p.action === "opened") job = (r) => onIssueOpened(p, r);
  if (event === "issue_comment" && p.action === "created" && !p.issue?.pull_request && commandIn(p.comment?.body ?? "") === "repro") {
    job = (r) => onRepro(p, r);
  }
  if (!job) return Response.json({ ignored: `${event}.${p.action}` });

  const run = job;
  waitUntil(
    (async () => {
      try {
        const token = await installationToken(E.appId, E.pem, p.installation.id);
        await run(new Repo(p.repository.full_name, token));
      } catch (e) {
        console.error("allowance job failed", event, p.action, String(e));
      }
    })(),
  );
  return Response.json({ accepted: `${event}.${p.action}` }, { status: 202 });
}

export async function GET(): Promise<Response> {
  return Response.json({ ok: true, service: "allowance webhook" });
}
