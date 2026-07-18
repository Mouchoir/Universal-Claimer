# Tasks: Automatic Recurring Claim Scheduling

**Tests**: mandatory (constitution). Grouped by phase; each story ships tests + docs.

## Phase 1: Data

- [X] T001 Add `schedule` table (per connected account, cascade delete) to `packages/db/src/schema.ts` + migration
- [X] T002 Data access in `packages/db/src/schedule.ts` (upsert, get, delete, listDue, markRan)
- [X] T003 Add `SCHEDULER_QUEUE` + scheduler cron helper to `packages/db/src/queue.ts`

## Phase 2: Pure logic

- [X] T004 [P] `computeNextRun(freq, hour, minute, dayOfWeek, now)` + `applyJitter` in `apps/worker/src/schedule.ts`
- [X] T005 [P] Unit tests for next-run + jitter in `apps/worker/src/schedule.test.ts`

## Phase 3: Worker scheduler

- [X] T006 `runScheduler(deps)` orchestration (list due → enqueue claim if no active job → advance) in `apps/worker/src/run-scheduler.ts`
- [X] T007 [P] Unit tests for `runScheduler` (due/skip-active/disabled/advance) in `apps/worker/src/run-scheduler.test.ts`
- [X] T008 Wire `boss.schedule(SCHEDULER_QUEUE, "* * * * *")` + handler in `apps/worker/src/index.ts`

## Phase 4: API + UI

- [X] T009 Schedule API (`GET`/`PUT`/`DELETE /api/accounts/[id]/schedule`) + zod schema
- [X] T010 [P] Schema contract test for the schedule request
- [X] T011 Dashboard schedule controls (per account: frequency/day/time + enable/disable) in `ClaimPanel.tsx`

## Phase 5: Polish

- [X] T012 Docs `docs/operations/scheduling.md`
- [X] T013 Build + typecheck + tests + gated DB integration
