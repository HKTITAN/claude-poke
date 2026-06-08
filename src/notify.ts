/**
 * Proactive notifications: make Poke message the user when a session finishes or needs input.
 * OPTIONAL — no-ops when no Poke V2 API key is configured (the bridge still works; Poke just polls).
 *
 * Channel: POST https://poke.com/api/v1/inbound/api-message
 *   headers: Authorization: Bearer <V2 key from poke.com/kitchen>, Content-Type: application/json
 *   body: { message: <plain text> }   → 200 { success: true }
 *
 * The endpoint is one-way (no thread id), so every message embeds the short session id + cwd so Poke's
 * agent can route the user's reply back via send_message / resume_session.
 */
const ENDPOINT = "https://poke.com/api/v1/inbound/api-message";

const lastSentAt = new Map<string, number>(); // per-session debounce
const DEBOUNCE_MS = 4000;

export interface NotifyCtx {
  pokeApiKey?: string;
}

async function postMessage(apiKey: string, message: string): Promise<boolean> {
  const MAX = 4;
  for (let attempt = 0; attempt < MAX; attempt++) {
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
    } catch (err) {
      console.error("[claude-poke] notify network error:", (err as Error)?.message ?? err);
      return false;
    }
    if (res.ok) return true;
    // Retry on rate-limit (429) and transient server errors (5xx); 4xx (else) is non-retryable.
    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX - 1) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
      }
      continue;
    }
    console.error(`[claude-poke] notify failed: HTTP ${res.status}`);
    return false;
  }
  return false;
}

function short(id: string): string {
  return id.slice(0, 8);
}

/** Drop debounce entries older than a minute (they can't affect a 4s window) to bound memory. */
function prune(now: number): void {
  if (lastSentAt.size < 256) return;
  for (const [k, t] of lastSentAt) if (now - t > 60_000) lastSentAt.delete(k);
}

/** Fire-and-forget notify. Debounced per session id. */
export function notify(ctx: NotifyCtx, sessionId: string, message: string): void {
  if (!ctx.pokeApiKey) return;
  const now = Date.now();
  prune(now);
  const prev = lastSentAt.get(sessionId) ?? 0;
  if (now - prev < DEBOUNCE_MS) return;
  lastSentAt.set(sessionId, now);
  void postMessage(ctx.pokeApiKey, message);
}

export function notifyFinished(ctx: NotifyCtx, s: { sessionId: string; title: string; cwd: string; lastResult?: string; error?: string }): void {
  const id = short(s.sessionId);
  const msg = s.error
    ? `Claude Code session "${s.title}" (${id}) in ${s.cwd} FAILED: ${truncate(s.error, 200)}. Reply to retry, or say "resume ${id} <msg>".`
    : `Claude Code session "${s.title}" (${id}) in ${s.cwd} finished a turn: ${truncate(s.lastResult ?? "(done)", 240)}. Reply to continue, or say "resume ${id} <msg>".`;
  notify(ctx, s.sessionId, msg);
}

export function notifyNeedsInput(
  ctx: NotifyCtx,
  s: { sessionId: string; title: string; cwd: string },
  toolName: string,
  reason: string,
): void {
  const id = short(s.sessionId);
  const msg = `Claude Code session "${s.title}" (${id}) in ${s.cwd} NEEDS INPUT: wants to run ${toolName}${reason ? ` — ${truncate(reason, 160)}` : ""}. Reply "approve ${id}" to allow or "deny ${id}" to refuse; I'll route it.`;
  // bypass debounce for needs-input so a permission ask is never silently dropped
  if (!ctx.pokeApiKey) return;
  lastSentAt.set(s.sessionId, Date.now());
  void postMessage(ctx.pokeApiKey, msg);
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
