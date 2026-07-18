# Universal Claimer Constitution

## Core Principles

### I. Connector Isolation
Every target platform (Epic Games, Microsoft Rewards, Twitch Prime, Amazon Prime
Gaming, ...) is implemented as a self-contained, independently versioned connector
plugin. A connector MUST expose a uniform interface (authenticate, claim, health-check,
report-status) and MUST be testable in isolation with mocked platform responses. No
connector may reach into another connector's internals or shared mutable state. Because
target platforms change their UI without notice, each connector carries its own version,
its own health-check, and a monitored failure rate; a connector whose failure rate
crosses threshold is automatically disabled and flagged, never left silently failing.

### II. Secret Custody Minimalism
The platform is a custodian of credentials that grant access to users' third-party
accounts. This is the highest-risk asset in the system and is governed accordingly:
- Secrets (session cookies, passwords, TOTP seeds) are NEVER stored in plaintext at rest
  and NEVER written to logs, error messages, screenshots, or crash dumps.
- Encryption at rest is mandatory: envelope encryption with an app key supplied via the
  compose env. Postgres never holds decryptable secrets on its own; the decryption key
  lives outside the database.
- A worker receives a decrypted secret only in memory, only for the duration of a job,
  and never persists it to disk.
- Prefer revocable, expiring session cookies over passwords. Never request a password
  when a session import suffices.
- Each deployment is single-user, so cross-user isolation (Row-Level Security) is not
  required; the isolation boundary is the deployment itself. Should a deployment ever
  become multi-user, RLS on all user/account tables becomes mandatory and must be tested.

### III. Test-First and Documentation Mandatory (NON-NEGOTIABLE)
No connector, service, or feature merges without: (a) automated tests — unit plus a
contract test against a recorded/mocked platform fixture — and (b) documentation covering
what it does, how to configure it, and its known failure modes. Tests are written before
or alongside the implementation, not after. A pull request lacking either tests or docs
does not pass review. Security-sensitive paths (encryption, RLS, secret handling) require
explicit test coverage.

### IV. English Everywhere (NON-NEGOTIABLE)
All code, identifiers, comments, specifications, plans, task lists, documentation, commit
messages, and user-facing product copy are written in English. No exceptions.

### V. Layered Anti-Detection; Captcha as Exception
The primary strategy is to avoid detection so captchas rarely appear: an anti-detect
browser (CloakBrowser, a source-patched Chromium; run headed via a virtual display on a
headless host) plus humanized behavior. This is layered:
1. Prevent — anti-detect browser avoids triggering challenges.
2. Solve automatically — when a captcha still appears, resolve it via a captcha-solving
   service (e.g. anti-captcha.com).
3. Human fallback — only as a last resort, pause the job and notify the user through a
   first-class product flow (dashboard status + push/webhook), preserving state to resume.

Full-desktop remote access (VNC / virtual desktops) is PROHIBITED for the human fallback;
relay a screenshot plus inputs through the dashboard, or hand the challenge back to the
user's own browser and re-import the session. 2FA and login anomalies follow the same
notify-and-resume model.

### VI. TOS Transparency and Consent
Automating actions on target platforms may violate their Terms of Service and may result
in suspension of the user's third-party accounts. Before a user connects any account, the
platform MUST present a clear, service-specific warning and record explicit, timestamped
consent. This consent is a precondition for enabling any automation on that service.

### VII. Identity Isolation
Each automated target account is given a coherent, persistent browser fingerprint
(user-agent, timezone, locale, viewport) and randomized run schedules to avoid
synchronized, bot-like timing. Per-account proxy isolation (residential where the platform
is sensitive) is REQUIRED before scaling to many accounts, but is DEFERRED for the
personal, self-hosted MVP: running a few of the operator's own accounts from a single
home/residential IP is acceptable and is in fact less bot-like than a datacenter IP. A
datacenter IP must never be shared across multiple target accounts.

## Security & Compliance Requirements

- This is a personal, open-source, self-hosted project. There is no monetization. The
  operator self-hosts (initially on a home NAS) and is their own custodian; the same code
  can be self-hosted by anyone.
- Each deployment is single-user. The project is distributed as a Docker Compose stack
  with a deliberately minimal YAML: it must run with `docker compose up`, carrying only
  the values required before boot (database connection, an app encryption key, port).
- All user configuration is done through a first-run web onboarding wizard (admin
  password, connected accounts, service selection + TOS consent, captcha-service key,
  schedules). Hand-editing config files is not part of the normal setup path.
- The whole stack (web app, Postgres, workers) runs from one Docker Compose deployment on
  the operator's self-managed host. It must not run on a managed PaaS that prohibits
  userbots/VNC. The host must be x86_64 (CloakBrowser ships an x86_64 Chromium binary; ARM
  NAS units are not supported). Secrets cross the trust boundary to a worker only
  just-in-time and are decrypted in memory.
- The data layer is plain Postgres bundled in the compose (no Supabase). There is no
  external auth provider: the single operator authenticates with an admin login set at
  onboarding.
- Authentication to third-party accounts follows a hybrid model, chosen per service:
  session import (user exports already-authenticated cookies; user performs their own 2FA)
  is preferred; one-shot login with a user-supplied TOTP seed is the fallback where session
  import is impractical. Note: no public OAuth "claim" scope exists for the target
  platforms, so third-party access is session custody, never OAuth.
- All destructive or irreversible operations on user data require confirmation and an
  audit trail.

## Development Workflow

- The project follows Spec-Driven Development (spec-kit): constitution -> specify ->
  clarify -> plan -> tasks -> implement, with analyze/converge as checks.
- Every change is traceable to a specification. Implementation may not introduce behavior
  that is not in an approved spec.
- Code review verifies constitution compliance, especially Principles II, III, and IV.
- Complexity must be justified against the simplest design that satisfies the spec.

## Governance

This constitution supersedes other practices. Amendments require documentation of the
change, its rationale, and a version bump. All pull requests and reviews must verify
compliance with these principles; violations block merge until resolved or explicitly
waived with recorded justification.

`AGENTS.md` at the repository root is the maintained entry point for any AI or human
contributor. It is a fast index that MUST be kept in sync: any change that alters a
principle, a key decision, the architecture, or the spec-kit state MUST update `AGENTS.md`
in the same change. `AGENTS.md` is never the source of truth — this constitution and the
specs are; if they disagree, `AGENTS.md` is wrong and must be corrected.

**Version**: 1.0.0 | **Ratified**: 2026-07-17 | **Last Amended**: 2026-07-17
