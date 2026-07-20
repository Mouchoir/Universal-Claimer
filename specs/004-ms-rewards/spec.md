# Feature Specification: Microsoft Rewards Daily Tasks Connector

**Feature Branch**: `004-ms-rewards`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Microsoft Rewards daily tasks connector"

## Overview

Add Microsoft Rewards as the third headline connector (completing the Epic + Twitch + MS
Rewards vision). A claim performs the account's **daily point-earning tasks** — primarily a
batch of Bing searches with humanized delays and credible queries — and reports how many
points/tasks were completed. It reuses everything already built (assisted login, scheduling,
job pipeline, health monitor); it is a drop-in connector (Principle I).

## Clarifications

### Session 2026-07-18

- Q: What is a "claim" for MS Rewards? → A: Run today's available tasks (Bing searches,
  desktop set) once. Already-complete → `nothing_to_claim`. Some done → `claimed` with a
  count summary.
- Q: Humanized behavior? → A: Randomized delays between searches and credible query terms
  (from a built-in term source), per Constitution Principle VII. Number of searches is
  bounded by the daily allowance.
- Q: Config? → A: No required per-account config (unlike Twitch). An optional `searchCount`
  override MAY be offered later; not required for this feature.
- Q: Auth? → A: Same hybrid — assisted login (preferred) or session import; Microsoft session.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect a Microsoft account (Priority: P1)

The operator connects their Microsoft account (assisted login or session import); no extra
config required.

**Acceptance Scenarios**:

1. **Given** the operator connects Microsoft, **When** the connect form renders, **Then** it
   requires no extra config field (empty `configFields`).
2. **Given** a valid Microsoft session, **When** connected, **Then** the account is stored and
   shows `connected`.

---

### User Story 2 - Run daily Rewards tasks (Priority: P1)

Running a claim performs today's outstanding Rewards tasks (Bing searches with humanized
timing) and reports a terminal outcome with how much was completed.

**Acceptance Scenarios**:

1. **Given** outstanding daily searches, **When** a claim runs, **Then** the connector performs
   them (humanized delays + varied queries) and reports `claimed` with a count (e.g.
   "Completed 30 searches").
2. **Given** the day's tasks are already complete, **When** a claim runs, **Then** it reports
   `nothing_to_claim`.
3. **Given** the stored session is expired, **When** a claim runs, **Then** it reports
   `reauth_needed`.
4. **Given** the MS Rewards connector, **When** it is registered, **Then** claims, scheduling
   (daily), and assisted login work with no app/worker changes.

### Edge Cases

- A captcha / verification appears mid-run: layered strategy (auto-solve → human action).
- Partial completion (some searches done, then an error): report `claimed` with the count
  actually completed, not `failed`, so progress is not lost.
- The Rewards dashboard shape changed (breakage): report `failed` with a readable reason;
  the health monitor auto-disables on repeated failures.

## Requirements *(mandatory)*

- **FR-001**: The connector MUST run the account's outstanding daily Rewards search tasks on a
  claim, with humanized delays and varied, credible queries (Principle VII).
- **FR-002**: "Nothing outstanding today" MUST be `nothing_to_claim`; partial completion MUST
  be `claimed` with a count; expired session MUST be `reauth_needed`.
- **FR-003**: The connector MUST require no per-account config (`configFields` empty).
- **FR-004**: The connector MUST support assisted login + session import and be schedulable,
  with no app/worker changes (Principle I).
- **FR-005**: The number of searches MUST be bounded by a configurable daily cap (default) to
  avoid runaway behavior.
- **FR-006**: Query terms and inter-search delays MUST vary per run (no fixed sequence).

## Success Criteria *(mandatory)*

- **SC-001**: A Microsoft account connects with no extra config.
- **SC-002**: A claim performs outstanding searches and yields a persisted terminal outcome
  with a count summary.
- **SC-003**: Adding MS Rewards requires zero changes to scheduler / pipeline / SSE / UI.

## Assumptions

- Points balance/verification is read from the Rewards dashboard; exact selectors are
  best-effort and validated live.
- Mobile-search and daily-set/quiz tasks are out of scope for v1 (desktop searches only).

## Out of Scope

- Mobile user-agent search set, daily set / quizzes / punch cards, multi-account clustering.
