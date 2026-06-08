# Contributing to claude-poke

Thanks for your interest in improving **[@hktitan/claude-poke](https://github.com/HKTITAN/claude-poke)** — the
local-only bridge that lets the [Poke](https://poke.com) assistant run and control
[Claude Code](https://code.claude.com/docs) sessions on your own machine.

This project is small, MIT-licensed, and intentionally local-first: it runs entirely on the contributor's PC,
uses the Claude Code login already on it (no API key), and exposes Claude Code at **maximum power**
(`bypassPermissions` — edits + raw shell) gated only by a bearer secret. That security model shapes how we
review changes, so please read the [Security](#security--please-read) section before opening a PR that touches
auth, the network surface, or the permission posture.

---

## Prerequisites

- **Node 18+** (CI runs on Node 18, 20, and 22). Check with `node -v`.
- **Signed in to Claude Code on this machine** — run `claude` once and log in with your claude.ai
  subscription. No API key is needed. (`hasLocalClaudeAuth()` in `src/config.ts` looks for
  `~/.claude/.credentials.json`, or `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` in the environment.)
- **Poke** on your phone — https://poke.com — only if you want to exercise the end-to-end flow (the tunnel +
  recipe). It is **not** required to build, run the unit tests, or do most local development; the smoke tests
  deliberately do not touch a live session or the network.
- **git** — the `get_diff` tool shells out to `git`, and a few tests/manual checks assume it's on `PATH`.

---

## Local development

```bash
git clone https://github.com/HKTITAN/claude-poke.git
cd claude-poke
npm install
```

Common loops:

| Command | What it does |
|---|---|
| `npm run dev` | Run the CLI straight from TypeScript via `tsx` (e.g. `npm run dev -- status`, `npm run dev -- doctor`). No build step. |
| `npm run build` | Type-check + compile `src/**.ts` → `dist/` with `tsc` (strict). This is also the type check — there is no separate `lint`/`typecheck` script. |
| `npm test` | `npm run build` then `node --test`. Always build before testing — the tests import the compiled `dist/`. |

To pass args through an npm script, use `--`, e.g. `npm run dev -- doctor` or `npm run dev -- serve`.

### Running the bridge locally for testing

You can exercise the server without involving Poke at all:

```bash
npm run dev -- serve
```

This starts only the MCP server, bound to `127.0.0.1:4517` (override with `PORT`), and prints the
`http://localhost:<port>/mcp` URL plus the bearer secret location. Then drive it directly:

- **Health check (unauthenticated):** `curl http://localhost:4517/healthz` → `{"ok":true}`.
- **MCP calls:** `POST /mcp` is open by default (the local tunnel can't attach a bearer, so the boundary is
  the tunnel + `127.0.0.1` bind). Set `CLAUDE_POKE_SECRET=...` (or `sharedSecret` in config) to *opt in* to
  bearer enforcement — then every `POST /mcp` must send `Authorization: Bearer <secret>` or gets `401`.
  That path is for remote deployments registered via `poke mcp add <url> -k <secret>`.

Handy env overrides (see `loadConfig()` in `src/config.ts`): `PORT`, `CLAUDE_POKE_SECRET`, `POKE_API_KEY`,
and `CLAUDE_POKE_RECIPE_URL`.

For the **full** Poke ↔ bridge path (`npm run dev -- start`, which spawns the Poke tunnel and registers the
"Claude Code" integration), you'll need to be logged into the Poke CLI and have added the recipe to your Poke
account. See the README's *Setup* and *Maintainer: publish the recipe* sections — most code changes don't
require this.

---

## Project layout

All logic lives in `src/` (ESM, `.js` import specifiers because the project compiles to `NodeNext` modules):

| File | Responsibility |
|---|---|
| `src/config.ts` | Config type + load/save (`~/.claude-poke/config.json`, `chmod 600`), env overrides, and the local Claude-auth check. The bearer secret and default permission mode live here. |
| `src/sessionStore.ts` | **Read-only** enumeration of on-disk Claude Code sessions under `~/.claude` (resumable + live terminal sessions), transcript tailing, and the lossy project-dir decode. No mutation. |
| `src/sessionManager.ts` | The heart: long-lived, controllable **managed** sessions, each a streaming Agent-SDK `query()`. Owns send/interrupt/set-model/set-permission, the lifecycle state machine, and permission prompts. |
| `src/notify.ts` | Optional proactive Poke notifications (finish / needs-input), debounced and retrying. No-ops without a Poke API key. |
| `src/tools.ts` | The MCP tool surface exposed to Poke (`list_sessions`, `start_session`, `send_message`, …). Thin wrappers over `SessionManager` + `SessionStore`. |
| `src/server.ts` | The Express/MCP HTTP bridge: bearer-auth gate, `127.0.0.1` bind, per-request MCP server wired to the long-lived `SessionManager` singleton. |
| `src/cli.ts` | The `claude-poke` CLI: `setup`/`start`/`serve`/`recipe`/`doctor`/`status`, guided prompts, and the Poke tunnel spawn. |

Supporting files: `test/smoke.test.mjs` (Node test runner, imports `dist/`), `recipe.json` (the Poke recipe
fields), `.env.example`, and `.github/workflows/{ci,publish}.yml`.

---

## Coding conventions

- **TypeScript, strict.** `tsconfig.json` enables `strict`; keep the build clean (`npm run build` must pass
  with no errors). Avoid `any`; prefer the existing `zod` schemas for tool inputs and explicit return types
  on exported functions.
- **ESM + NodeNext.** Use `import … from "./foo.js"` (the `.js` suffix even for `.ts` sources) and
  `node:`-prefixed builtins (`node:fs`, `node:crypto`, …), matching the current code.
- **Match the surrounding style.** Two-space indent, double quotes, semicolons, small focused helpers, and a
  short top-of-file doc comment explaining each module's role (every `src/*.ts` has one — keep that up).
- **Keep tool descriptions precise.** The strings in `src/tools.ts` are the contract Poke's agent reads to
  decide what to call. If you change a tool's behavior, update its `description`/`inputSchema` to match, and
  mirror the change in the README's tool list.
- **Fail safe, leak nothing.** Errors returned to callers should be actionable but must not echo secrets;
  keep `/healthz` unauthenticated and contentless.
- **Tests stay hermetic.** `test/smoke.test.mjs` must not require a live Claude session or network access —
  it imports the compiled `dist/` and exercises pure logic (secret comparison, PID liveness, session
  enumeration, text extraction, no-op notify). Add tests in the same style for new pure logic.

---

## Tests

```bash
npm test          # build, then node --test
```

`node --test` discovers files under `test/`. Because tests import `dist/`, run `npm run build` (or just
`npm test`, which builds first) after changing `src/`. CI (`.github/workflows/ci.yml`) runs `npm ci`,
`npm run build`, and `node --test` on every push to `main` and every PR — your PR must be green.

If your change adds testable pure logic (parsing, auth, enumeration, formatting), add a case to
`test/smoke.test.mjs` or a sibling `*.test.mjs`. Logic that genuinely needs a live Claude session is hard to
test here by design — describe how you verified it manually in the PR instead.

---

## Commit & PR guidance

- **Branch** off `main` and open a PR against `HKTITAN/claude-poke`.
- **Keep PRs focused** — one logical change per PR. Update the README and tool descriptions when behavior
  changes.
- **Before pushing:** `npm run build` and `npm test` both pass locally.
- **Commit messages:** short imperative subject (e.g. "tools: tighten resume_session live-session guard"),
  with a body explaining the *why* when it isn't obvious.
- Fill out the **pull request template** (it loads automatically) — especially the security checkbox if you
  touched auth, the network surface, the permission posture, or anything that runs shell commands.

### License & sign-off

This project is **MIT** (`LICENSE`, © HKTITAN). By contributing, you agree your contributions are licensed
under the same MIT license.

A [DCO](https://developercertificate.org/)-style sign-off is **optional but welcome** — add `-s` to your
commit (`git commit -s`) to append a `Signed-off-by:` trailer certifying you have the right to submit the
change.

---

## Security — please read

claude-poke runs Claude Code on the contributor's machine at **maximum power by default**
(`bypassPermissions` = file edits + raw shell, in any folder), reachable through Poke's tunnel. **The bearer
secret is the only trust boundary.** Be especially careful with changes that:

- touch the **auth check** (`checkAuth` / `secretsMatch` in `src/server.ts`) — keep it constant-time and
  fail-closed;
- widen the **network surface** (new routes, the `127.0.0.1` bind, CORS, the `8mb` body limit);
- change the **default permission posture** or how `permission_mode` is plumbed through `start_session` /
  `resume_session` / `set_permission_mode`;
- handle the **secret or Poke API key** (don't log them, persist with `chmod 600`, never echo them in tool
  output or notifications);
- run **shell/`git`/`execFile`** with caller-influenced input.

If you find a security issue, please email the maintainer at **campusbinge.tech@gmail.com** rather than
opening a public issue.

---

Questions or ideas? Open an issue at https://github.com/HKTITAN/claude-poke/issues, or reach the maintainer at
campusbinge.tech@gmail.com. Thanks for contributing!
