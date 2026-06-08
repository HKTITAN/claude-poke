/**
 * The heart of claude-poke: manages long-lived, controllable Claude Code sessions.
 *
 * Each MANAGED session is a single Agent-SDK query() in STREAMING-INPUT mode: we own a pushable
 * user-message queue and the live SDKMessage iterator, so we can send follow-ups, interrupt, and
 * change model/permission mid-flight. A session created with options.resume continues an existing
 * transcript (promoting a past/"resumable" session into a managed one).
 *
 * State per session: initializing → running → idle (turn done, awaiting input) → finished/error/canceled.
 * On each completed turn we fire a "finished" notification; in interactive permission modes, canUseTool
 * fires a "needs input" notification and awaits respond_permission. Terminal sessions are evicted after
 * a grace window so the Map doesn't grow unbounded.
 */
import { query, type Options, type PermissionMode, type Query, type CanUseTool, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import { notifyFinished, notifyNeedsInput } from "./notify.js";

export type SessionStatus = "initializing" | "running" | "idle" | "finished" | "error" | "canceled";
const TERMINAL: SessionStatus[] = ["finished", "error", "canceled"];
const TERMINAL_TTL_MS = 10 * 60 * 1000;
const INIT_TIMEOUT_MS = 25_000;

interface PendingPermission {
  toolName: string;
  reason: string;
  /** Settle the SDK permission promise. Idempotent. */
  resolve: (approve: boolean, note?: string) => void;
}

export interface ManagedSession {
  sessionId: string;
  cwd: string;
  title: string;
  model?: string;
  permissionMode: PermissionMode;
  status: SessionStatus;
  needsInput: boolean;
  costUsd: number;
  numTurns: number;
  lastResult?: string;
  error?: string;
  outputRing: string[];
  createdAt: number;
  lastTurnAt?: number;
  // internals
  query: Query;
  pushMessage: (text: string) => void;
  closeInput: () => void;
  abortController: AbortController;
  closed: boolean; // pump has ended
  pendingPermission?: PendingPermission;
  evictTimer?: ReturnType<typeof setTimeout>;
}

export interface SessionView {
  session_id: string;
  kind: "managed";
  cwd: string;
  title: string;
  model?: string;
  permission_mode: PermissionMode;
  status: SessionStatus;
  needs_input: boolean;
  cost_usd: number;
  num_turns: number;
  last_result?: string;
  error?: string;
  last_activity: number;
}

function createInputQueue() {
  const q: unknown[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const push = (text: string) => {
    if (closed) return;
    q.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    wake?.();
    wake = null;
  };
  const close = () => {
    closed = true;
    wake?.();
    wake = null;
  };
  const iterable = (async function* () {
    while (true) {
      if (q.length) {
        yield q.shift();
        continue;
      }
      if (closed) return;
      await new Promise<void>((r) => (wake = r));
    }
  })() as AsyncIterable<never>;
  return { iterable, push, close };
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  constructor(private cfg: Config) {}

  setConfig(cfg: Config): void {
    this.cfg = cfg;
  }
  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }
  list(): ManagedSession[] {
    return [...this.sessions.values()];
  }
  activeCount(): number {
    return this.list().filter((s) => s.status === "initializing" || s.status === "running" || s.status === "idle").length;
  }

  async start(args: { cwd: string; task: string; model?: string; permissionMode?: PermissionMode; title?: string }): Promise<ManagedSession> {
    this.assertCapacity();
    return this.launch({
      provisionalId: provisional(),
      cwd: args.cwd,
      title: args.title || trunc(args.task, 60),
      model: args.model ?? this.cfg.defaultModel,
      permissionMode: args.permissionMode ?? this.cfg.defaultPermissionMode,
      firstMessage: args.task,
    });
  }

  async resume(args: { sessionId: string; cwd: string; message: string; fork?: boolean; model?: string; permissionMode?: PermissionMode }): Promise<ManagedSession> {
    this.assertCapacity();
    if (!args.fork && this.sessions.has(args.sessionId)) {
      throw new Error(`Session ${args.sessionId} is already managed — use send_message, or pass fork=true.`);
    }
    return this.launch({
      provisionalId: args.fork ? provisional() : args.sessionId,
      cwd: args.cwd,
      title: "resumed " + args.sessionId.slice(0, 8),
      model: args.model ?? this.cfg.defaultModel,
      permissionMode: args.permissionMode ?? this.cfg.defaultPermissionMode,
      resume: args.sessionId,
      forkSession: !!args.fork,
      firstMessage: args.message,
    });
  }

  private async launch(args: {
    provisionalId: string;
    cwd: string;
    title: string;
    model?: string;
    permissionMode: PermissionMode;
    resume?: string;
    forkSession?: boolean;
    firstMessage: string;
  }): Promise<ManagedSession> {
    const queue = createInputQueue();
    const abortController = new AbortController();
    const options: Options = {
      cwd: args.cwd,
      permissionMode: args.permissionMode,
      settingSources: [],
      abortController,
      includePartialMessages: false,
      env: { ...process.env },
    };
    if (args.model) options.model = args.model;
    if (this.cfg.allowedTools?.length) options.allowedTools = this.cfg.allowedTools;
    if (this.cfg.disallowedTools?.length) options.disallowedTools = this.cfg.disallowedTools;
    if (this.cfg.maxTurns) options.maxTurns = this.cfg.maxTurns;
    if (args.resume) options.resume = args.resume;
    if (args.forkSession) options.forkSession = true;

    const session: ManagedSession = {
      sessionId: args.provisionalId,
      cwd: args.cwd,
      title: args.title,
      model: args.model,
      permissionMode: args.permissionMode,
      status: "initializing",
      needsInput: false,
      costUsd: 0,
      numTurns: 0,
      outputRing: [],
      createdAt: Date.now(),
      query: undefined as unknown as Query,
      pushMessage: queue.push,
      closeInput: queue.close,
      abortController,
      closed: false,
    };
    if (args.permissionMode === "bypassPermissions") {
      (options as Record<string, unknown>).allowDangerouslySkipPermissions = true;
    } else {
      options.canUseTool = this.makeCanUseTool(session);
    }

    const q = query({ prompt: queue.iterable, options });
    session.query = q;
    this.sessions.set(session.sessionId, session); // reserve synchronously (atomic dup check)

    let initResolve: () => void = () => {};
    let initReject: (e: Error) => void = () => {};
    const initP = new Promise<void>((res, rej) => {
      initResolve = res;
      initReject = rej;
    });
    void this.pump(session, q, initResolve, initReject);

    queue.push(args.firstMessage);
    session.status = "running";
    try {
      await withTimeout(initP, INIT_TIMEOUT_MS);
    } catch (e) {
      this.cleanup(session);
      throw new Error(`Session failed to start: ${(e as Error)?.message ?? "init timed out"}`);
    }
    if (session.sessionId.startsWith("pending-")) {
      this.cleanup(session);
      throw new Error("Session failed to initialize (no session id received).");
    }
    return session;
  }

  private async pump(session: ManagedSession, q: Query, initResolve: () => void, initReject: (e: Error) => void): Promise<void> {
    let initialized = false;
    try {
      for await (const m of q) {
        if (m.type === "system" && (m as { subtype?: string }).subtype === "init") {
          const real = (m as { session_id?: string }).session_id;
          if (real && real !== session.sessionId) {
            this.sessions.delete(session.sessionId);
            session.sessionId = real;
            this.sessions.set(real, session);
          }
          const model = (m as { model?: string }).model;
          if (model) session.model = model;
          initialized = true;
          initResolve();
        } else if (m.type === "assistant") {
          for (const b of (m as { message?: { content?: unknown[] } }).message?.content ?? []) {
            const blk = b as { type?: string; text?: string; name?: string; input?: unknown };
            if (blk.type === "text" && blk.text?.trim()) this.out(session, `assistant: ${trunc(blk.text.trim(), 400)}`);
            else if (blk.type === "tool_use") this.out(session, `tool: ${blk.name}${toolHint(blk.input)}`);
          }
        } else if (m.type === "result") {
          const r = m as { subtype: string; result?: string; errors?: string[]; total_cost_usd?: number; num_turns?: number };
          session.costUsd += r.total_cost_usd ?? 0;
          session.numTurns += r.num_turns ?? 1;
          session.lastTurnAt = Date.now();
          if (r.subtype === "success") {
            session.lastResult = r.result ?? "";
            session.error = undefined;
          } else {
            session.error = (r.errors ?? []).join("; ") || r.subtype;
          }
          session.status = "idle";
          this.out(session, `— turn complete (${session.error ? "error" : "ok"})`);
          notifyFinished({ pokeApiKey: this.cfg.pokeApiKey }, session);
        }
      }
      this.markTerminal(session, session.error ? "error" : "finished");
    } catch (err) {
      if (!initialized) initReject(err instanceof Error ? err : new Error(String(err)));
      if (session.abortController.signal.aborted) this.markTerminal(session, "canceled");
      else {
        session.error = String((err as Error)?.message ?? err);
        this.markTerminal(session, "error");
      }
    } finally {
      session.closed = true;
    }
  }

  private makeCanUseTool(session: ManagedSession): CanUseTool {
    return (toolName, input, opts) => {
      return new Promise<PermissionResult>((resolve) => {
        let done = false;
        const finish = (result: PermissionResult) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          session.pendingPermission = undefined;
          session.needsInput = false;
          resolve(result);
        };
        const timer = setTimeout(() => finish({ behavior: "deny", message: "Timed out waiting for approval.", interrupt: false }), this.cfg.permissionTimeoutMs ?? 300_000);
        const reason = (opts as { decisionReason?: string })?.decisionReason ?? "";
        session.needsInput = true;
        session.status = "idle";
        session.pendingPermission = {
          toolName,
          reason,
          resolve: (approve, note) => {
            if (TERMINAL.includes(session.status)) {
              finish({ behavior: "deny", message: "Session ended.", interrupt: false });
              return;
            }
            session.status = "running";
            finish(approve ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: note || "Denied by user.", interrupt: false });
          },
        };
        notifyNeedsInput({ pokeApiKey: this.cfg.pokeApiKey }, session, toolName, reason);
        (opts as { signal?: AbortSignal })?.signal?.addEventListener?.("abort", () => finish({ behavior: "deny", message: "Aborted.", interrupt: false }));
      });
    };
  }

  send(id: string, message: string): void {
    const s = this.require(id);
    if (s.closed || TERMINAL.includes(s.status)) throw new Error("Session has ended. Use resume_session to continue it.");
    if (s.pendingPermission) throw new Error("This session is waiting on a permission decision — use respond_permission, not send_message.");
    if (s.status === "running") throw new Error("Session is mid-turn. interrupt it first, or wait for the current turn to finish.");
    s.pushMessage(message);
    s.status = "running";
  }

  respondPermission(id: string, approve: boolean, note?: string): void {
    const s = this.require(id);
    if (!s.pendingPermission) throw new Error("That session isn't waiting on a permission decision.");
    s.pendingPermission.resolve(approve, note);
  }

  async interrupt(id: string): Promise<void> {
    const s = this.require(id);
    s.pendingPermission?.resolve(false, "Interrupted.");
    await s.query.interrupt();
  }
  async setModel(id: string, model: string): Promise<void> {
    const s = this.require(id);
    await s.query.setModel(model);
    s.model = model;
  }
  async setPermissionMode(id: string, mode: PermissionMode): Promise<void> {
    const s = this.require(id);
    await s.query.setPermissionMode(mode);
    s.permissionMode = mode;
  }
  stop(id: string): void {
    const s = this.require(id);
    this.markTerminal(s, "canceled"); // sets status terminal first, then settles pending permission as deny
    s.abortController.abort();
    void s.query.interrupt().catch(() => {});
    s.closeInput();
  }

  async listModels(id?: string): Promise<{ value: string; label?: string }[]> {
    const q = id ? this.require(id).query : undefined;
    if (q) return (await q.supportedModels()) as { value: string; label?: string }[];
    return this.withThrowaway((tq) => tq.supportedModels()) as Promise<{ value: string; label?: string }[]>;
  }
  async listCommands(id?: string): Promise<{ name: string; description?: string }[]> {
    const q = id ? this.require(id).query : undefined;
    if (q) return (await q.supportedCommands()) as { name: string; description?: string }[];
    return this.withThrowaway((tq) => tq.supportedCommands()) as Promise<{ name: string; description?: string }[]>;
  }
  async accountInfo(id?: string): Promise<unknown> {
    const q = id ? this.require(id).query : undefined;
    if (q) return q.accountInfo();
    return this.withThrowaway((tq) => tq.accountInfo());
  }

  /** Spin a minimal streaming query to answer a control request, then tear it down. Bounded by a hard timeout. */
  private async withThrowaway<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    const queue = createInputQueue();
    const q = query({ prompt: queue.iterable, options: { cwd: process.cwd(), settingSources: [], includePartialMessages: false, env: { ...process.env } } });
    try {
      const it = q[Symbol.asyncIterator]();
      await Promise.race([it.next(), sleep(INIT_TIMEOUT_MS)]);
      return await withTimeout(fn(q), 15_000);
    } finally {
      queue.close();
      void q.interrupt().catch(() => {});
    }
  }

  view(s: ManagedSession): SessionView {
    return {
      session_id: s.sessionId,
      kind: "managed",
      cwd: s.cwd,
      title: s.title,
      model: s.model,
      permission_mode: s.permissionMode,
      status: s.status,
      needs_input: s.needsInput,
      cost_usd: s.costUsd,
      num_turns: s.numTurns,
      last_result: s.lastResult,
      error: s.error,
      last_activity: s.lastTurnAt ?? s.createdAt,
    };
  }

  private assertCapacity(): void {
    if (this.activeCount() >= this.cfg.maxConcurrentSessions) {
      throw new Error(`Too many active sessions (max ${this.cfg.maxConcurrentSessions}). Stop one first.`);
    }
  }

  private markTerminal(s: ManagedSession, status: SessionStatus): void {
    if (TERMINAL.includes(s.status)) return;
    s.status = status;
    s.lastTurnAt = Date.now();
    s.pendingPermission?.resolve(false, "Session ended."); // settle any pending permission (status is already terminal)
    s.evictTimer = setTimeout(() => this.sessions.delete(s.sessionId), TERMINAL_TTL_MS);
  }

  private cleanup(s: ManagedSession): void {
    try {
      s.abortController.abort();
    } catch {
      /* ignore */
    }
    void s.query?.interrupt?.().catch(() => {});
    s.closeInput();
    if (s.evictTimer) clearTimeout(s.evictTimer);
    this.sessions.delete(s.sessionId);
  }

  private out(s: ManagedSession, line: string): void {
    s.outputRing.push(line);
    if (s.outputRing.length > 200) s.outputRing.splice(0, s.outputRing.length - 200);
  }
  private require(id: string): ManagedSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`No managed session ${id}. It may be a live or resumable session — list_sessions to check.`);
    return s;
  }
}

function provisional(): string {
  return "pending-" + Math.random().toString(36).slice(2, 10);
}
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);
}
function trunc(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}
function toolHint(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  if (typeof o.command === "string") return ` (${trunc(o.command, 80)})`;
  if (typeof o.file_path === "string") return ` (${o.file_path})`;
  return "";
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
