// Dry run of the /repro pipeline against live Otari, without writing to GitHub.
//   node --experimental-strip-types scripts/repro.ts <issue-url> --as <github-login> [--no-guard]
// Reads OTARI_API_KEY, OTARI_SERVICE_KEY, OTARI_BASE_URL, GUARD_URL, OTARI_MCP_GITHUB_ID, GITHUB_TOKEN from env.
import { reproComment } from "../lib/comment.ts";
import { fetchIssue, issueFromApi, parseIssueUrl } from "../lib/github-issue.ts";
import { allowanceOf, getEndUser, getEndUserBudgets, type OtariEnv } from "../lib/otari.ts";
import { endUserId, runRepro } from "../lib/repro.ts";

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http") || a.startsWith("file:"));
const as = args[args.indexOf("--as") + 1];
if (!url || !as || args.indexOf("--as") < 0) {
  console.error("usage: scripts/repro.ts <issue-url> --as <github-login> [--no-guard]");
  process.exit(2);
}

const env: OtariEnv = {
  OTARI_BASE_URL: process.env.OTARI_BASE_URL,
  OTARI_API_KEY: process.env.OTARI_API_KEY ?? "",
  OTARI_SERVICE_KEY: process.env.OTARI_SERVICE_KEY ?? "",
};
// file:<path> = local markdown issue (first line "# title", optional "repo: owner/name" line) for offline fixtures
async function loadIssue(u: string) {
  if (!u.startsWith("file:")) {
    const { repo, number } = parseIssueUrl(u);
    return fetchIssue(repo, number, process.env.GITHUB_TOKEN);
  }
  const { readFile } = await import("node:fs/promises");
  const md = await readFile(u.slice(5), "utf8");
  const [first, ...rest] = md.split("\n");
  const repoLine = rest.find((l) => l.startsWith("repo:"));
  return issueFromApi(repoLine ? repoLine.slice(5).trim() : "local/fixture", {
    number: 0, title: first.replace(/^#\s*/, ""), body: rest.filter((l) => l !== repoLine).join("\n"), user: { login: as },
  });
}
const issue = await loadIssue(url);
const mcp = process.env.OTARI_MCP_GITHUB_ID;
const t0 = Date.now();
const result = await runRepro(
  issue,
  as,
  { guardUrl: args.includes("--no-guard") ? undefined : process.env.GUARD_URL, mcpServerIds: mcp ? [mcp] : [] },
  env,
);
const budgets = await getEndUserBudgets(env);
const allowance = allowanceOf(await getEndUser(endUserId(as), env), budgets);
if (process.env.ALLOWANCE_RAW) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(process.env.ALLOWANCE_RAW, JSON.stringify(result, null, 2));
}
console.log(reproComment(as, result, allowance));
console.error(`\n[dry-run] ${((Date.now() - t0) / 1000).toFixed(1)}s · ${result.kind === "ran" ? result.verdict.kind : result.res.code}`);
