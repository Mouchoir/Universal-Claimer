# Implementation Plan: Connect an Account and Run an Automated Claim

**Branch**: `001-connect-and-claim` | **Date**: 2026-07-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-connect-and-claim/spec.md`

## Summary

Deliver the core end-to-end slice of Universal Claimer: from a clean single-user Docker
deployment, the operator completes first-run onboarding, connects one Epic Games account
(guided cookies import or credential+TOTP), consents to the service TOS, triggers a claim
on demand, and sees a real-time terminal outcome — with a layered captcha strategy and an
optional outbound webhook notification.

Technical approach: a TypeScript monorepo (pnpm workspaces) delivered as one Docker Compose
stack — a Next.js web app (portal + API + realtime), a worker process driving CloakBrowser
(headed via Xvfb) through connector plugins, and a bundled Postgres. The job queue is
Postgres-backed (pg-boss) so no extra infrastructure is needed, keeping the Compose YAML
minimal. Third-party secrets use envelope encryption (AES-256-GCM) with an app key from the
environment. The Epic connector is the reference implementation behind a connector-agnostic
interface.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 20 LTS.

**Primary Dependencies**: Next.js (App Router) for portal + HTTP API + realtime; Playwright
driving CloakBrowser (source-patched Chromium, drop-in for Playwright); pg-boss (Postgres
job queue); Drizzle ORM + node-postgres; argon2 (password + security-answer hashing); Node
`crypto` (AES-256-GCM envelope encryption); Zod (input + config validation).

**Storage**: PostgreSQL 16, bundled as a container in the Compose stack.

**Testing**: Vitest (unit); Playwright Test for connector contract tests run against
recorded/mocked platform fixtures (no live third-party calls in CI); a small integration
suite exercising onboarding → connect → run against a stub connector.

**Target Platform**: Linux x86_64 container on a self-hosted host (home NAS); the worker
runs CloakBrowser headed under Xvfb. ARM is unsupported.

**Project Type**: Web application (frontend + backend) plus a worker service — organized as
a pnpm monorepo.

**Performance Goals**: Dashboard reflects a job status change within 5s (SC-005); claims are
low-frequency (weekly for Epic) so throughput is not a concern; a single claim run should
complete within a few minutes including browser startup.

**Constraints**: x86_64 only; single-user (no multi-tenancy/RLS); `docker compose up` must
work with a minimal YAML (only DB URL, app encryption key, port in env); no third-party
secret ever in plaintext at rest, in logs, screenshots, or dumps; no VNC/remote desktop.

**Scale/Scope**: One operator; at most one account per service; three connectors in the MVP
(Epic delivered in this feature, MS Rewards + Twitch built on the same interface later).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | How this plan complies |
|---|---|
| I. Connector Isolation | Connectors are separate workspace packages behind a uniform `Connector` interface (authenticate/claim/healthCheck/capabilities); the app and worker never reference a specific connector. Each connector carries a version and health-check. See [contracts/connector-interface.md](contracts/connector-interface.md). |
| II. Secret Custody Minimalism | AES-256-GCM envelope encryption; app key from env, outside Postgres. Secrets decrypted only in the worker, in memory, per job. A logging redaction layer forbids secret fields in logs; job records store no secrets. Session import preferred over passwords. |
| III. Test-First + Docs | Every package ships Vitest unit tests + a connector contract test against fixtures; `quickstart.md` and per-package READMEs are part of the definition of done. |
| IV. English Everywhere | All code, docs, and artifacts are English. |
| V. Layered Anti-Detection; Captcha as Exception | CloakBrowser prevents; anti-captcha.com auto-solves; portal-relayed human fallback last. No VNC. |
| VI. TOS Transparency | Connect flow blocks on a service-specific warning + timestamped consent row; the worker refuses to run without a consent record. |
| VII. Identity Isolation | Persistent per-account fingerprint stored and reused; no proxy in the MVP (home IP), interface leaves room to add one later. |

**Result**: PASS. No violations; Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-connect-and-claim/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── contracts/           # Phase 1 output
    ├── connector-interface.md
    ├── http-api.md
    └── realtime-events.md
```

### Source Code (repository root)

```text
apps/
├── web/                     # Next.js: portal, onboarding wizard, HTTP API, realtime (SSE/WS)
│   ├── src/app/             # routes (onboarding, dashboard, accounts, jobs)
│   ├── src/server/          # API handlers, auth (session), realtime hub
│   └── tests/
└── worker/                  # Node worker: pulls jobs, runs CloakBrowser via connectors
    ├── src/
    └── tests/

packages/
├── core/                    # shared: config/env validation, crypto (envelope), logging+redaction, types
│   ├── src/
│   └── tests/
├── db/                      # Drizzle schema, migrations, data-access; pg-boss setup
│   ├── src/
│   └── tests/
├── connectors/              # connector-agnostic runtime + plugin registry
│   ├── src/connector.ts     # the Connector interface + shared helpers (cookies.txt parser, TOTP)
│   ├── src/epic/            # Epic Games connector (reference implementation)
│   └── tests/               # contract tests against recorded fixtures
└── notifications/           # in-portal event emit + optional outbound webhook (Discord/Telegram/ntfy)

deploy/
├── docker-compose.yml       # minimal: web, worker, postgres
├── Dockerfile.web
├── Dockerfile.worker        # includes CloakBrowser + Xvfb
└── .env.example             # DB URL, APP_ENCRYPTION_KEY, PORT

docs/                        # project docs (vision.md already here; add setup/operations)
```

**Structure Decision**: pnpm monorepo with a clear split between the user-facing app
(`apps/web`), the automation runtime (`apps/worker`), and shared libraries (`packages/*`).
Connectors live in `packages/connectors` as isolated modules so a new service (MS Rewards,
Twitch) is added by dropping in a package that implements the interface — with zero changes
to the app or worker (Principle I). The whole thing builds into two images (web, worker)
plus stock Postgres, wired by one minimal Compose file.

## Complexity Tracking

> No constitution violations. Nothing to justify.
