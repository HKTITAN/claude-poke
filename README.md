# @hktitan/claude-poke

[![CI](https://img.shields.io/github/actions/workflow/status/HKTITAN/claude-poke/ci.yml?branch=main&label=CI&logo=github)](https://github.com/HKTITAN/claude-poke/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/HKTITAN/claude-poke?sort=semver&logo=github)](https://github.com/HKTITAN/claude-poke/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js)](https://nodejs.org)

**Run and control [Claude Code](https://code.claude.com/docs) sessions on your own computer — from [Poke](https://poke.com), by text.**

Everything runs locally on your machine. No deployment, **no API key** (it uses the Claude Code login
already on your PC — your claude.ai subscription). One command sets it up.

This package is **not on the public npm registry** — it lives on **GitHub Packages**. So `npx @hktitan/claude-poke`
alone gives a 404. Use one of these instead:

**Easiest — run straight from the repo (no token):**

```
npx github:HKTITAN/claude-poke
```

That clones, builds, and runs it — first run sets you up, then connects to Poke; later runs just connect.

**Or install the published package from GitHub Packages** (needs auth — GitHub Packages requires it even
for public packages). Add an `.npmrc` (in the folder you run from, or `~/.npmrc`) with a
[GitHub token](https://github.com/settings/tokens) that has `read:packages`:

```
@hktitan:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

…then `npx @hktitan/claude-poke` works.

Then text Poke things like:

> *"Start a Claude session in C:/code/my-app and add tests to the auth module."*
> *"List my Claude sessions."* · *"What's session a1b2c3 doing right now?"*
> *"Send a1b2c3: now run the tests and fix anything that breaks."* · *"Stop a1b2c3."*

…and Claude Code does it on your machine. When a session finishes (or needs your go-ahead), Poke
can text you.

---

## How it works

```
   Your phone (Poke)
        │  text
        ▼
   Poke cloud ──HTTPS (Poke's tunnel)──▶  claude-poke bridge  (runs on YOUR PC)
                                              │
                                  ┌───────────┴───────────┐
                                  ▼                       ▼
                         SessionManager            SessionStore (read-only)
                  N live Claude Code sessions   ~/.claude history + running
                  (start / send / interrupt /   terminal sessions you can
                   set model / approve)         list & watch
                                  │
                                  └──HTTPS POST──▶ Poke (proactive "finished" / "needs input" texts)
```

A small MCP server runs on your PC. Poke reaches it through **Poke's own tunnel** — nothing is hosted
anywhere. The trade-off: your PC must be awake with `claude-poke start` running while you use it.

### Three kinds of session
| Kind | What it is | What Poke can do |
|---|---|---|
| **managed** | a session claude-poke launched/resumed | full control: send, interrupt, set model/permission, stop |
| **resumable** | a past session on disk (`~/.claude`) | resume it → becomes managed |
| **live** | a `claude` you're running in a terminal | **read-only**: list & watch (tail). Resume it (fork) to take over. |

## What Poke can do (the tools)

`list_sessions` · `start_session(cwd, task, model?, permission_mode?)` · `send_message(session_id, message)` ·
`resume_session(session_id, message, fork?)` · `get_session(session_id)` · `tail_session(session_id)` ·
`interrupt_session` · `set_model` · `set_permission_mode` · `respond_permission(session_id, approve)` ·
`stop_session` · `list_models` · `list_commands` · `account_info` · `get_diff` · `notify_status`

Sessions are multi-turn with full memory, controllable mid-run (interrupt, switch model, change how much
it's allowed to do), and run at **maximum power by default** (`bypassPermissions` — edits + raw shell).
Long tasks return immediately with a `session_id`; Poke polls `get_session` or waits for the finish text.

## Setup

### Prerequisites
- **Node 18+**
- **Be signed in to Claude Code on this PC** — run `claude` once and log in with your claude.ai
  subscription. *No API key needed.*
- **Poke** on your phone — https://poke.com.
- *Optional, for proactive texts:* a **Poke API key** from [poke.com/kitchen](https://poke.com/kitchen) → API Keys.

### Run it
```bash
npx github:HKTITAN/claude-poke
```
The **first run** walks you through setup (Claude login, Poke login, optional notifications), then connects
this machine to your Poke. **Later runs** just connect. Keep it running while you use it.

*(Installed globally with `npm i -g @hktitan/claude-poke`? Just run `claude-poke`. From GitHub Packages?
`npx @hktitan/claude-poke`. Explicit subcommands still work: `setup`, `serve`, `doctor`, `status`, `recipe`.)*
Then, **one time**, open the **Claude Code recipe** in Poke to add the onboarding:

> **[poke.com/r/Egtr2rOr5Xk](https://poke.com/r/Egtr2rOr5Xk)**

That single recipe is published once (from the maintainer's Poke account) — every user installs the *same*
link; your `claude-poke start` connects *your* machine. Keep `claude-poke start` running, then text Poke.

> Claude Code ships **inside** the package (the Agent SDK bundles it) — no separate install for the bridge.

### Commands
| Command | What it does |
|---|---|
| `claude-poke` / `setup` | Guided setup + environment checks |
| `claude-poke start` | Connect this machine's bridge to your Poke (the tunnel) |
| `claude-poke serve` | Just the MCP server (for pm2/systemd) |
| `claude-poke recipe` | Print the recipe link to install in Poke |
| `claude-poke doctor` | Re-run checks (Claude login, Poke login, secret, notifications) |
| `claude-poke status` | Config + session counts |

## Notifications (optional)

If you add a Poke API key at setup, claude-poke texts you (via `poke.com/api/v1/inbound/api-message`)
when a session **finishes a turn** or **needs input** (a permission ask, in non-bypass modes). Each text
carries the session's short id so your reply routes back to the right session. Without a key, everything
still works — Poke just polls `get_session`.

## Security — read this

This lets Poke run Claude Code on your machine, by default at **maximum power (raw shell), in any folder**.
The **bearer secret is the only trust boundary** — anyone who has it can drive Claude Code on this PC.

- **Bearer secret:** Poke must present an auto-generated 24-byte secret (`Authorization: Bearer …`),
  constant-time checked; everything else gets `401`. Don't share the recipe link/secret. Rotate by
  deleting `sharedSecret` from `~/.claude-poke/config.json` and re-running setup.
- **Local-only bind:** the bridge listens on `127.0.0.1`; Poke's authenticated tunnel is the only ingress.
- **Isolation:** sessions run with `settingSources: []`, so your personal `~/.claude` config/memory
  doesn't leak into a session's settings.
- **Dial it down:** start sessions with `permission_mode: 'plan'` (proposals only) or `'acceptEdits'`,
  or set a default in the config, if you don't want unrestricted shell.
- **Shared machines:** `poke tunnel` receives the secret as a CLI argument (visible in the process list).
  Don't run this on a multi-user/untrusted machine.

## Maintainer: publish the recipe (once)

There is **one shared recipe**, published from the maintainer's Poke account — every user installs the
same link. The canonical recipe is already live at **[poke.com/r/Egtr2rOr5Xk](https://poke.com/r/Egtr2rOr5Xk)**
(baked into `RECIPE_URL`). The steps below are only needed if you fork and want your own.

1. Go to [poke.com/kitchen](https://poke.com/kitchen) → **Create recipe**.
2. Transcribe the fields from [`recipe.json`](recipe.json): name, description, the `inputContext`, and
   `prefilledFirstText`. (Each user connects their own bridge via `claude-poke start`, so the integration
   is per-user — do **not** hardcode a server URL.)
3. **Publish** → copy the `https://poke.com/r/<code>` link.
4. Set that link in the CLI before shipping: edit `RECIPE_URL` in `src/cli.ts` (or ship with the env var
   `CLAUDE_POKE_RECIPE_URL`). Then `npm publish`.

Do **not** use `poke tunnel --recipe` — that mints a *per-user* recipe tied to one machine, which is the
opposite of one shared link.

## Publishing the package (GitHub Packages)

Published to **GitHub Packages** under `@hktitan`. `.github/workflows/publish.yml` runs on a **GitHub
Release** (or `workflow_dispatch`) and publishes with the built-in `GITHUB_TOKEN` (`packages: write`).

To cut a release: bump `version` in `package.json`, commit, then `gh release create vX.Y.Z`. `prepublishOnly`
rebuilds `dist/` as a safety net.

Installing from GitHub Packages requires the same `.npmrc` shown at the top of this README
(`@hktitan:registry=https://npm.pkg.github.com` + a GitHub token with `read:packages`) — GitHub Packages
needs auth even for public packages.

## Limitations

- **PC must be awake** with `start` running. For always-on, run it under pm2/systemd.
- **Managed sessions are in-memory** — restarting the bridge ends them (their transcripts stay on disk and
  are resumable).
- **Live terminal sessions are read-only** (owned by another process) — resume (fork) one to take control.
- **Interactive permission modes are experimental.** The default `bypassPermissions` (max power) is fully
  supported. In `default`/`plan`/`acceptEdits`/`dontAsk`, the needs-input notification + `respond_permission`
  flow works, but the *turn after an approval* can currently fail (a known upstream Agent SDK bug —
  `tool_use ids must be unique`). Stick with the default unless you specifically need proposal-only `plan`.
- Usage draws on your **Claude subscription** (the login on this machine).

## License

[MIT](LICENSE) © HKTITAN
