// Issue loading + light parsing shared by the webhook and the local CLI.
import type { Issue } from "./repro.ts";

// Only images GitHub itself hosts (issue attachments, repo files) are passed to the model: the provider
// fetches image URLs, and an issue author should not choose what it fetches.
const IMAGE_HOSTS = /^https:\/\/(github\.com\/user-attachments\/|(private-)?user-images\.githubusercontent\.com\/|raw\.githubusercontent\.com\/)/;

export function imageUrlsIn(body: string): string[] {
  const urls = new Set<string>();
  for (const m of body.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) urls.add(m[1]);
  for (const m of body.matchAll(/<img[^>]+src="(https?:\/\/[^"]+)"/g)) urls.add(m[1]);
  return [...urls].filter((u) => IMAGE_HOSTS.test(u));
}

export function parseIssueUrl(url: string): { repo: string; number: number } {
  const m = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/.exec(url);
  if (!m) throw new Error(`not a GitHub issue URL: ${url}`);
  return { repo: m[1], number: Number(m[2]) };
}

export function issueFromApi(repo: string, j: any): Issue {
  const body: string = j.body ?? "";
  return {
    repo,
    number: j.number,
    title: j.title ?? "",
    body,
    author: j.user?.login ?? "unknown",
    url: j.html_url ?? `https://github.com/${repo}/issues/${j.number}`,
    imageUrls: imageUrlsIn(body),
  };
}

export async function fetchIssue(repo: string, number: number, token?: string, fetchImpl: typeof fetch = fetch): Promise<Issue> {
  const r = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${number}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "allowance-bot",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${repo}#${number}`);
  return issueFromApi(repo, await r.json());
}

// "/repro" or "/repro please" at the start of a comment line; quoted lines are ignored.
export function commandIn(comment: string): "repro" | "explain" | null {
  for (const raw of comment.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(">")) continue;
    const m = /^\/(repro|explain)\b/i.exec(line);
    if (m) return m[1].toLowerCase() as "repro" | "explain";
  }
  return null;
}
