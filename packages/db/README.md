# @uc/db

Data layer: Drizzle ORM over the bundled Postgres, plus the pg-boss job queue and the
connector health accounting. Single-user schema — no tenant columns, no RLS (data-model.md).

## Contents

- **schema.ts** — tables: `admin`, `security_question`, `service`, `connected_account`,
  `consent_record`, `job`, `notification_target`, plus `connector_run` / `connector_state`
  for the health monitor. Encrypted blobs are `bytea`; secrets are sealed by `@uc/core`
  crypto before they reach here.
- **client.ts** — `createDb(databaseUrl)` → Drizzle client + pool.
- **queue.ts** — pg-boss setup, `CLAIM_QUEUE`, `claimSendOptions(accountId)` (singleton key
  = one running claim per account, FR-010), `notifyJobEvent(pool)` (LISTEN/NOTIFY relay for
  the SSE stream).
- **connector-health.ts** — `recordConnectorRun`, `connectorFailureRate`,
  `evaluateConnectorHealth` (auto-disable over threshold), `isConnectorDisabled` (Principle I).
- **seed.ts** — seeds the service catalog (Epic).
- **migrate.ts** — `runMigrations(databaseUrl)`: applies migrations + seeds. Also runnable as
  `node dist/migrate.js`.

## Commands

```bash
corepack pnpm --filter @uc/db generate   # generate SQL migrations from schema (drizzle-kit)
corepack pnpm --filter @uc/db build
corepack pnpm --filter @uc/db migrate    # apply migrations + seed (needs DATABASE_URL)
```

Integration tests that hit a real database are gated on a running Postgres and live under
the worker/app packages' integration suites.
