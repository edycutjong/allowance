// A GitHub redelivery or a duplicate "/repro" must not run the sandbox twice.
// Every bot comment about a /repro carries a hidden marker with the triggering comment id.
export const REPRO_WINDOW_MS = 5 * 60 * 1000;
export const RUNNING_PREFIX = "⏳ Reproducing";

export const marker = (commentId: number) => `<!-- allowance:repro:${commentId} -->`;

export type BotComment = { body: string; created_at: string; user?: { type?: string } };

export type Skip = { skip: false } | { skip: true; why: "already-handled" | "in-flight" };

export function reproSkip(comments: BotComment[], triggerCommentId: number, now = Date.now()): Skip {
  const bots = comments.filter((c) => c.user?.type === "Bot");
  if (bots.some((c) => c.body.includes(marker(triggerCommentId)))) return { skip: true, why: "already-handled" };
  const inFlight = bots.some((c) => {
    const age = now - Date.parse(c.created_at);
    return c.body.startsWith(RUNNING_PREFIX) && age >= 0 && age < REPRO_WINDOW_MS;
  });
  return inFlight ? { skip: true, why: "in-flight" } : { skip: false };
}
