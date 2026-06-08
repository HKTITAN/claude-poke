/**
 * The local bridge MCP server. Runs on the user's PC; Poke reaches it through Poke's tunnel.
 * Streamable HTTP at POST /mcp, JSON-RPC 2.0, stateless transport per request, gated by a bearer secret.
 *
 * The SessionManager is a LONG-LIVED singleton created once at startup — managed sessions must survive
 * across requests — and is closed over by the per-request tool registration.
 */
import { createServer, type Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, type Config } from "./config.js";
import { SessionManager } from "./sessionManager.js";
import { registerTools } from "./tools.js";

export function secretsMatch(token: string, secret: string): boolean {
  if (!secret || !token) return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

function checkAuth(req: Request, secret: string): boolean {
  // No secret configured → trust the channel: the bridge binds 127.0.0.1 and Poke reaches it only
  // through Poke's account-scoped tunnel (which can't attach a bearer). Setting an optional secret
  // (CLAUDE_POKE_SECRET) is for advanced remote setups registered via `poke mcp add <url> -k <secret>`.
  if (!secret) return true;
  const auth = req.header("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  return secretsMatch(auth.slice("Bearer ".length).trim(), secret);
}

export function buildApp(manager: SessionManager, getConfig: () => Config = loadConfig) {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true }); // unauthenticated; leak nothing
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    if (!checkAuth(req, getConfig().sharedSecret)) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    const server = new McpServer({ name: "claude-poke", version: "0.2.1" });
    registerTools(server, { manager });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[claude-poke] /mcp error:", (err as Error)?.message ?? err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });

  return app;
}

/** Start the bridge. Returns { server, manager }. */
export function startServer(cfg: Config): Promise<{ server: Server; manager: SessionManager }> {
  const manager = new SessionManager(cfg);
  const app = buildApp(manager, loadConfig);
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(cfg.port, "127.0.0.1", () => resolve({ server, manager }));
  });
}
