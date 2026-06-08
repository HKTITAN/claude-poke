<!--
Thanks for contributing to @hktitan/claude-poke!
See CONTRIBUTING.md for setup, conventions, and the security model.
Keep PRs focused on one logical change.
-->

## What & why

<!-- What does this PR change, and why? Link any related issue (e.g. Closes #123). -->

## How I tested it

<!-- Commands you ran (npm run build / npm test) and any manual verification.
     Logic that needs a live Claude session can't be unit-tested here — describe how you checked it. -->

## Checklist

- [ ] `npm run build` passes (TypeScript strict, no errors)
- [ ] `npm test` passes locally (build + `node --test`)
- [ ] Tests added/updated for new pure logic (or N/A — explain in "How I tested it")
- [ ] Docs updated where behavior changed (README, tool `description`/`inputSchema` in `src/tools.ts`)
- [ ] Security considered — see below

## Security

This bridge runs Claude Code at **maximum power by default** (`bypassPermissions` = edits + raw shell), with
the **bearer secret as the only trust boundary**. Tick what applies:

- [ ] No change to auth, the network surface, the default permission posture, secret handling, or shell/`git` execution
- [ ] If any of the above changed: the auth check stays constant-time and fail-closed, secrets/API keys are never logged or echoed, and caller-influenced input into shell/`execFile` is handled safely
