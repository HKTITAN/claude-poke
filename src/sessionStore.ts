/**
 * Read-only enumeration of Claude Code sessions on this machine.
 *  - All sessions: transcripts under ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *  - Live sessions: ~/.claude/sessions/<pid>.json (a running claude process), verified via process.kill(pid,0)
 *  - Tail: last N human/assistant messages from any transcript (for the read-only "watch" view)
 *
 * Hardened against the real on-disk format: titles live in repeated `ai-title` lines near EOF (this CLI
 * emits no `summary` lines); cwd is read from a transcript line (the project dir name is a lossy encoding);
 * subagent transcripts (nested <id>/subagents/agent-*.jsonl) are excluded; huge files are streamed, not
 * fully parsed; torn final lines / unreadable files degrade gracefully.
 */
import { promises as fs, createReadStream, type Stats } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const LIVE_DIR = path.join(CLAUDE_DIR, "sessions");
const UUID_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export interface SessionInfo {
  sessionId: string;
  filePath: string;
  cwd: string | null;
  projectDir: string;
  title: string | null;
  lastActivity: number; // epoch ms
  messageCount: number;
  live: boolean;
  pid?: number;
}

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  version?: string;
  entrypoint?: string;
  kind?: string;
}

export interface TailMsg {
  role: "user" | "assistant";
  text: string;
  timestamp: number | null;
}

function safeParse(line: string): Record<string, unknown> | null {
  const s = line.trim();
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extract readable text from a message.content that may be a string or an array of content blocks. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object") {
      const blk = b as { type?: string; text?: string };
      if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
    }
  }
  return parts.join("\n").trim();
}

function isHumanUserLine(o: Record<string, unknown>): boolean {
  if (o.type !== "user" || o.isMeta === true || o.isSidechain === true) return false;
  const msg = o.message as { content?: unknown } | undefined;
  const txt = extractText(msg?.content);
  if (!txt) return false;
  if (txt.includes("<command-name>") || txt.includes("<local-command-stdout>")) return false;
  if (txt.startsWith("Caveat:")) return false;
  return true;
}

function truncate(s: string, n = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

/** Best-effort lossy decode of an encoded project dir name (fallback only — prefer a line's cwd). */
export function decodeProjectDir(dir: string): string {
  if (/^[A-Za-z]--/.test(dir)) {
    return dir[0] + ":\\" + dir.slice(3).replace(/-/g, "\\");
  }
  return "/" + dir.replace(/^-+/, "").replace(/-/g, "/");
}

async function readTail(file: string, maxBytes = 96 * 1024): Promise<string> {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

function scanTail(tailText: string): { title: string | null; lastTs: number | null } {
  let title: string | null = null;
  let lastTs: number | null = null;
  for (const line of tailText.split(/\r?\n/)) {
    const o = safeParse(line);
    if (!o) continue;
    if (o.type === "ai-title" && typeof o.aiTitle === "string") title = o.aiTitle;
    else if (o.type === "summary" && typeof o.summary === "string") title = o.summary;
    if (typeof o.timestamp === "string") {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) lastTs = t;
    }
  }
  return { title, lastTs };
}

function scanHead(file: string, count: boolean): Promise<{ firstUserText: string | null; messageCount: number; cwd: string | null }> {
  return new Promise((resolve) => {
    let firstUserText: string | null = null;
    let messageCount = 0;
    let cwd: string | null = null;
    const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    rl.on("line", (line) => {
      const o = safeParse(line);
      if (!o) return;
      if (!cwd && typeof o.cwd === "string" && o.cwd) cwd = o.cwd as string;
      if ((o.type === "user" || o.type === "assistant") && o.isSidechain !== true) messageCount++;
      if (firstUserText === null && isHumanUserLine(o)) {
        firstUserText = truncate(extractText((o.message as { content?: unknown }).content));
        if (!count && cwd) rl.close();
      }
    });
    rl.on("close", () => resolve({ firstUserText, messageCount, cwd }));
    rl.on("error", () => resolve({ firstUserText, messageCount, cwd }));
  });
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM"; // exists but owned by another user
  }
}

export async function listLiveSessions(): Promise<LiveSession[]> {
  let files: string[] = [];
  try {
    files = await fs.readdir(LIVE_DIR);
  } catch {
    return [];
  }
  const out: LiveSession[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(await fs.readFile(path.join(LIVE_DIR, f), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const pid = typeof rec.pid === "number" ? rec.pid : parseInt(path.basename(f, ".json"), 10);
    if (!isPidAlive(pid)) continue;
    if (typeof rec.sessionId === "string") {
      out.push({
        pid,
        sessionId: rec.sessionId,
        cwd: String(rec.cwd ?? ""),
        startedAt: rec.startedAt as number | undefined,
        version: rec.version as string | undefined,
        entrypoint: rec.entrypoint as string | undefined,
        kind: rec.kind as string | undefined,
      });
    }
  }
  return out;
}

async function buildSessionInfo(
  filePath: string,
  dir: string,
  name: string,
  liveById: Map<string, LiveSession>,
  exactCount: boolean,
): Promise<SessionInfo | null> {
  const sessionId = name.replace(/\.jsonl$/i, "");
  let st: Stats;
  try {
    st = await fs.stat(filePath);
  } catch {
    return null;
  }
  const [tail, head] = await Promise.all([
    readTail(filePath).then(scanTail).catch(() => ({ title: null, lastTs: null })),
    scanHead(filePath, exactCount).catch(() => ({ firstUserText: null, messageCount: 0, cwd: null })),
  ]);
  const liveRec = liveById.get(sessionId);
  return {
    sessionId,
    filePath,
    cwd: head.cwd ?? liveRec?.cwd ?? decodeProjectDir(dir),
    projectDir: dir,
    title: tail.title ?? head.firstUserText ?? null,
    lastActivity: tail.lastTs ?? st.mtimeMs,
    messageCount: head.messageCount,
    live: !!liveRec,
    pid: liveRec?.pid,
  };
}

export async function listSessions(opts: { exactCount?: boolean } = {}): Promise<SessionInfo[]> {
  let projectDirs: string[] = [];
  try {
    projectDirs = (await fs.readdir(PROJECTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const liveById = new Map((await listLiveSessions()).map((l) => [l.sessionId, l] as const));
  const jobs: Promise<SessionInfo | null>[] = [];
  for (const dir of projectDirs) {
    const dirPath = path.join(PROJECTS_DIR, dir);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    for (const fileName of entries) {
      if (!UUID_FILE_RE.test(fileName)) continue; // top-level UUID transcripts only (excludes subagents)
      jobs.push(buildSessionInfo(path.join(dirPath, fileName), dir, fileName, liveById, !!opts.exactCount));
    }
  }
  const settled = await Promise.allSettled(jobs);
  const out = settled.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return out;
}

/** Find one session by id (read-only) — stats one candidate file per project dir, no full scan. */
export async function findSession(sessionId: string): Promise<SessionInfo | undefined> {
  const fileName = `${sessionId}.jsonl`;
  let projectDirs: string[] = [];
  try {
    projectDirs = (await fs.readdir(PROJECTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return undefined;
  }
  const liveById = new Map((await listLiveSessions()).map((l) => [l.sessionId, l] as const));
  for (const dir of projectDirs) {
    const filePath = path.join(PROJECTS_DIR, dir, fileName);
    try {
      await fs.stat(filePath);
    } catch {
      continue; // not in this project dir
    }
    return (await buildSessionInfo(filePath, dir, fileName, liveById, false)) ?? undefined;
  }
  return undefined;
}

export async function tailTranscript(filePath: string, n = 20): Promise<TailMsg[]> {
  const msgs: TailMsg[] = [];
  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
    rl.on("line", (line) => {
      const o = safeParse(line);
      if (!o || o.isSidechain === true) return;
      if (o.type !== "user" && o.type !== "assistant") return;
      const text = extractText((o.message as { content?: unknown } | undefined)?.content);
      if (!text || text.includes("<command-name>") || text.includes("<local-command-stdout>")) return;
      msgs.push({
        role: o.type as "user" | "assistant",
        text: truncate(text, 2000),
        timestamp: typeof o.timestamp === "string" ? Date.parse(o.timestamp) : null,
      });
      if (msgs.length > n + 50) msgs.shift();
    });
    rl.on("close", () => resolve());
    rl.on("error", () => resolve());
  });
  return msgs.slice(-n);
}
