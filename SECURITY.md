# Security Policy

`@hktitan/claude-poke` is a local-only bridge that lets the [Poke](https://poke.com) assistant run and
control [Claude Code](https://code.claude.com/docs) sessions on your own machine. Because of what it
does, the security model is unusually concentrated. Please read the threat model before deploying it.

## Threat model

claude-poke runs Claude Code on your machine **at maximum power by default** (`bypassPermissions` — file
edits plus raw shell) and **in any folder you point it at**. The MCP server binds only to `127.0.0.1`,
and the single ingress is Poke's authenticated tunnel: every request must present an auto-generated
24-byte **bearer secret** (`Authorization: Bearer …`), which is checked in constant time; everything
else gets a `401`. That bearer secret is therefore the **only trust boundary**. Anyone who obtains it —
by seeing your recipe link/secret, reading it from the process list on a shared machine (the `poke
tunnel` CLI receives it as an argument), or pulling it from `~/.claude-poke/config.json` — can drive
Claude Code on your PC with raw-shell access to your files. Treat the secret like an SSH private key.
claude-poke does not add a sandbox of its own beyond the bearer check and the local bind; sessions do
run with `settingSources: []`, so your personal `~/.claude` config and memory are not loaded into a
session's settings, but that is isolation of configuration, not of capability.

## Supported versions

Security fixes are released for the current `0.2.x` line only. Older `0.1.x` builds are unsupported —
please upgrade.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2.0 | :x:                |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.** A public issue discloses the
flaw to everyone before a fix exists, which is especially dangerous for a tool that grants raw-shell
access.

Report privately by either of these channels:

- **Email** [campusbinge.tech@gmail.com](mailto:campusbinge.tech@gmail.com) with `SECURITY` in the
  subject line, or
- **GitHub private security advisory** — open one at
  <https://github.com/HKTITAN/claude-poke/security/advisories/new> (Security → Advisories → *Report a
  vulnerability*). This keeps the report private to the maintainer until a fix ships.

Please include, as far as you can:

- the version (`claude-poke status` shows it, or check `package.json`),
- a description of the issue and its impact (e.g. secret exposure, auth bypass, unintended command
  execution),
- step-by-step reproduction, and
- any suggested fix or mitigation.

If you believe a deployed bearer secret may have leaked, rotate it immediately (see the hardening
checklist) and then report.

### What to expect

- **Acknowledgement** within **3 business days**.
- An initial assessment and severity triage within **7 business days**.
- Coordinated disclosure: we will work with you on a fix and a release on the supported `0.2.x` line,
  and credit you in the advisory unless you prefer to remain anonymous. Please give us a reasonable
  window to ship a fix before any public disclosure.

This is a small, single-maintainer project; timelines are best-effort but we take secret-exposure and
auth-bypass reports seriously and prioritize them.

## Hardening checklist for users

The bearer secret is the whole game. To keep it that way:

- **Protect and rotate the secret.** Don't share your recipe link or the `sharedSecret`. Rotate it by
  deleting `sharedSecret` from `~/.claude-poke/config.json` and re-running setup (`npx
  @hktitan/claude-poke`). Rotate immediately if you suspect exposure.
- **Don't run on shared or untrusted machines.** `poke tunnel` receives the secret as a CLI argument,
  which is visible in the process list to other users on a multi-user box. Run claude-poke only on a
  machine you alone control.
- **Dial down the permission mode.** The default is `bypassPermissions` (unrestricted shell). If you
  don't need that, start sessions with `permission_mode: 'plan'` (proposals only) or `'acceptEdits'`,
  or set a tighter default in `~/.claude-poke/config.json`. Lower power means a leaked secret does less
  damage.
- **Keep the bind local.** The bridge listens on `127.0.0.1` and reaches the outside world only through
  Poke's authenticated tunnel. Don't expose the port directly or place it behind your own reverse proxy
  — that removes the bearer check as the sole, deliberate boundary.
- **Stop the bridge when you're not using it.** Sessions run only while `claude-poke start` is running.
  Shutting it down closes the tunnel and the attack surface.
- **Stay current.** Run supported `0.2.x` and update when security releases ship.
- **Guard the config file.** `~/.claude-poke/config.json` holds the secret and (optionally) your Poke
  API key. Keep it on an account-private path and never commit it to a repo.
