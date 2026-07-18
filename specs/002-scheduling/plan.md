# Implementation Plan: Automatic Recurring Claim Scheduling

**Branch**: `002-scheduling` | **Date**: 2026-07-18 | **Spec**: [spec.md](spec.md)

## Summary

Add a per-account `schedule` (daily/weekly preset + time), a pure next-run computation with
jitter, a worker scheduler tick (driven by a pg-boss cron every minute) that enqueues claims
for due accounts via the existing claim pipeline, and dashboard controls to set/disable it.
Connector-agnostic; reuses the one-claim-per-account guard.

## Technical Context

Same stack as feature 001. New pieces:
- `packages/db`: `schedule` table + migration; data access; a `SCHEDULER_QUEUE` cron.
- `packages/core` (or worker): pure `computeNextRun` + `applyJitter` (unit-tested).
- `apps/worker`: `runScheduler` orchestration (injectable deps, unit-tested) + wiring on a
  `boss.schedule(SCHEDULER_QUEUE, "* * * * *")` tick.
- `apps/web`: schedule API + dashboard controls.

Timezone: deployment-local (compute with the host's local time). Minute granularity.

## Constitution Check

- I. Connector isolation — scheduler is connector-agnostic (enqueues the generic claim job). ✓
- III. Tests + docs — pure next-run + scheduler orchestration unit-tested; docs added. ✓
- VII. Identity isolation — jitter on run times to avoid synchronized timing. ✓
- No new secrets; no browser in the web app. PASS.

## Project Structure (new/changed)

```
packages/db/src/schema.ts        # + schedule table
packages/db/src/schedule.ts      # data access (upsert/get/delete/listDue/markRan)
packages/db/src/queue.ts         # + SCHEDULER_QUEUE
packages/worker/src/schedule.ts  # computeNextRun + applyJitter (pure)
apps/worker/src/run-scheduler.ts # runScheduler orchestration
apps/worker/src/index.ts         # wire boss.schedule tick + handler
apps/web/src/app/api/accounts/[id]/schedule/route.ts   # GET/PUT/DELETE
apps/web/src/app/dashboard/ClaimPanel.tsx              # schedule controls
docs/operations/scheduling.md
```

## Phases

- Phase 1: data (schema + migration + data access + queue).
- Phase 2: pure logic (`computeNextRun` + jitter) + tests.
- Phase 3: worker scheduler (orchestration + wiring) + tests.
- Phase 4: API + UI.
- Phase 5: docs + verification.
