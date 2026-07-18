# Phase 0 Research: Connect an Account and Run an Automated Claim

Decisions that resolve the open technical questions for this feature. Format per decision:
what was chosen, why, and what was rejected.

## 1. Job queue

- **Decision**: `pg-boss` (a job queue built on the existing PostgreSQL).
- **Rationale**: Keeps the Compose stack minimal — no extra container. Provides
  scheduling, retries with backoff, singleton/throttling (used to enforce "one claim per
  account at a time"), and archival, all in Postgres. Single-user, low-frequency workload
  never needs more.
- **Alternatives rejected**: BullMQ (requires a Redis container — conflicts with the
  minimal-YAML goal); a hand-rolled `SELECT ... FOR UPDATE SKIP LOCKED` queue (reinvents
  retries/backoff/archival that pg-boss already provides and tests).

## 2. Database access / migrations

- **Decision**: Drizzle ORM over `node-postgres`, with Drizzle Kit for SQL migrations.
- **Rationale**: Lightweight, no separate query engine binary to ship in the image
  (matters for a small self-hosted image), SQL-first, typed schema shared via the `db`
  package. Migrations are plain SQL, easy to review.
- **Alternatives rejected**: Prisma (mature DX but ships a query-engine binary and a
  heavier runtime; overkill here); raw SQL (loses type-safety across the monorepo).

## 3. Realtime status delivery

- **Decision**: Server-Sent Events (SSE) from the web app to the dashboard.
- **Rationale**: Status flow is one-directional (server → browser); SSE is simpler than
  WebSockets, auto-reconnects, and needs no extra server. Meets SC-005 (<5s) easily. The
  worker publishes job-state changes via Postgres `LISTEN/NOTIFY`, which the web app relays
  to connected SSE clients.
- **Alternatives rejected**: WebSocket (bidirectional complexity not needed; earlier docs
  said "WebSocket" loosely — SSE satisfies the same requirement and is the simpler fit);
  polling (wastes cycles, worse latency). Update the vision/AGENTS wording to "realtime
  (SSE)".

## 4. Secret encryption and password hashing

- **Decision**: Envelope encryption with AES-256-GCM using Node's built-in `crypto`. A
  master key (`APP_ENCRYPTION_KEY`, 32 bytes, base64) from the environment wraps a
  per-account random data key; the data key encrypts the account secret. Admin password and
  security-question answers are hashed with argon2id (`argon2` package).
- **Rationale**: No third-party KMS needed for a self-hosted single-user app; the master
  key living in the Compose env (outside Postgres) satisfies Principle II. GCM gives
  authenticated encryption (tamper detection). Per-account data keys limit blast radius and
  allow future key rotation. argon2id is the current best practice for password hashing.
- **Alternatives rejected**: Storing a single symmetric key and encrypting rows directly
  (no rotation path, larger blast radius); libsodium/sealed boxes (extra native dep for no
  gain here); bcrypt (weaker than argon2id for this use).
- **Key-mismatch handling**: on decrypt failure (GCM auth tag mismatch), surface a clear
  configuration error ("encryption key does not match stored data") rather than crashing
  (spec edge case).

## 5. Anti-detect browser + display

- **Decision**: CloakBrowser (free v146 binary) driven via Playwright as a drop-in, run
  **headed** inside `Xvfb` in the worker container. Per-account persistent fingerprint
  (UA, timezone, locale, viewport) and a persistent browser profile directory per account.
- **Rationale**: Constitution Principle V mandates prevention-first; CloakBrowser patches
  detection vectors at the C++ level and its own docs recommend headed mode for aggressive
  sites. Xvfb provides a virtual display on the headless NAS. The free v146 binary is
  sufficient for the MVP; Pro (latest Chromium) is a later optional upgrade.
- **Alternatives rejected**: Vanilla Playwright headless (triggers captchas per the
  reference-bot research); Firefox + manual stealth (free-games-claimer's approach — works
  but weaker and diverges from the Playwright/Chromium ecosystem); nodriver (Python — breaks
  the single-language monorepo).

## 6. Session import format

- **Decision**: Accept the Netscape `cookies.txt` format (what the common "Get cookies.txt"
  extensions export); parse it into Playwright's cookie objects in the shared connector
  helper. Also accept a pasted JSON cookie array as a convenience.
- **Rationale**: Matches the guided-export UX chosen in clarification and the reference
  bots (primelooter, twitch autosub). No in-house extension to build/maintain.
- **Alternatives rejected**: A custom browser extension (out of MVP scope, per-browser
  maintenance burden).

## 7. Captcha auto-solve integration

- **Decision**: A pluggable `CaptchaSolver` in `packages/core` with an anti-captcha.com
  implementation, invoked by the connector runtime only when a challenge is detected and a
  key is configured. On absence/failure, emit a `requires-human-action` job event.
- **Rationale**: Keeps the solver behind an interface (swappable provider), keeps cost at
  zero until a captcha actually appears, and cleanly implements the layered strategy.
- **Alternatives rejected**: Always-on solving (unnecessary cost, more detection surface);
  hard-coding one provider in each connector (violates isolation and duplication).

## 8. TOTP

- **Decision**: `otplib` to generate TOTP codes from a stored seed for the credential+TOTP
  fallback login path.
- **Rationale**: Same library the reference bots use; well-maintained; standard RFC 6238.
- **Alternatives rejected**: Hand-rolled TOTP (crypto correctness risk).

## 9. Monorepo tooling

- **Decision**: pnpm workspaces + TypeScript project references; Vitest as the shared test
  runner; Playwright Test for connector contract tests.
- **Rationale**: pnpm is fast and disk-efficient (good for CI and a NAS build); project
  references give incremental typechecking across packages.
- **Alternatives rejected**: npm/yarn workspaces (slower, less strict), Nx/Turborepo (extra
  tooling weight not justified at this size).

## 10. Concurrency model

- **Decision**: The worker processes jobs with small bounded concurrency; pg-boss singleton
  keys enforce **at most one running job per connected account**. Interrupted jobs are
  reconciled on worker startup (mark stale `running` jobs as `failed: interrupted`).
- **Rationale**: Directly implements FR-010 and FR-016 and the "no concurrent claim on the
  same account" edge case, using queue primitives rather than custom locking.
- **Alternatives rejected**: Unbounded concurrency (resource spikes on a NAS; higher
  detection risk); global serialization (needlessly slow once multiple accounts exist).

## Open items deferred (not blocking this feature)

- Proxy/IP rotation (deferred by decision; interface leaves a hook).
- CloakBrowser Pro upgrade path.
- Additional notification channels beyond a single webhook.
