# Feature Specification: Automatic Recurring Claim Scheduling

**Feature Branch**: `002-scheduling`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Automatic recurring claim scheduling per account"

## Overview

Today claims run only on demand (the operator clicks "Run claim"). This feature makes the
platform actually automatic: the operator sets a recurring schedule per connected account
(e.g. Epic weekly, Microsoft Rewards daily) and the worker enqueues claims automatically at
the scheduled times — with small random jitter to avoid synchronized, bot-like timing
(Constitution Principle VII). It is connector-agnostic (works for every current and future
connector).

## Clarifications

### Session 2026-07-18

- Q: Cron expressions or simple presets? → A: Presets — `daily` (at a chosen time) and
  `weekly` (chosen day + time). Covers the real cadences (Epic weekly, MS Rewards daily) and
  is far friendlier than cron strings.
- Q: Timezone? → A: The deployment's local timezone (single-user, self-hosted).
- Q: What if a scheduled run fires while a claim is already running for that account? → A:
  Skip that occurrence (the existing one-claim-per-account guard applies); do not queue a
  second.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Set a recurring schedule for an account (Priority: P1)

The operator opens a connected account and sets it to claim automatically on a recurring
schedule (daily at a time, or weekly on a day + time), or turns scheduling off.

**Why this priority**: This is the feature's core — without it there is nothing to automate.

**Independent Test**: Set a daily schedule on an account, confirm it is stored with a
computed next-run time; disable it and confirm no next run.

**Acceptance Scenarios**:

1. **Given** a connected account, **When** the operator enables a daily schedule at 09:00,
   **Then** the schedule is saved and a `nextRunAt` is computed for the next 09:00.
2. **Given** a connected account, **When** the operator enables a weekly schedule (e.g. Monday
   10:00), **Then** `nextRunAt` is the next Monday 10:00.
3. **Given** a scheduled account, **When** the operator disables scheduling, **Then** no
   further automatic runs occur.
4. **Given** an account with no connected account, **When** scheduling is attempted, **Then**
   it is rejected (nothing to schedule).

---

### User Story 2 - Automatic runs at the scheduled time (Priority: P1)

When a schedule is due, the worker automatically enqueues a claim for that account, exactly as
if the operator had clicked "Run claim", and advances the schedule to the next occurrence.

**Why this priority**: The automation itself. Story 1 is configuration; this is the payoff.

**Independent Test**: With a schedule whose `nextRunAt` is in the past, run the scheduler tick
and confirm a claim job is enqueued for that account and `nextRunAt` advances.

**Acceptance Scenarios**:

1. **Given** an enabled schedule due now, **When** the scheduler tick runs, **Then** a claim
   job is enqueued for the account and `lastRunAt`/`nextRunAt` are updated.
2. **Given** a schedule due now but a claim already running for that account, **When** the tick
   runs, **Then** no second claim is enqueued (the occurrence is skipped).
3. **Given** a disabled schedule, **When** the tick runs, **Then** nothing is enqueued.
4. **Given** several due schedules, **When** the tick runs, **Then** each due account gets one
   claim, at slightly jittered times to avoid synchronized runs.

---

### Edge Cases

- A schedule whose account is later disconnected: the schedule is removed with the account
  (cascade); the tick ignores it.
- The worker is offline when a run was due: on the next tick after startup, the overdue
  schedule fires once (not once per missed occurrence), then advances to the next future slot.
- Two ticks overlapping: advancing `nextRunAt` before enqueuing (or a due-window check)
  prevents double-enqueue.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The operator MUST be able to set, per connected account, a recurring schedule of
  `daily` (time) or `weekly` (day-of-week + time), or disable scheduling.
- **FR-002**: The system MUST compute and store the next run time from the schedule, in the
  deployment's local timezone.
- **FR-003**: At most one schedule exists per connected account.
- **FR-004**: A worker scheduler MUST periodically detect due schedules and enqueue a claim for
  each, then advance the schedule to its next occurrence.
- **FR-005**: The scheduler MUST NOT enqueue a claim for an account that already has an active
  (queued/running/awaiting-human) claim — that occurrence is skipped.
- **FR-006**: Automatic run times MUST carry a small random jitter so multiple accounts do not
  all run at the exact same instant (Principle VII).
- **FR-007**: An overdue schedule (worker was offline) MUST fire at most once on recovery, then
  advance to the next future occurrence — no backlog of missed runs.
- **FR-008**: Scheduling MUST be connector-agnostic — no connector-specific code in the
  scheduler.
- **FR-009**: Disconnecting an account MUST remove its schedule.

### Key Entities

- **Schedule**: Belongs to one connected account. Fields: frequency (daily|weekly), time
  (hour, minute), day-of-week (for weekly), enabled, next-run-at, last-run-at.

## Success Criteria *(mandatory)*

- **SC-001**: An enabled schedule results in an automatic claim within 1 minute of its due
  time (scheduler tick granularity).
- **SC-002**: 100% of automatic runs respect the one-claim-per-account guard (no duplicate
  concurrent claims from scheduling).
- **SC-003**: Setting or changing a schedule takes effect without restarting the worker.
- **SC-004**: A new connector requires zero scheduler changes to be schedulable.

## Assumptions

- Single-user, self-hosted; the deployment's local timezone is authoritative.
- Minute-level granularity is sufficient (no second-level precision needed).
- Presets (daily/weekly) are enough; arbitrary cron is out of scope for this feature.

## Out of Scope

- Arbitrary cron expressions; multiple schedules per account; per-run notifications beyond the
  existing claim outcome flow.
