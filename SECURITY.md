# Security Policy

`@hktitan/claude-poke` is a local-only bridge that lets the [Poke](https://poke.com) assistant run and
control [Claude Code](https://code.claude.com/docs) sessions on your own machine. Because of what it
does, the security model is unusually concentrated. Please read the threat model before deploying it.

## Threat model

claude-poke runs Claude Code on your machine **at maximum power by default** (`bypassPermissions` — file
edits plus raw shell) and **in any folder you point it at**. The MCP server binds only to `127.0.0.1`,
and Poke reaches it through **Poke's own tunnel, registered in your Poke account** (account-scoped — only
your Poke can route to it). The `poke tunnel` CLI cannot attach a bearer token, so by default there is no
per-request secret: the **trust boundary is the tunnel plus the local-only bind**. Two consequences:
(1) other processes running on the same machine can also reach `localhost:<port>/mcp` and drive Claude
Code, so treat the host as you would any trusted dev machine; and (2) anyone who obtains your tunnel /
recipe link could reach your bridge, so don't share them. An **optional** bearer secret
(`CLAUDE_POKE_SECRET` / `sharedSecret`) can be enabled for a *remote* deployment registered via
`poke mcp add <https-url> -k <secret>`, in which case every request must present
`Authorization: Bearer …` (constant-time checked, else `401`); it does not apply to the local tunnel
flow. claude-poke adds no sandbox of its own beyond the local bind; sessions do run with
`settingSources: []`, so your personal `~/.claude` config and memory are not loaded into a session's
settings, but that is isolation of configuration, not of capability.

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

The tunnel and the local-only bind are the boundary. To keep it tight:

- **Run only on a machine you trust.** With no bearer by default, any process on the same machine can
  reach `localhost:<port>/mcp` and drive Claude Code. Don't run claude-poke alongside untrusted local
  software, and don't run it on a shared/multi-user box.
- **Don't share your recipe link or tunnel.** They route to your machine. Treat them like a credential.
- **Dial down the permission mode.** The default is `bypassPermissions` (unrestricted shell). If you
  don't need that, start sessions with `permission_mode: 'plan'` (proposals only) or `'acceptEdits'`,
  or set a tighter default in `~/.claude-poke/config.json`. Lower power means less blast radius.
- **Keep the bind local.** The bridge listens on `127.0.0.1` and reaches the outside world only through
  Poke's account-scoped tunnel. Don't expose the port directly or behind your own proxy.
- **Optional bearer for remote setups.** If you deploy the server remotely (not the local tunnel) and
  register it with `poke mcp add <https-url> -k <secret>`, set `CLAUDE_POKE_SECRET` so every request must
  present a matching `Authorization: Bearer …`. Rotate it by clearing it and restarting.
- **Stop the bridge when you're not using it.** Sessions run only while `claude-poke start` is running.
  Shutting it down closes the tunnel and the attack surface.
- **Stay current.** Run supported `0.2.x` and update when security releases ship.
- **Guard the config file.** `~/.claude-poke/config.json` holds the secret and (optionally) your Poke
  API key. Keep it on an account-private path and never commit it to a repo.
