# Contributing

Read **[AGENTS.md](AGENTS.md)** first — it is the maintained index of what this project is,
its rules, and its current state. The **[constitution](.specify/memory/constitution.md)** is
the source of truth and supersedes everything else.

## Non-negotiable rules (constitution)

1. **English everywhere** — code, comments, docs, commits, UI copy.
2. **Tests + docs are mandatory** — no feature/connector merges without automated tests
   (unit + a contract test against a mocked fixture) and documentation.
3. **Connector isolation** — a new service is a package implementing the connector
   interface; it must not require changes to the app, worker, queue, or data model.
4. **Secret custody minimalism** — secrets are encrypted at rest, never logged, never
   echoed; decrypted only in memory during a job.
5. **Captcha is layered** (prevent → auto-solve → human fallback); **no VNC**.
6. **TOS transparency** — a service-specific warning + timestamped consent before automation.

## Workflow (Spec-Driven Development)

Features go through spec-kit: `constitution → specify → clarify → plan → tasks → implement`.
Every change traces to an approved spec under `specs/`.

## Keeping AGENTS.md in sync

Any change that alters a principle, key decision, architecture, or the spec-kit state MUST
update `AGENTS.md` in the same change (constitution governance rule).

## Local commands

```bash
corepack pnpm install
corepack pnpm test           # all tests
corepack pnpm test:contract  # connector contract tests
corepack pnpm test:integration
corepack pnpm lint
corepack pnpm build
```
