# Feature Specification: Twitch Prime Resub Connector

**Feature Branch**: `003-twitch-connector`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Twitch Prime resub connector with per-account channel config"

## Overview

Add Twitch Prime as a second connector: automatically re-subscribe to a chosen channel using
the account's free Twitch Prime sub (once a month). This proves the connector architecture
handles an action type different from Epic's "claim a freebie" (a resub is a targeted DOM
action), and introduces **per-account connector configuration** — Twitch needs to know *which
channel* to resubscribe to, whereas Epic needs no config.

## Clarifications

### Session 2026-07-18

- Q: How does Twitch know which channel? → A: A per-account config field `channel`, collected
  when connecting the account. Introduces a generic per-connector config mechanism.
- Q: What counts as a successful "claim" for Twitch? → A: The Prime sub is applied to the
  channel (or was already active this cycle → `nothing_to_claim`). If Prime is unavailable
  (already used elsewhere this month) → `nothing_to_claim` with a clear summary.
- Q: Auth method? → A: Same hybrid as Epic — assisted login (preferred) or session import;
  Twitch session cookies.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect a Twitch account with a target channel (Priority: P1)

The operator connects their Twitch account and specifies the channel to resubscribe to. The
connect flow shows the channel field (declared by the connector), and it is stored with the
account.

**Why this priority**: Without the target channel there is nothing to resub to; this is the
new capability (per-account config) the connector needs.

**Acceptance Scenarios**:

1. **Given** the operator connects Twitch, **When** the connect form renders, **Then** it
   shows a required "channel" field declared by the connector.
2. **Given** the channel is provided, **When** the account is connected, **Then** the channel
   is stored as the account's config.
3. **Given** the channel is left empty, **When** the operator tries to connect, **Then** it is
   rejected (required config missing).

---

### User Story 2 - Automatically resubscribe with Prime (Priority: P1)

Running a claim for a connected Twitch account resubscribes to the configured channel using
Twitch Prime, reporting a terminal outcome (claimed / nothing-to-claim / failed / reauth).

**Why this priority**: The actual value — the recurring Prime resub.

**Acceptance Scenarios**:

1. **Given** a connected Twitch account with Prime available, **When** a claim runs, **Then**
   the connector applies the Prime sub to the channel and reports `claimed`.
2. **Given** Prime already used this cycle (or already subscribed), **When** a claim runs,
   **Then** it reports `nothing_to_claim` (not a failure).
3. **Given** the stored session is expired, **When** a claim runs, **Then** it reports
   `reauth_needed`.
4. **Given** the Twitch connector, **When** it is registered, **Then** claims, scheduling,
   and assisted login all work with no changes to the app/worker (connector-agnostic).

### Edge Cases

- Channel does not exist / typo: the run reports `failed` with a readable reason (no secret).
- A captcha appears: the layered strategy applies (auto-solve → human action), same as Epic.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support per-account connector configuration, declared by the
  connector as a list of fields; the connect flow MUST render and collect them.
- **FR-002**: A connector MUST be able to require config fields; connecting without a required
  field MUST be rejected.
- **FR-003**: The Twitch connector MUST declare a required `channel` config field.
- **FR-004**: Running a claim for Twitch MUST resubscribe to the configured channel using
  Twitch Prime and report a terminal outcome.
- **FR-005**: "Prime unavailable / already subscribed" MUST be reported as `nothing_to_claim`,
  not `failed`.
- **FR-006**: The Twitch connector MUST support the same auth (assisted login + session
  import) and be schedulable, with no app/worker changes (Principle I).
- **FR-007**: Per-account config MUST NOT contain secrets; it is stored as plain JSON
  (the channel name is not sensitive).

### Key Entities

- **Connector config** (new): a per-account JSON map (e.g. `{ channel }`), declared by the
  connector via config-field descriptors, collected at connect time, passed to `claim`.

## Success Criteria *(mandatory)*

- **SC-001**: A Twitch account can be connected with a channel and the channel is stored.
- **SC-002**: A claim for Twitch drives the resub and yields a persisted terminal outcome.
- **SC-003**: Adding Twitch requires zero changes to the scheduler, job pipeline, or SSE.
- **SC-004**: The connect UI renders the connector's config fields generically (no
  Twitch-specific UI code).

## Assumptions

- Twitch Prime is linked/available on the account (the operator manages that).
- Resub cadence is driven by the scheduling feature (monthly), not built here.

## Out of Scope

- Auto-linking Amazon Prime ↔ Twitch; gifting subs; multiple channels per account.
