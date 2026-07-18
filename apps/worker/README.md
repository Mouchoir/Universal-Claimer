# @uc/worker

The automation worker: pulls claim jobs from pg-boss and runs them through connectors in
CloakBrowser (headed via Xvfb). Runs outside the web app, on the self-hosted host.

## Contents

- **state.ts** — the pure job state machine (`queued → running → …`), transition rules, and
  `outcomeToState` (note: `nothing_to_claim` is a success). Unit-tested.
- **reconcile.ts** — `reconcileInterruptedJobs`: on startup, marks any non-terminal job left
  by a crash as `failed: interrupted` (FR-016).
- **index.ts** — bootstrap: DB + queue, startup reconciliation, then `boss.work(CLAIM_QUEUE)`.
  Connectors are resolved from the `ConnectorRegistry` (Principle I). Claim execution itself
  is wired in US3 (T038).

## Run

```bash
corepack pnpm --filter @uc/worker build
NODE_ENV=production node apps/worker/dist/index.js   # needs DATABASE_URL + a running Postgres
```

The browser is driven via the official `cloakbrowser` package (`@uc/connectors/browser`),
which auto-manages the Chromium binary — pre-downloaded into the Docker image at build, or
downloaded on first launch (~535MB, cached under `CLOAKBROWSER_CACHE_DIR`). Needs Xvfb + an
x86_64 host. Optional `CLOAKBROWSER_LICENSE_KEY` for Pro. See `deploy/Dockerfile.worker`.
