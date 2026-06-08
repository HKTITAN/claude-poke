#!/usr/bin/env node
/**
 * claude-poke CLI — a local Claude Code session manager that Poke controls.
 *
 *   claude-poke            → guided setup/doctor (checks Claude login, Poke login, optional notify key)
 *   claude-poke start      → launch the bridge + Poke tunnel (mints the recipe on first run)
 *   claude-poke serve      → just the MCP server (advanced / pm2)
 *   claude-poke recipe     → (re)mint your Poke recipe link
 *   claude-poke doctor     → re-run the checks, no prompts
 *   claude-poke status     → show config + session counts
 */
import { spawn, execSync } from "node:child_process";
import { Command } from "commander";
import * as p from "@clack/prompts";
import {
  loadConfig,
  saveConfig,
  defaultConfig,
  configExists,
  configPath,
  hasLocalClaudeAuth,
  type Config,
} from "./config.js";
import { startServer } from "./server.js";
import { listSessions, listLiveSessions } from "./sessionStore.js";

const POKE = ["-y", "poke@latest"];

// The ONE shared recipe, published once from the maintainer's Poke account (poke.com/kitchen).
// Every user installs this same link; their own `claude-poke start` connects their bridge.
// Override with CLAUDE_POKE_RECIPE_URL if you fork and publish your own.
const RECIPE_URL = process.env.CLAUDE_POKE_RECIPE_URL || "https://poke.com/r/Egtr2rOr5Xk";

function bail(v: unknown): void {
  if (p.isCancel(v)) {
    p.cancel("Canceled.");
    process.exit(0);
  }
}

// ---------------------------------------------------------------- setup / doctor
async function setup(opts: { chainToStart?: boolean } = {}): Promise<void> {
  p.intro("claude-poke — let Poke run & control Claude Code on this machine");
  const cfg: Config = configExists() ? loadConfig() : defaultConfig();

  // CHECK 1 — Node
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) {
    p.cancel(`Node 18+ required (you have ${process.versions.node}). Install from https://nodejs.org and retry.`);
    process.exit(1);
  }

  // CHECK 2 — Claude Code login (no API key)
  if (hasLocalClaudeAuth()) {
    p.note("✓ Claude Code is signed in on this machine (using your subscription; no API key needed).", "Claude");
  } else {
    p.note("Claude Code isn't signed in here. Open a new terminal, run `claude`, and log in — then re-run setup.", "Claude");
  }

  // CHECK 3 — Poke login + optional notification key
  if (!pokeWhoami()) {
    p.note("Opening Poke login in your browser…", "Poke");
    await run(`npx ${POKE.join(" ")} login`);
    if (!pokeWhoami()) p.note("Couldn't confirm your Poke login. `claude-poke start` may ask again.", "Poke");
  } else {
    p.note("✓ Poke CLI is logged in.", "Poke");
  }

  const wantNotify = await p.confirm({
    message: "Enable proactive texts (so Poke pings you when a session finishes or needs input)?",
    initialValue: !!cfg.pokeApiKey,
  });
  bail(wantNotify);
  if (wantNotify) {
    p.note(
      "Create a Poke API key:\n  1. Go to https://poke.com/kitchen → API Keys\n  2. Click 'Add API Key', name it (e.g. 'Claude Code')\n  3. Copy it now (you won't see it again).\nThis is OPTIONAL — without it the bridge still works; Poke just polls instead of texting you.",
      "Notifications",
    );
    const key = await p.password({ message: "Paste your Poke API key (or leave blank to skip)" });
    bail(key);
    cfg.pokeApiKey = (key as string)?.trim() || undefined;
  } else {
    cfg.pokeApiKey = undefined;
  }

  // CHECK 4 — bridge secret (auto)
  saveConfig(cfg);
  p.note(`Config saved to ${configPath()} (notifications ${cfg.pokeApiKey ? "ON" : "OFF"}).`, "Done");

  if (opts.chainToStart) {
    p.outro("Setup done — starting now…");
  } else {
    p.outro(
      `All set! Two steps:\n\n` +
        `  1. Add the Claude Code recipe to your Poke (one-time): ${RECIPE_URL}\n` +
        `  2. Run:  ${launchHint()}   (connects this machine to your Poke)\n\n` +
        `Then text Poke, e.g. "list my Claude sessions" or "start a Claude session in C:/path/to/project and add tests".\n` +
        `Tip: keep this PC awake while you use it — sleeping disconnects Poke.`,
    );
  }
}

function doctor(): void {
  const cfg = loadConfig();
  const ok = (b: boolean) => (b ? "✓" : "✗");
  console.log(`Node ${process.versions.node}            ${ok(Number(process.versions.node.split(".")[0]) >= 18)}`);
  console.log(`Claude Code signed in        ${ok(hasLocalClaudeAuth())}`);
  console.log(`Poke CLI logged in           ${ok(pokeWhoami())}`);
  console.log(`Bridge secret set            ${ok(!!cfg.sharedSecret)}`);
  console.log(`Proactive notifications      ${cfg.pokeApiKey ? "ON" : "OFF (optional)"}`);
  console.log(`Config                       ${configPath()}`);
}

// ---------------------------------------------------------------- start / serve
async function start(): Promise<void> {
  if (!configExists()) await setup({ chainToStart: true });
  const cfg = loadConfig();

  const { server, manager } = await startServer(cfg).catch((e: NodeJS.ErrnoException) => {
    if (e?.code === "EADDRINUSE") {
      console.error(`\n  Port ${cfg.port} is already in use — claude-poke may already be running in another window,`);
      console.error(`  or another app is using it. Close the other instance, or pick a different port:`);
      console.error(`     PORT=4600 ${launchHint()}\n`);
    } else {
      console.error(`\n  Couldn't start the bridge: ${(e as Error)?.message ?? e}\n`);
    }
    process.exit(1);
  });
  const url = `http://localhost:${cfg.port}/mcp`;
  console.log(`\n  claude-poke bridge listening on ${url}`);
  console.log(`  notifications: ${cfg.pokeApiKey ? "on" : "off"}\n`);
  console.log(
    `  Connecting your bridge to Poke (first run downloads the tunnel — may take ~30s)…\n` +
      `  This registers it in your Poke account as the "Claude Code" integration.\n` +
      `  ┌─ One-time: add the Claude Code recipe to your Poke ─────────────\n` +
      `  │   ${RECIPE_URL}\n` +
      `  └─ Then text Poke, e.g. "list my Claude sessions".\n` +
      `  Keep this window open and the PC awake while you use it.\n`,
  );

  // No --recipe: the shared recipe is published once by the maintainer (RECIPE_URL). This tunnel
  // just forwards the local port and registers the per-user "Claude Code" integration. `poke tunnel`
  // has no API-key flag — the account-scoped tunnel + 127.0.0.1 bind is the boundary.
  // Single command string (not args + shell:true) to avoid Node's DEP0190 warning.
  const cmd = `npx ${POKE.join(" ")} tunnel "${url}" -n "Claude Code"`;
  const tunnel = spawn(cmd, { stdio: ["ignore", "pipe", "pipe"], shell: true });

  let connected = false;
  const onChunk = (buf: Buffer) => {
    process.stdout.write(buf);
    if (!connected && /connected|tunnel|listening|ready/i.test(buf.toString("utf8"))) {
      connected = true;
      console.log(`\n  ✅ Bridge connected. If you haven't yet, open the recipe link above in Poke, then text it.\n`);
    }
  };
  tunnel.stdout?.on("data", onChunk);
  tunnel.stderr?.on("data", onChunk);

  const shutdown = () => {
    for (const s of manager.list()) {
      try {
        manager.stop(s.sessionId);
      } catch {
        /* ignore */
      }
    }
    tunnel.kill();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  tunnel.on("exit", (code) => {
    console.log(`\n  Connection to Poke stopped (often the PC slept, the lid closed, or Wi-Fi dropped).`);
    console.log(`  To use it again, run:  claude-poke start`);
    console.log(`  If Poke still can't reach Claude Code after that, run \`claude-poke recipe\` to re-link.\n`);
    server.close();
    process.exit(code ?? 0);
  });
}

async function serve(): Promise<void> {
  const cfg = loadConfig();
  await startServer(cfg);
  const url = `http://localhost:${cfg.port}/mcp`;
  console.log(`claude-poke MCP server on ${url}`);
  console.log(`Connect it to Poke yourself:`);
  console.log(`  npx ${POKE.join(" ")} tunnel ${url} -n "Claude Code"`);
  console.log(`Then add the Claude Code recipe to your Poke: ${RECIPE_URL}`);
}

function recipe(): void {
  console.log(`Add the Claude Code recipe to your Poke account (one-time):\n  ${RECIPE_URL}\n`);
  console.log(`Then run \`${launchHint()}\` to connect this machine's bridge.`);
}

async function status(): Promise<void> {
  const cfg = loadConfig();
  console.log(`config:        ${configPath()}`);
  console.log(`port:          ${cfg.port}`);
  console.log(`permission:    ${cfg.defaultPermissionMode} (default for new sessions)`);
  console.log(`notifications: ${cfg.pokeApiKey ? "on" : "off"}`);
  console.log(`recipe:        ${RECIPE_URL}`);
  const [all, live] = await Promise.all([listSessions().catch(() => []), listLiveSessions().catch(() => [])]);
  console.log(`sessions on disk: ${all.length}  |  live terminal sessions: ${live.length}`);
}

// ---------------------------------------------------------------- helpers
function pokeWhoami(): boolean {
  try {
    execSync(`npx ${POKE.join(" ")} whoami`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function run(cmd: string): Promise<void> {
  return new Promise((res) => {
    const child = spawn(cmd, { stdio: "inherit", shell: true });
    child.on("exit", () => res());
    child.on("error", () => res());
  });
}
/** Best command to (re)launch the bridge — `claude-poke` if globally installed, else the npx form. */
function launchHint(): string {
  try {
    execSync(process.platform === "win32" ? "where claude-poke" : "command -v claude-poke", { stdio: "ignore" });
    return "claude-poke";
  } catch {
    return "npx github:HKTITAN/claude-poke";
  }
}

// ---------------------------------------------------------------- main
const program = new Command();
program.name("claude-poke").description("Let Poke run & control Claude Code on your own machine.").version("0.2.1");
program.command("setup").description("Guided setup / doctor").action(() => setup());
program.command("start", { isDefault: true }).description("Connect to Poke (runs setup first if needed)").action(start);
program.command("serve").description("Start just the MCP server (advanced / pm2)").action(serve);
program.command("recipe").description("(Re)mint and show your Poke recipe link").action(recipe);
program.command("doctor").description("Re-run environment checks (no prompts)").action(doctor);
program.command("status").description("Show config + session counts").action(status);
program.parseAsync(process.argv);
