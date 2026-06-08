/**
 * MCP tool surface exposed to Poke — a Claude Code SESSION controller.
 * Tools close over the long-lived SessionManager singleton (created once in server.ts) plus the
 * read-only SessionStore (filesystem enumeration). Three session kinds:
 *   managed   — launched/resumed here; fully controllable.
 *   resumable — a past session on disk; resume_session promotes it to managed.
 *   live      — a running terminal/desktop claude; read-only (tail only) until you resume it.
 */
import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type PermissionMode } from "./config.js";
import type { SessionManager, ManagedSession } from "./sessionManager.js";
import { listSessions, findSession, tailTranscript, type SessionInfo } from "./sessionStore.js";

const PERMS = ["default", "acceptEdits", "bypassPermissions", "plan"] as const;

type Text = { type: "text"; text: string };
function text(s: string): { content: Text[] } {
  return { content: [{ type: "text", text: s }] };
}
function err(s: string) {
  return { isError: true, content: [{ type: "text", text: s }] as Text[] };
}

export interface ToolCtx {
  manager: SessionManager;
}

export function registerTools(server: McpServer, ctx: ToolCtx): void {
  const { manager } = ctx;

  // ---------------------------------------------------------------- list_sessions
  server.registerTool(
    "list_sessions",
    {
      title: "List Claude Code sessions",
      description:
        "List Claude Code sessions this bridge can see, newest-activity first. Each entry has session_id, short_id, kind (managed = controllable here, resumable = a past session you can resume, live = a running terminal session you can only watch), status, title, cwd, last_activity, needs_input, message_count. Call this first when you don't know a session_id. Only managed sessions accept send_message/interrupt/set_*; resume_session promotes a resumable or live one to managed.",
      inputSchema: {
        filter: z.enum(["managed", "resumable", "live", "all"]).optional().describe("Default 'all'."),
        limit: z.number().int().positive().max(50).optional().describe("Default 20."),
        cwd: z.string().optional().describe("Only sessions whose folder contains this substring."),
      },
    },
    async ({ filter, limit, cwd }) => {
      const entries = await collectSessions(manager);
      let rows = entries;
      if (filter && filter !== "all") rows = rows.filter((e) => e.kind === filter);
      if (cwd) rows = rows.filter((e) => (e.cwd ?? "").toLowerCase().includes(cwd.toLowerCase()));
      rows = rows.slice(0, limit ?? 20);
      if (rows.length === 0) return text("No sessions found.");
      const lines = rows.map(
        (e) =>
          `- ${e.short_id}  [${e.kind}]  ${e.status}${e.needs_input ? " ⚠needs-input" : ""}  ${e.cwd ?? "?"}  — ${e.title ?? "(untitled)"}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] as Text[], structuredContent: { sessions: rows } };
    },
  );

  // ---------------------------------------------------------------- start_session
  server.registerTool(
    "start_session",
    {
      title: "Start a Claude Code session",
      description:
        "Launch a NEW Claude Code session in a folder and give it the first task. Returns a session_id IMMEDIATELY (does not wait for completion). Then wait for the proactive finish message, or poll get_session until status is idle/finished/error. Fully controllable afterwards via send_message/interrupt/set_*. permission_mode defaults to the configured default (bypassPermissions = full power incl. shell), which is the most reliable; 'plan' proposes without acting. The interactive approval modes (default/acceptEdits/dontAsk) are experimental and a turn may fail after an approval, so prefer the default unless the user wants proposal-only 'plan'.",
      inputSchema: {
        cwd: z.string().min(1).describe("Absolute folder path (any folder on this PC)."),
        task: z.string().min(1).describe("The first instruction for Claude Code."),
        model: z.string().optional().describe("Model id/alias (e.g. 'sonnet','opus'); omit for default."),
        permission_mode: z.enum(PERMS).optional(),
        title: z.string().optional().describe("Optional human label."),
      },
    },
    async ({ cwd, task, model, permission_mode, title }) => {
      if (!existsSync(cwd) || !safeIsDir(cwd)) return err(`Not a folder: ${cwd}`);
      try {
        const s = await manager.start({ cwd, task, model, permissionMode: permission_mode as PermissionMode | undefined, title });
        return started(manager, s);
      } catch (e) {
        return err(String((e as Error)?.message ?? e));
      }
    },
  );

  // ---------------------------------------------------------------- send_message
  server.registerTool(
    "send_message",
    {
      title: "Send a follow-up to a session",
      description:
        "Send a follow-up instruction to a MANAGED (or resumed) session, continuing the SAME session with full memory. Returns immediately; poll get_session or await the finish notification. Fails for read-only live sessions (resume_session first) or if the session is mid-turn (interrupt first) or waiting on a permission (use respond_permission). This is how you route a user's reply back to the right session.",
      inputSchema: {
        session_id: z.string().min(1),
        message: z.string().min(1),
      },
    },
    async ({ session_id, message }) => {
      if (!manager.get(session_id)) return err(`${session_id} isn't a managed session. Use resume_session to take control of a past/live session.`);
      try {
        manager.send(session_id, message);
        return started(manager, manager.get(session_id)!);
      } catch (e) {
        return err(String((e as Error)?.message ?? e));
      }
    },
  );

  // ---------------------------------------------------------------- resume_session
  server.registerTool(
    "resume_session",
    {
      title: "Resume / take over a session",
      description:
        "Resume a past (resumable) session or take control of a live terminal session, promoting it to a managed session you can fully drive. By default continues the same session_id and appends to its transcript; pass fork=true to branch into a NEW session id (original untouched). Required when a live session is still running. Returns the (possibly new) session_id; then use send_message/interrupt/set_* as normal.",
      inputSchema: {
        session_id: z.string().min(1),
        message: z.string().min(1).describe("What Claude should do next."),
        cwd: z.string().optional().describe("Override working dir; defaults to the session's original cwd."),
        fork: z.boolean().optional().describe("Branch to a new session id instead of continuing in place."),
        model: z.string().optional(),
        permission_mode: z.enum(PERMS).optional(),
      },
    },
    async ({ session_id, message, cwd, fork, model, permission_mode }) => {
      if (manager.get(session_id)) return err(`${session_id} is already a managed session — just use send_message.`);
      const info = await findSession(session_id);
      const resolvedCwd = cwd ?? info?.cwd ?? undefined;
      if (!resolvedCwd) return err(`Couldn't find session ${session_id} or determine its folder. Pass cwd explicitly.`);
      if (info?.live && !fork) {
        return err(`Session ${session_id} is currently running in a terminal. Pass fork=true to branch a copy, or close that terminal first.`);
      }
      try {
        const s = await manager.resume({ sessionId: session_id, cwd: resolvedCwd, message, fork, model, permissionMode: permission_mode as PermissionMode | undefined });
        return started(manager, s);
      } catch (e) {
        return err(String((e as Error)?.message ?? e));
      }
    },
  );

  // ---------------------------------------------------------------- get_session
  server.registerTool(
    "get_session",
    {
      title: "Get a session's status & recent output",
      description:
        "Get one session's status plus recent output and a needs_input flag. For managed/resumed sessions: live status (running|idle|finished|error|canceled), the latest result text, cost, turns, and recent activity. For resumable/live sessions: metadata + a tail of the transcript. Primary polling tool after start_session/send_message — call until status is idle/finished/error, then summarize.",
      inputSchema: { session_id: z.string().min(1), output_lines: z.number().int().positive().max(200).optional() },
    },
    async ({ session_id, output_lines }) => {
      const n = output_lines ?? 30;
      const s = manager.get(session_id);
      if (s) {
        const v = manager.view(s);
        const tail = s.outputRing.slice(-n).join("\n");
        const head =
          `Session ${v.session_id.slice(0, 8)} [managed] ${v.status}${v.needs_input ? " — NEEDS INPUT" : ""}\n` +
          `cwd: ${v.cwd}\nmodel: ${v.model ?? "(default)"} | permission: ${v.permission_mode} | turns: ${v.num_turns} | cost: $${v.cost_usd.toFixed(4)}` +
          (v.error ? `\nerror: ${v.error}` : "");
        const body = v.last_result ? `\n\n--- Last result ---\n${v.last_result}` : tail ? `\n\n--- Recent ---\n${tail}` : "";
        return { content: [{ type: "text", text: head + body }] as Text[], structuredContent: { ...v, short_id: v.session_id.slice(0, 8) } };
      }
      const info = await findSession(session_id);
      if (!info) return err(`No session ${session_id}.`);
      const tail = await tailTranscript(info.filePath, Math.min(n, 30));
      const head = `Session ${session_id.slice(0, 8)} [${info.live ? "live" : "resumable"}] ${info.live ? "running in a terminal (read-only)" : "on disk (resume to control)"}\ncwd: ${info.cwd}\ntitle: ${info.title ?? "(untitled)"}`;
      const body = tail.length ? `\n\n--- Recent ---\n${tail.map((t) => `${t.role}: ${trunc(t.text, 200)}`).join("\n")}` : "";
      return { content: [{ type: "text", text: head + body }] as Text[], structuredContent: { session_id, kind: info.live ? "live" : "resumable", cwd: info.cwd, title: info.title, live: info.live, last_activity: info.lastActivity } };
    },
  );

  // ---------------------------------------------------------------- tail_session
  server.registerTool(
    "tail_session",
    {
      title: "Watch any session (read-only)",
      description: "Return the last N user/assistant messages from any session's transcript on disk — works for managed, resumable, AND live terminal sessions. Use to watch what a running terminal Claude is doing without taking control. Changes nothing.",
      inputSchema: { session_id: z.string().min(1), lines: z.number().int().positive().max(200).optional() },
    },
    async ({ session_id, lines }) => {
      const info = (await findSession(session_id)) ?? null;
      if (!info) return err(`No transcript found for session ${session_id}.`);
      const tail = await tailTranscript(info.filePath, lines ?? 20);
      if (!tail.length) return text("(no readable messages yet)");
      return { content: [{ type: "text", text: tail.map((t) => `${t.role}: ${trunc(t.text, 400)}`).join("\n") }] as Text[] };
    },
  );

  // ---------------------------------------------------------------- interrupt_session
  server.registerTool(
    "interrupt_session",
    {
      title: "Interrupt a session's current turn",
      description: "Stop a managed/resumed session's CURRENT turn immediately. The session stays alive and resumable — send_message again afterwards. Fails for read-only live sessions.",
      inputSchema: { session_id: z.string().min(1) },
    },
    async ({ session_id }) => {
      if (!manager.get(session_id)) return err(`${session_id} isn't a managed session (can't interrupt a live terminal session).`);
      try {
        await manager.interrupt(session_id);
        return text(`Interrupted ${session_id.slice(0, 8)}. You can send_message to continue.`);
      } catch (e) {
        return err(String((e as Error)?.message ?? e));
      }
    },
  );

  // ---------------------------------------------------------------- set_model
  server.registerTool(
    "set_model",
    {
      title: "Change a session's model",
      description: "Change the model of a managed/resumed session for its subsequent turns. Only works on sessions launched/resumed here.",
      inputSchema: { session_id: z.string().min(1), model: z.string().min(1) },
    },
    async ({ session_id, model }) => {
      try {
        await manager.setModel(session_id, model);
        return text(`Model for ${session_id.slice(0, 8)} set to ${model}.`);
      } catch (e) {
        return err(String((e as Error)?.message ?? e));
      }
    },
  );

  // ---------------------------------------------------------------- set_permission_mode
  server.registerTool(
    "set_permission_mode",
    {
      title: "Change a session's permission mode",
      description: "Change how much a managed/resumed session may do without asking. Tightening (to 'plan'/'default') always works. Note: switching INTO 'bypassPermissions' mid-session only fully applies if the session started in a dangerous posture — set it at start_session/resume_session for guaranteed full power.",
      inputSchema: { session_id: z.string().min(1), permission_mode: z.enum(PERMS) },
    },
    async ({ session_id, permission_mode }) => {
      try {
        await manager.setPermissionMode(session_id, permission_mode as PermissionMode);
        return text(`Permission mode for ${session_id.slice(0, 8)} set to ${permission_mode}.`);
      } catch (e) {
        return err(String((e as Error)?.message ?? e));
      }
    },
  );

  // ---------------------------------------------------------------- respond_permission
  server.registerTool(
    "respond_permission",
    {
      title: "Approve or deny a session's pending tool",
      description: "Answer a session that NEEDS INPUT (it asked permission to run a tool). approve=true lets it proceed; approve=false denies and the session keeps going without that action. Use the short id from the needs-input notification to pick the session_id.",
      inputSchema: { session_id: z.string().min(1), approve: z.boolean(), note: z.string().optional().describe("Optional reason shown to Claude on denial.") },
    },
    async ({ session_id, approve, note }) => {
      try {
        manager.respondPermission(session_id, approve, note);
        return text(`${approve ? "Approved" : "Denied"} the pending action for ${session_id.slice(0, 8)}.`);
      } catch (e) {
        return err(String((e as Error)?.message ?? e));
      }
    },
  );

  // ---------------------------------------------------------------- stop_session
  server.registerTool(
    "stop_session",
    {
      title: "End a managed session",
      description: "End a managed/resumed session and free its resources (interrupts any in-flight turn, closes the stream). The transcript stays on disk and can be resumed later. No effect on live terminal sessions (owned by another process).",
      inputSchema: { session_id: z.string().min(1) },
    },
    async ({ session_id }) => {
      if (!manager.get(session_id)) return err(`${session_id} isn't a managed session.`);
      manager.stop(session_id);
      return text(`Stopped ${session_id.slice(0, 8)}. Resume it later with resume_session.`);
    },
  );

  // ---------------------------------------------------------------- list_models
  server.registerTool(
    "list_models",
    {
      title: "List available models",
      description: "List model ids/aliases available to Claude Code. Use the returned values for start_session(model) or set_model. Pass a managed session_id to reflect exactly what that running session reports.",
      inputSchema: { session_id: z.string().optional() },
    },
    async ({ session_id }) => {
      try {
        const models = await manager.listModels(session_id);
        return { content: [{ type: "text", text: models.map((m) => m.value + (m.label ? ` (${m.label})` : "")).join("\n") || "(none reported)" }] as Text[], structuredContent: { models } };
      } catch (e) {
        return err(String((e as Error)?.message ?? e));
      }
    },
  );

  // ---------------------------------------------------------------- list_commands
  server.registerTool(
    "list_commands",
    {
      title: "List slash commands",
      description: "List the slash commands Claude Code supports (read-only). You can't invoke one directly — to use a command, put its text in a start_session task or send_message (e.g. '/review'). Informational.",
      inputSchema: { session_id: z.string().optional() },
    },
    async ({ session_id }) => {
      try {
        const cmds = await manager.listCommands(session_id);
        return { content: [{ type: "text", text: cmds.map((c) => c.name + (c.description ? ` — ${c.description}` : "")).join("\n") || "(none reported)" }] as Text[], structuredContent: { commands: cmds } };
      } catch (e) {
        return err(String((e as Error)?.message ?? e));
      }
    },
  );

  // ---------------------------------------------------------------- account_info
  server.registerTool(
    "account_info",
    {
      title: "Show the Claude account in use",
      description: "Return the Claude account this PC is logged in as and the auth source — confirms the bridge uses the user's claude.ai subscription (not an API key). Read-only.",
      inputSchema: { session_id: z.string().optional() },
    },
    async ({ session_id }) => {
      try {
        const info = await manager.accountInfo(session_id);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] as Text[], structuredContent: { account: info } };
      } catch (e) {
        return err(String((e as Error)?.message ?? e));
      }
    },
  );

  // ---------------------------------------------------------------- get_diff
  server.registerTool(
    "get_diff",
    {
      title: "Show git changes in a session's folder",
      description: "Show `git diff --stat` plus a truncated `git diff` for a session's working folder (pass a session_id) or any folder (pass an absolute path), so you can see what Claude changed. Read-only.",
      inputSchema: { cwd_or_session: z.string().min(1) },
    },
    async ({ cwd_or_session }) => {
      let dir = cwd_or_session;
      const s = manager.get(cwd_or_session);
      if (s) dir = s.cwd;
      else if (!existsSync(cwd_or_session)) {
        const info = await findSession(cwd_or_session);
        if (info?.cwd) dir = info.cwd;
      }
      if (!existsSync(dir)) return err(`Not a folder or known session: ${cwd_or_session}`);
      try {
        const stat = execFileSync("git", ["-C", dir, "diff", "--stat"], { encoding: "utf8" });
        const diff = execFileSync("git", ["-C", dir, "diff"], { encoding: "utf8" });
        return text((`${stat}\n${trunc(diff, 6000)}`).trim() || "No uncommitted changes.");
      } catch {
        return text(`${dir} is not a git repository (or git isn't available).`);
      }
    },
  );

  // ---------------------------------------------------------------- notify_status
  server.registerTool(
    "notify_status",
    {
      title: "Are proactive notifications on?",
      description: "Report whether proactive Poke notifications are enabled (a Poke API key was provided at setup). If disabled, rely on polling get_session instead of waiting for finish/needs-input messages.",
      inputSchema: {},
    },
    async () => {
      const on = !!loadConfig().pokeApiKey;
      return { content: [{ type: "text", text: on ? "Proactive notifications are ON (you'll get a text when a session finishes or needs input)." : "Proactive notifications are OFF — poll get_session to track sessions." }] as Text[], structuredContent: { notifications: on } };
    },
  );
}

// ---------------------------------------------------------------- helpers

interface Row {
  session_id: string;
  short_id: string;
  kind: "managed" | "resumable" | "live";
  status: string;
  title: string | null;
  cwd: string | null;
  last_activity: number;
  needs_input: boolean;
}

async function collectSessions(manager: SessionManager): Promise<Row[]> {
  const managed = manager.list();
  const managedIds = new Set(managed.map((s) => s.sessionId));
  const rows: Row[] = managed.map((s) => ({
    session_id: s.sessionId,
    short_id: s.sessionId.slice(0, 8),
    kind: "managed",
    status: s.status,
    title: s.title,
    cwd: s.cwd,
    last_activity: s.lastTurnAt ?? s.createdAt,
    needs_input: s.needsInput,
  }));
  let store: SessionInfo[] = [];
  try {
    store = await listSessions();
  } catch {
    store = [];
  }
  for (const info of store) {
    if (managedIds.has(info.sessionId)) continue; // managed view wins
    rows.push({
      session_id: info.sessionId,
      short_id: info.sessionId.slice(0, 8),
      kind: info.live ? "live" : "resumable",
      status: info.live ? "alive" : "on-disk",
      title: info.title,
      cwd: info.cwd,
      last_activity: info.lastActivity,
      needs_input: false,
    });
  }
  rows.sort((a, b) => b.last_activity - a.last_activity);
  return rows;
}

function started(manager: SessionManager, s: ManagedSession) {
  const v = manager.view(s);
  return {
    content: [{ type: "text", text: `Session ${s.sessionId.slice(0, 8)} (${v.status}) in ${s.cwd}. Poll get_session("${s.sessionId}") or wait for the finish notification.` }] as Text[],
    structuredContent: { session_id: s.sessionId, short_id: s.sessionId.slice(0, 8), status: v.status, cwd: s.cwd },
  };
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + " …" : s;
}
