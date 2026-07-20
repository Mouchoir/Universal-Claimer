# AGENTS.md — Universal Claimer

> Entry point for any AI or human working on this repository. Read this first.
> **Keep it up to date**: whenever a decision changes, update this file in the same change,
> and update the canonical source it points to. This file is a fast index, not the source
> of truth — the canonical documents are the constitution and the vision doc.

## What this project is

Universal Claimer is a **personal, open-source, self-hosted** platform that automatically
performs recurring "claim" actions on the operator's own third-party accounts:

- Claim free games (Epic Games weekly; later Amazon Prime Gaming, GOG)
- Collect Microsoft Rewards
- Resubscribe to a Twitch channel with Twitch Prime

It is **not** a commercial/hosted SaaS. Each person self-hosts their own instance via Docker.

## Canonical documents (source of truth)

| Document | What it holds |
|---|---|
| [.specify/memory/constitution.md](.specify/memory/constitution.md) | Non-negotiable principles and constraints. **Supersedes everything else.** |
| [docs/vision.md](docs/vision.md) | Product intent, confirmed technical reality, all key decisions, architecture, security posture. |
| [specs/](specs/) | Spec-kit feature specs. Current: [001-connect-and-claim](specs/001-connect-and-claim/spec.md). |

If this file disagrees with the constitution, the constitution wins — and this file is wrong
and must be fixed.

## Non-negotiable rules (from the constitution)

1. **English everywhere** — code, comments, specs, docs, commits, UI copy.
2. **Tests + docs mandatory** — no feature/connector merges without automated tests
   (unit + contract against a mocked platform fixture) and documentation.
3. **Connector isolation** — each target platform is a versioned, independently testable
   plugin with a uniform interface and a health-check.
4. **Secret custody minimalism** — third-party secrets are encrypted at rest (envelope
   encryption, key from compose env, outside the DB), never in plaintext, logs, screenshots,
   or dumps; decrypted only in memory during a job; prefer revocable sessions over passwords.
5. **Layered anti-detection; captcha as exception** — prevent (CloakBrowser) → auto-solve
   (anti-captcha.com) → human fallback. **VNC / remote desktop is prohibited.**
6. **TOS transparency** — a service-specific TOS warning + timestamped consent is required
   before any automation on a service, shown on every account-add.
7. **Identity isolation** — persistent per-account fingerprint; proxies deferred for the MVP.

## Key decisions (already made — do not re-litigate)

- **Tenancy**: single-user per deployment. No multi-tenancy, no RLS. Auth = one admin login
  set at onboarding.
- **Data layer**: bundled **plain Postgres** in the Docker Compose stack. **Supabase was
  dropped** (Auth/RLS pointless for single-user; managed dependency conflicts with easy
  self-hosting).
- **Distribution**: **Docker Compose with a deliberately minimal YAML** — `docker compose up`
  must Just Work. YAML holds only DB URL + app encryption key + port. Everything else is
  configured in the web onboarding wizard.
- **Host**: self-hosted, initially a home NAS, **x86_64 only** (CloakBrowser ships an x86_64
  Chromium binary; ARM is unsupported). Not a managed PaaS (they ban userbots/VNC).
- **Browser engine**: **CloakBrowser** (source-patched Chromium, drop-in for
  Playwright/Puppeteer), run **headed via Xvfb** on the headless host.
- **Third-party account auth**: **hybrid per service** — guided manual cookies export
  (upload/paste a `cookies.txt`) preferred; credential + TOTP login fallback. No public OAuth
  exists for the claim action, so this is session custody, not OAuth.
- **MVP scope**: Epic + Microsoft Rewards + Twitch Prime connectors, on-demand claims.
- **No monetization.** No proxies in the MVP (home residential IP).
- **One account per service** in the MVP.
- **Notifications**: in-portal realtime via SSE + one optional outbound webhook
  (Discord/Telegram/ntfy).
- **Admin password recovery**: optional 3 security questions (declinable) + always-available
  host-side reset command.

## Tech stack (decided at /plan)

TypeScript monorepo (pnpm workspaces) on Node 20. Next.js (portal + API + SSE); Playwright
driving CloakBrowser (headed via Xvfb); pg-boss (Postgres-backed job queue, no Redis);
Drizzle ORM + PostgreSQL 16; argon2id (password/recovery hashing); Node crypto AES-256-GCM
(envelope encryption); otplib (TOTP); Zod (validation). Tests: Vitest + Playwright contract
tests against recorded fixtures. Two images (web, worker) + stock Postgres via one Compose.

## Architecture (one Docker Compose stack)

```
Web app (Next.js: portal + onboarding wizard + SSE)
   └─ Postgres (admin, connected accounts [encrypted], jobs, results, consent)
   └─ Job orchestrator / queue
        └─ Workers: CloakBrowser (headed via Xvfb) — Epic / MS Rewards / Twitch
```

## Reference implementations (for connector inspiration)

- Epic / Prime / GOG: `vogler/free-games-claimer`
- Microsoft Rewards: `TheNetsky/Microsoft-Rewards-Script` (the mature reference: TOTP,
  persistent fingerprint, humanized delays), `charlesbel/Microsoft-Rewards-Farmer` (archived)
- Twitch Prime resub: `kylefmohr/twitch_prime_autosub`
- Amazon Prime loot: `srhinos/primelooter`

## Workflow (Spec-Driven Development via spec-kit)

Order: `constitution` → `specify` → `clarify` → `plan` → `tasks` → `implement`
(with `analyze` / `converge` as checks).

**Current state**: constitution ratified (v1.0.0); vision written; feature `001-connect-and-claim`
specified, clarified, planned, and **broken into tasks** (`specs/001-connect-and-claim/tasks.md`,
60 tasks across 7 phases) and **analyzed** (cross-artifact consistency check passed: 0
critical, coverage 100%; the MEDIUM findings were remediated by adding T012a/T020a/T027a/T035a).
**Implementation in progress** (`/speckit.implement`): **Phase 1 Setup + Phase 2
Foundational COMPLETE and verified.** Packages: `core` (config, crypto, logger, captcha),
`connectors` (Connector interface + runtime, CloakBrowser factory, cookies/TOTP, registry),
`db` (Drizzle schema 9 tables + migrations + pg-boss queue + connector-health), `apps/worker`
(state machine + startup reconciliation + queue loop), `apps/web` (Next.js skeleton + signed
session auth + argon2 + design-token baseline), `deploy/` (Dockerfiles web/worker + minimal
compose + .env.example). **40 unit tests green, `tsc -b` clean, web typecheck clean.**
Done: T001–T017 + T012a. **US1 (onboarding) COMPLETE**: admin/security-question/
notification-target data access, admin-service (setup/login/recover/reset behind an
AdminStore interface, 8 unit tests), setup+auth API routes, reset-admin CLI (tsx), onboarding
wizard + login + recover + dashboard pages, docs. **48 unit tests green, `tsc -b` + web
typecheck clean.** DB-backed integration tests are gated on `DATABASE_URL_TEST` (not run
here — Docker daemon was off).

**US2 (connect + consent) COMPLETE**: `connected_account`/`consent_record`/`service` data
access, Epic connector (authenticate + claim + healthCheck behind an injectable
`EpicPageDriver`; Playwright driver is best-effort DOM), services + accounts + consent API
routes (auth-guarded), connect UI (TOS gate → consent → method form), docs. Key design: the
**web app never launches a browser** — connect stores the sealed secret + default
fingerprint; session validity is checked on the first claim (worker). Shared zod schemas in
`schemas.ts` with a contract test. **58 unit tests green.** Done: T026–T033 + T027a.
**US3 (run claim) COMPLETE → MVP (US1+US2+US3) functionally done.** job data access +
state machine, `connector.claim` refactored to own its session (launch → auth-from-secret →
claim → close), worker `runClaim` orchestration (injectable deps, 5 unit tests) + production
wiring (Epic registered, CloakBrowser factory, anti-captcha, pg-boss loop), claim enqueue API
(consent + concurrency `409` guards), jobs API + **SSE** stream (Postgres LISTEN/NOTIFY),
dashboard Run button + live job list, docs. **73 unit tests green, `tsc -b` + web typecheck
clean.** Note: claim signature changed to `claim(input, fingerprint, ctx)` — contract doc updated.

**Feature 001 IMPLEMENTATION COMPLETE** — all 4 user stories + Polish. US4: `requires_human_action`
is a non-terminal outcome (pause → resume by re-enqueue, hand-back per FR-014, no VNC);
`@uc/notifications` best-effort webhooks wired into the worker. Polish: design hardening in
`globals.css` (focus states, controls, responsive — impeccable/taste-skill CLIs weren't
available, principles applied manually), connector auto-disable gating (enqueue `503` +
dashboard badge), `login`/`recover` rate-limiting (`429`), coverage top-ups.
**82 unit/contract tests green, `tsc -b` + web typecheck clean.**

Done: T001–T056 (T051 scroll-world SKIPPED, optional). **E2E VALIDATED against a live Postgres
(Docker)**: 87/87 tests green incl. 5 integration; production `next build` passes; full browser
walkthrough onboarding → connect Epic (cookies.txt + TOS consent) → Run claim → **live SSE**
status → graceful failure without CloakBrowser. Bugs found+fixed during e2e: pg-boss v10
`createQueue` (packages/db/src/queue.ts); Next `.js`/playwright-core bundling (webpack
extensionAlias + server external in next.config.mjs); `output: standalone` gated behind
`NEXT_OUTPUT` (Windows symlink).

**CloakBrowser is now integrated via the official `cloakbrowser` npm package** (real binary,
auto-managed — no manual path). `CloakBrowserFactory` lives at the `@uc/connectors/browser`
subpath (kept out of the web bundle; `defaultFingerprint` moved to `fingerprint.ts`). The
worker image pre-downloads the binary at build (`cloakbrowser install`); it also downloads on
first launch (~535MB, signature+checksum verified). Free v146 (no key); Pro via
`CLOAKBROWSER_LICENSE_KEY`. **Verified with the REAL binary**: a smoke test launched
CloakBrowser, drove the Epic connector against live epicgames.com with an empty session, and
correctly returned `reauth_needed`. **Still unproven:** a *successful* Epic claim (needs a
real authenticated Epic session); the connector's DOM selectors are best-effort. Feature 001
is otherwise complete. To run: see `docs/operations/onboarding.md` + quickstart.

**Assisted login (auto-capture cookies) — NEW, in progress** (docs/design/assisted-login.md).
Chosen approach: the operator logs in inside the instance-controlled CloakBrowser and cookies
are captured automatically (HttpOnly cookies can't be read by a web page, so a controlled
browser or an extension is required). **Iteration 1 DONE + tested** (88 tests): connector
`InteractiveLogin` capability (`loginUrl`/`isLoggedIn`/`extractCookies`, Epic impl +
driver `getCookies`/`goto`), worker `runLogin` orchestration (launch → poll-until-logged-in →
capture+store → close, with timeout/failure handling; unit-tested with fakes). Works in
local-display mode today. **Iteration 2 DONE (headless relay, code-complete + compiles/tests/next-build):** `login_session`
+ `login_input` tables (migration 0001), `login` pg-boss queue, db data-access (`login.ts`),
worker `login` handler wiring (`login.ts` builds LoginDeps: launch CloakBrowser → screenshot
frames → apply relayed clicks/keys via page.mouse/keyboard → capture cookies → store as a
session_import account), API (`POST /api/services/[id]/login-session`, `GET
/api/login-sessions/[id]`, `GET .../frame` (PNG), `POST .../input`), UI (connect page "Log in
for me" button + `/login-session/[id]` canvas that shows frames and relays clicks/keystrokes),
security notice shown. **89 tests green.** Security: `drainInputs` DELETEs input rows on read
so relayed password keystrokes don't linger in the DB; frames show the password as dots; only
encrypted session cookies are stored. **NOT yet run live** (relay needs the CloakBrowser binary
+ full stack; a successful capture also needs a real login). Cosmetic TODO: the login canvas
page title is a hardcoded placeholder ("the service").

Note: spec-kit commands in this repo are GitHub Copilot prompts under `.github/prompts/`;
the PowerShell scripts under `.specify/scripts/powershell/` do the file scaffolding.

## Feature 002 — Automatic scheduling (branch `feat/002-scheduling`)

Recurring per-account claim scheduling (spec/plan/tasks under `specs/002-scheduling/`).
`schedule` table (one per account, cascade; migration 0002), `computeNextRun`/`jitterSeconds`
in `@uc/core` (shared by web + worker), worker `runScheduler` orchestration driven by a
pg-boss cron `boss.schedule(SCHEDULER_QUEUE, "* * * * *")` — due schedules enqueue a claim via
the existing pipeline (skips accounts with an active claim; advances always so no backlog;
jittered startAfter for Principle VII). API `GET/PUT/DELETE /api/accounts/[id]/schedule`,
dashboard `ScheduleEditor` (daily/weekly + time). Connector-agnostic. **99 tests green,
`tsc -b` + web typecheck + next build clean.** Not yet run live (scheduler tick needs the
running worker + Postgres). Git: committed on the feature branch; `main` is the stable
baseline.

## Feature 003 — Twitch Prime connector + per-account config (branch `feat/003-twitch`)

Second connector, proving the plugin architecture with a targeted action (resub) and adding
**per-account connector config**. `spec`/`tasks` under `specs/003-twitch-connector/`.
- Generic config infra: `ConfigField` + `configFields` on `Connector`; `claim(input,
  fingerprint, config, ctx)` (Epic ignores config); `connected_account.config` +
  `login_session.config` jsonb (migration 0003); connect UI renders fields generically;
  connect + assisted-login validate/carry config; `missingConfigKeys` helper.
- `TwitchConnector` (Connector + InteractiveLogin, `configFields=[channel]`, claim = resub
  with Prime → claimed/nothing_to_claim/failed/reauth/human-action) + `PlaywrightTwitchDriver`
  (best-effort selectors). `defaultRegistry()` (Epic + Twitch) shared by worker + web; `twitch`
  service seeded. Docs `docs/operations/twitch.md`.
- **108 tests green, tsc -b + web typecheck + next build clean.** Not run live. DOM selectors
  best-effort (need live validation, like Epic). Branch chain: main → feat/002 → feat/003.

## Legal / TOS reminder

Automating these platforms may violate their Terms of Service and can get the operator's own
accounts suspended. This is used at the operator's own risk; the UI must surface this per
service (Principle 6). Not legal advice.

---
_Last updated: 2026-07-17. Update this file whenever a decision or the spec-kit state changes._
