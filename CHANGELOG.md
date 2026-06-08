# Changelog

All notable changes to **@hktitan/claude-poke** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Publishing is **GitHub Packages only** — removed the optional npmjs.org dual-publish path.

## [0.2.1] - 2026-06-08

### Added

- Open-source community files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
  GitHub issue forms + pull-request template, `CHANGELOG.md`, and README badges.

### Changed

- CI runs on Node 18 / 20 / 22 with `actions/checkout@v6` + `actions/setup-node@v6`.
- `publish.yml` now **dual-publishes**: GitHub Packages always, and npmjs.org when an
  `NPM_TOKEN` secret is set — which makes `npx @hktitan/claude-poke` work with zero setup.

### Notes

- **Interactive permission modes flagged experimental.** The needs-input notification +
  `respond_permission` flow works, but a turn can currently fail after an approval due to an
  upstream Agent SDK bug (`tool_use ids must be unique`). The default `bypassPermissions` is
  unaffected and recommended.

## [0.2.0] - 2026-06-08

The first publicly documented release: a local-only bridge that lets the
[Poke](https://poke.com) assistant run and control [Claude Code](https://code.claude.com/docs)
sessions on your own machine, by text.

### Added

- **Local session manager.** A small MCP server runs on your PC and manages N live
  Claude Code sessions in-memory via the bundled Agent SDK. Poke reaches it through
  Poke's own authenticated tunnel — nothing is hosted anywhere. The bridge binds to
  `127.0.0.1` only.
- **No API key — Claude subscription auth.** Sessions use the Claude Code login already
  on the machine (your claude.ai subscription). No Anthropic API key is required; usage
  draws on your subscription.
- **16 MCP tools** for full session control: `list_sessions`, `start_session`,
  `send_message`, `resume_session`, `get_session`, `tail_session`, `interrupt_session`,
  `set_model`, `set_permission_mode`, `respond_permission`, `stop_session`, `list_models`,
  `list_commands`, `account_info`, `get_diff`, and `notify_status`.
- **Three session kinds:** **managed** (launched/resumed by claude-poke, fully
  controllable), **resumable** (a past session on disk under `~/.claude`, which becomes
  managed when resumed), and **live** (a `claude` you run in a terminal — read-only:
  list and tail, or fork to take over).
- **Maximum power by default.** Sessions run with `bypassPermissions` (edits + raw shell)
  unless dialed down to `plan` or `acceptEdits`. Sessions are multi-turn with full memory
  and are controllable mid-run (interrupt, switch model, change permission mode).
- **Optional Poke notifications.** With a Poke API key, the bridge texts you (via
  `poke.com/api/v1/inbound/api-message`) when a session finishes a turn or needs input,
  carrying the session's short id so replies route back to the right session. Without a
  key, everything still works via `get_session` polling.
- **`doctor` setup and guided CLI.** `npx @hktitan/claude-poke` runs guided setup and
  environment checks; `claude-poke doctor` re-runs them (Claude login, Poke login, bearer
  secret, notifications). Additional commands: `setup`, `start`, `serve`, `recipe`,
  and `status`.
- **GitHub Packages publishing.** Published to GitHub Packages under `@hktitan` (auth
  required even for public packages); `prepublishOnly`/`prepack` rebuild `dist/`, and the
  `publish.yml` workflow ships on a GitHub Release.
- **One shared recipe.** A single Poke recipe ([poke.com/r/Egtr2rOr5Xk](https://poke.com/r/Egtr2rOr5Xk)),
  published once from the maintainer's account, that every user installs; each user's
  `claude-poke start` connects their own machine.

### Security

- **Bearer-secret trust boundary.** Poke must present an auto-generated 24-byte secret
  (`Authorization: Bearer …`), constant-time checked; everything else gets `401`. Rotate
  by deleting `sharedSecret` from `~/.claude-poke/config.json` and re-running setup.
- **Session isolation.** Sessions run with `settingSources: []`, so your personal
  `~/.claude` config and memory do not leak into a session's settings.

[Unreleased]: https://github.com/HKTITAN/claude-poke/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/HKTITAN/claude-poke/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/HKTITAN/claude-poke/releases/tag/v0.2.0
