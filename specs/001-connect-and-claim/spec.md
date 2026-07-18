# Feature Specification: Connect an Account and Run an Automated Claim

**Feature Branch**: `001-connect-and-claim`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "Connect a third-party account and run an automated claim end to end"

## Overview

This is the core end-to-end slice of Universal Claimer: from a fresh single-user
deployment, the operator completes first-run setup, connects one third-party account,
consents to the service's automation, and the system performs a claim on that account —
reporting success, failure, or a required human action. Epic Games (weekly free game) is
the reference service because it is low-frequency and low-risk for a single account run
from a home IP.

This spec deliberately covers only what is needed to prove the whole chain works for one
service. Additional connectors (Microsoft Rewards, Twitch Prime), scheduling refinements,
proxies, and multi-account management build on top of this slice and are specified
separately.

## Clarifications

### Session 2026-07-17

- Q: How does the user import their session for the preferred "session import" method? → A: Guided manual export — the portal explains how to export cookies with an existing browser extension (e.g. "Get cookies.txt"), and the user uploads/pastes the resulting file. No in-house extension is built for the MVP.
- Q: When a job needs human action (or fails), how is the user notified? → A: In-portal (real-time) plus one optional outbound webhook (Discord / Telegram / ntfy) configured at onboarding. (Transport chosen at plan time: SSE.)
- Q: How many accounts per service can be connected in this MVP? → A: Exactly one account per service.
- Q: What happens if the operator forgets the admin password (single-user, no email)? → A: Optional recovery via three security questions set at onboarding (the operator may decline this in the wizard, in which case they are warned that a forgotten password can only be fixed by a host-side reset command). A host-side reset command/env is always available as the ultimate fallback.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - First-run onboarding and admin setup (Priority: P1)

On first launch of a freshly deployed instance, the operator opens the web portal and is
guided through a one-time setup: they set an admin password, optionally set up password
recovery via three security questions (which they may decline), and land on an empty
dashboard. No configuration files are edited by hand.

**Why this priority**: Nothing else is reachable until the single operator can securely
access their own instance. This is the entry point of every other flow and must exist
first.

**Independent Test**: Deploy a clean instance, open the portal, complete the wizard, and
confirm that (a) the admin password is required on subsequent logins and (b) the instance
cannot be configured or operated without authenticating.

**Acceptance Scenarios**:

1. **Given** a freshly deployed instance with no admin account, **When** the operator opens
   the portal, **Then** they are presented with the first-run setup wizard and cannot reach
   the dashboard until it is completed.
2. **Given** the operator has set an admin password, **When** they open the portal in a new
   session, **Then** they must authenticate with that password before seeing any data.
3. **Given** an admin account already exists, **When** anyone opens the first-run setup
   route, **Then** setup is not offered again (no second admin can be created).
4. **Given** the operator sets up the three security questions, **When** they later forget
   the password, **Then** answering all three correctly lets them set a new password.
5. **Given** the operator declined the security questions, **When** they forget the
   password, **Then** the only recovery path is the host-side reset command, and the wizard
   warned them of this at setup time.
6. **Given** any deployment, **When** the operator (as host owner) runs the reset command,
   **Then** the admin password is reset regardless of whether security questions were set.

---

### User Story 2 - Connect a third-party account with TOS consent (Priority: P1)

The operator connects one third-party account (Epic Games) to a chosen service. Before the
connection is saved, they are shown a clear, service-specific warning that automation may
violate that service's Terms of Service and may lead to suspension of their account, and
they must explicitly consent. The connection uses the hybrid auth model: session import is
offered first; credential + TOTP login is the fallback.

**Why this priority**: A claim cannot run without a connected, consented account. Consent
is a hard precondition (Constitution Principle VI) and the credential-custody path is the
highest-risk part of the system, so it must be specified precisely.

**Independent Test**: Connect an Epic account through the portal and confirm the connection
is stored, the secret is not readable in plaintext anywhere, and a timestamped consent
record exists tied to that service.

**Acceptance Scenarios**:

1. **Given** the operator is on the "connect account" flow for a service, **When** they
   reach the confirmation step, **Then** a service-specific TOS warning is displayed and the
   connection cannot be saved until consent is explicitly given.
2. **Given** the operator gives consent, **When** the connection is saved, **Then** a
   consent record with a timestamp and the service identifier is persisted.
3. **Given** the operator chooses session import, **When** the portal shows guided
   instructions to export cookies with an existing browser extension and the operator
   uploads/pastes the resulting cookies file, **Then** the session is stored encrypted and
   the account shows as "connected" without the operator ever entering a password into the
   platform.
4. **Given** session import is impractical for the service, **When** the operator uses the
   credential + TOTP fallback, **Then** credentials and TOTP seed are stored encrypted and
   never written to logs, screenshots, or error output.
5. **Given** a connected account, **When** the operator views it in the portal, **Then** no
   stored secret is ever displayed back in plaintext.

---

### User Story 3 - Run a claim on demand and see the result (Priority: P1)

With a connected, consented account, the operator triggers a claim manually from the
dashboard. The system runs the claim in an anti-detect browser and reports one of three
outcomes in near real time: success (with what was claimed, if anything was available),
nothing-to-claim, or failure (with a reason).

**Why this priority**: This is the actual value of the product. Stories 1 and 2 exist to
enable it. Running on demand (before scheduling) is the smallest testable form of the core
capability.

**Independent Test**: With a connected Epic account, click "Run claim" and confirm the
dashboard shows a live status progressing to a terminal outcome, and that the outcome is
persisted in job history.

**Acceptance Scenarios**:

1. **Given** a connected, consented Epic account, **When** the operator triggers a claim,
   **Then** the dashboard shows the job status updating in near real time (queued → running
   → finished).
2. **Given** a free game is available, **When** the claim runs successfully, **Then** the
   result records that the game was claimed and the job is marked succeeded.
3. **Given** no free game is currently available, **When** the claim runs, **Then** the
   result is "nothing to claim" and the job is marked succeeded (not failed).
4. **Given** the claim fails for a platform reason (e.g. UI changed, network error),
   **When** the run ends, **Then** the job is marked failed with a human-readable reason and
   no secret appears in the stored error.

---

### User Story 4 - Handle a captcha or required human action (Priority: P2)

If the claim run hits a captcha that the anti-detect browser did not prevent, the system
first attempts automatic resolution via the configured captcha-solving service. If that is
unavailable or fails, the job pauses and the operator is notified — in the portal in real
time and, if an outbound webhook was configured at onboarding, on that channel (Discord /
Telegram / ntfy) — that manual action is required, with enough context to resolve it and
resume, without any remote-desktop/VNC session.

**Why this priority**: Captchas are expected but not on every run. The layered strategy
(Constitution Principle V) must be represented, but the on-demand happy path (Story 3) can
be demonstrated before this is complete.

**Independent Test**: Force a captcha condition and confirm the job attempts auto-solve,
and on auto-solve failure transitions to a "human action required" state with a
notification, and can be resumed after the operator acts.

**Acceptance Scenarios**:

1. **Given** a captcha appears during a run and a captcha-solving key is configured,
   **When** the run reaches the captcha, **Then** the system attempts automatic resolution
   before failing.
2. **Given** automatic resolution is unavailable or fails, **When** the run cannot proceed,
   **Then** the job enters a "human action required" state and the operator is notified in
   the portal and on the configured webhook (if any).
3. **Given** a job is waiting on human action, **When** the operator resolves the challenge
   and signals completion, **Then** the job resumes rather than restarting from scratch.
4. **Given** any human-action flow, **When** it is presented, **Then** it never uses VNC or
   a remote desktop; it relays a screenshot + inputs through the portal or hands the
   challenge back to the operator's own browser.

---

### Edge Cases

- What happens when a stored session/cookie has expired at claim time? The job must fail
  with a clear "re-authentication needed" outcome and prompt the operator to reconnect,
  not silently retry forever.
- What happens if the operator triggers a claim while one is already running for the same
  account? The system must not run two concurrent claims on the same account.
- What happens if the instance restarts mid-run? On restart, an interrupted job must be
  visible as interrupted/failed, never stuck as permanently "running".
- What happens if the encryption key provided at boot does not match the one used to
  encrypt stored secrets? The system must refuse to use unreadable secrets and surface a
  clear configuration error rather than crashing opaquely.
- What happens if the operator never configures a captcha-solving key and a captcha
  appears? The job goes straight to "human action required".
- What happens if a webhook is configured but delivery fails (channel down, bad URL)? The
  in-portal notification is still authoritative; webhook delivery failures are logged and
  do not block or fail the job.
- What happens if the operator tries to connect a second account for a service that already
  has one? The system rejects it (one account per service in this MVP) with a clear message.
- What happens if the operator forgets the password and declined security questions? The
  only path is the host-side reset command; the UI must make this explicit rather than
  implying an in-app recovery exists.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST present a one-time first-run setup wizard when no admin
  account exists, and MUST require the operator to set an admin password before the
  dashboard is reachable. The wizard MUST also let the operator optionally configure the
  outbound notification webhook and password-recovery security questions.
- **FR-002**: The system MUST require authentication with the admin password for all portal
  access after setup, and MUST prevent creation of a second admin account.
- **FR-002a**: The first-run wizard MUST offer optional password recovery via three
  security questions, which the operator MAY decline; if declined, the wizard MUST warn
  that a forgotten password can then only be reset via the host-side command. When set,
  security-question answers MUST be stored hashed (never in plaintext) and all three MUST
  be answered correctly to reset the password.
- **FR-002b**: The system MUST provide a host-side command (or reset env flag) that resets
  the admin password, available regardless of whether security questions were configured.
- **FR-003**: The system MUST allow the operator to connect a third-party account for a
  supported service entirely through the web portal, with no manual file editing.
- **FR-004**: The system MUST display a clear, service-specific warning that automation may
  violate the service's Terms of Service, and MUST require explicit consent before saving a
  connection.
- **FR-005**: The system MUST persist a timestamped consent record, tied to the service,
  whenever consent is given; automation for a service MUST NOT run without a recorded
  consent for it.
- **FR-006**: The system MUST support two account-connection methods, selectable per
  service: session import (preferred) and credential + TOTP login (fallback). For session
  import, the portal MUST show guided instructions for exporting cookies via an existing
  browser extension and accept the exported cookies file (upload or paste); no in-house
  browser extension is built for this feature.
- **FR-006a**: The system MUST allow at most one connected account per service; attempting
  to connect a second account for a service that already has one MUST be rejected with a
  clear message.
- **FR-007**: The system MUST store all third-party secrets (session cookies, passwords,
  TOTP seeds) encrypted at rest, using an app encryption key supplied via the deployment
  environment and held outside the database.
- **FR-008**: The system MUST NEVER write secrets in plaintext to logs, error messages,
  screenshots, or crash output, and MUST NEVER display a stored secret back to the operator.
- **FR-009**: The system MUST let the operator trigger a claim on demand for a connected,
  consented account.
- **FR-010**: The system MUST execute claims using an anti-detect browser and MUST NOT run
  two concurrent claims for the same account.
- **FR-011**: The system MUST report each claim as exactly one terminal outcome — succeeded
  (including "nothing to claim"), failed (with a human-readable reason), or requires human
  action — and MUST persist it in a job history.
- **FR-012**: The system MUST push claim status to the dashboard in near real time.
- **FR-013**: On encountering a captcha, the system MUST first attempt automatic resolution
  via a configured captcha-solving service when one is configured; on failure or absence of
  a key, it MUST transition the job to "requires human action" and notify the operator.
- **FR-014**: Any human-action flow MUST NOT use VNC or a remote desktop; it MUST relay a
  screenshot plus inputs through the portal, or hand the challenge back to the operator's
  own browser.
- **FR-014a**: The system MUST notify the operator in the portal for every "requires human
  action" and "failed" outcome, and MUST additionally deliver the notification to one
  optional outbound webhook (Discord / Telegram / ntfy) when configured at onboarding.
  Webhook delivery failures MUST be logged and MUST NOT fail or block the job; the in-portal
  notification remains authoritative.
- **FR-015**: The system MUST detect an expired/invalid stored session at claim time and
  produce a "re-authentication needed" outcome that prompts reconnection.
- **FR-016**: On startup, the system MUST reconcile any job left in a non-terminal state by
  an unexpected shutdown so that no job remains permanently "running".
- **FR-017**: The Epic Games connector MUST be the reference implementation delivered with
  this feature; the connection, consent, run, and outcome flows MUST be connector-agnostic
  so additional connectors can be added without changing them.

### Key Entities *(include if feature involves data)*

- **Admin**: The single operator of the deployment. Holds the credential used to access the
  portal. Exactly one per deployment. Optionally holds three hashed security-question
  answers for password recovery.
- **Connected Account**: A third-party account linked to a specific service, with an
  encrypted secret (imported session or credentials + TOTP seed), a connection method, and
  a status (connected, needs re-auth). At most one per service.
- **Service**: A supported target platform (Epic Games in this feature), defining the
  connector used, the TOS warning text, and the connection methods available.
- **Consent Record**: A timestamped record that the operator accepted the TOS warning for a
  given service. Precondition for automation on that service.
- **Job**: A single claim attempt for a connected account. Has a lifecycle state (queued,
  running, requires-human-action, succeeded, failed) and a terminal outcome with a
  human-readable summary. No secret is ever stored in a job.
- **Notification Target**: An optional outbound webhook (Discord / Telegram / ntfy) set at
  onboarding, used in addition to the in-portal notifications. At most one per deployment
  in this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From a freshly deployed instance, the operator can complete first-run setup
  and reach the dashboard in under 3 minutes without editing any file.
- **SC-002**: The operator can connect an Epic account and record consent in under 2
  minutes, and 100% of connections have a matching timestamped consent record.
- **SC-003**: For a connected, consented account, triggering a claim produces a persisted
  terminal outcome in 100% of runs (no run ends with no recorded outcome).
- **SC-004**: In an inspection of the database, logs, error output, and job history, zero
  third-party secrets appear in plaintext.
- **SC-005**: When a claim is triggered, the dashboard reflects a status change within 5
  seconds and reaches a terminal state without requiring a manual page refresh.
- **SC-006**: A second connector can be added later without modifying the connect, consent,
  run, or outcome flows (verified by the connector-agnostic interface having no
  Epic-specific branches).

## Assumptions

- Each deployment serves a single operator; there is no multi-user access and therefore no
  cross-user isolation requirement.
- The deployment host is x86_64 and can run the anti-detect browser headed via a virtual
  display; ARM hosts are out of scope.
- The operator runs from a home/residential IP; no proxy is configured in this feature.
- An app encryption key is provided via the deployment environment before first boot.
- The captcha-solving service (if used) is a third-party API configured by the operator; it
  is optional, and its absence degrades gracefully to the human-action flow.
- Network access to the target service (Epic Games) is available from the host.

## Dependencies

- A running database (bundled Postgres) reachable by the app at boot.
- The anti-detect browser (CloakBrowser) available to the worker, runnable headed via a
  virtual display.
- Optional: a captcha-solving service API key, configured through the portal.

## Out of Scope (for this feature)

- Microsoft Rewards and Twitch Prime connectors (added later, on this slice's foundation).
- Automated scheduling of claims (this feature is on-demand only).
- Per-account proxy / IP rotation.
- Multi-account management and bulk operations.
- Any action other than claiming (no purchases, transfers, or subscriptions beyond a
  Prime-style resub handled by a later connector).
