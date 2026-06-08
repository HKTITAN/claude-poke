/**
 * Configuration for claude-poke. Persisted to ~/.claude-poke/config.json (chmod 600).
 * Environment variables override the saved file at load time.
 *
 * Local-only, session-centric. Claude Code runs on THIS machine using the login already on it
 * (your claude.ai subscription) — no API key required. The bearer secret is the sole trust boundary.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";

export interface Config {
  /** Local bridge port (default 4517). Env override: PORT. */
  port: number;
  /** Bearer token Poke must present on every /mcp request. Auto-generated on first setup.
   *  Env override: CLAUDE_POKE_SECRET. This is the sole trust boundary. */
  sharedSecret: string;
  /** Default permission posture for NEW sessions. Product default: "bypassPermissions" (max power). */
  defaultPermissionMode: PermissionMode;
  /** Default model id/alias for new sessions (e.g. "sonnet","opus"). Empty => Claude Code's default. */
  defaultModel?: string;
  /** Cap on concurrently-active managed sessions (default 5). */
  maxConcurrentSessions: number;
  /** Optional tool allow/deny lists applied to new sessions (Claude Code rule syntax). */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Optional cap on agent turns per turn-set. */
  maxTurns?: number;
  /** How long (ms) to await a permission decision before auto-denying (default 5 min). */
  permissionTimeoutMs?: number;
  /** OPTIONAL Poke V2 API key (poke.com/kitchen → API Keys). Enables proactive notifications.
   *  Absent => notifications disabled (bridge still works; Poke polls). Env override: POKE_API_KEY. */
  pokeApiKey?: string;
}

const DIR = join(homedir(), ".claude-poke");
const FILE = join(DIR, "config.json");

export function configDir(): string {
  return DIR;
}
export function configPath(): string {
  return FILE;
}
export function configExists(): boolean {
  return existsSync(FILE);
}

export function defaultConfig(): Config {
  return {
    port: 4517,
    // Empty by default: `poke tunnel` can't attach a bearer, so the tunnel + 127.0.0.1 bind is the
    // boundary. Set CLAUDE_POKE_SECRET only for advanced remote setups (`poke mcp add <url> -k ...`).
    sharedSecret: "",
    defaultPermissionMode: "bypassPermissions",
    maxConcurrentSessions: 5,
    permissionTimeoutMs: 5 * 60 * 1000,
  };
}

export function loadConfig(): Config {
  let cfg: Config;
  if (existsSync(FILE)) {
    cfg = { ...defaultConfig(), ...(JSON.parse(readFileSync(FILE, "utf8")) as Partial<Config>) };
  } else {
    cfg = defaultConfig();
  }
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.CLAUDE_POKE_SECRET) cfg.sharedSecret = process.env.CLAUDE_POKE_SECRET;
  if (process.env.POKE_API_KEY) cfg.pokeApiKey = process.env.POKE_API_KEY;
  return cfg;
}

export function saveConfig(cfg: Config): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(cfg, null, 2), { encoding: "utf8" });
  try {
    chmodSync(FILE, 0o600);
  } catch {
    /* no-op on Windows */
  }
}

/**
 * Is Claude Code authenticated for runs on this machine? True if the claude.ai subscription login
 * is stored (~/.claude/.credentials.json) or an API key / OAuth token is in the environment.
 * No API key is needed when you're simply signed in to Claude Code.
 */
export function hasLocalClaudeAuth(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  return existsSync(join(homedir(), ".claude", ".credentials.json"));
}
