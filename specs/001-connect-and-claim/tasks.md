# Tasks: Connect an Account and Run an Automated Claim

**Input**: Design documents from `/specs/001-connect-and-claim/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: INCLUDED — the constitution (Principle III) makes tests + docs mandatory, so test
tasks are part of every user story and docs tasks are part of scope.

**Organization**: Tasks are grouped by user story so each is independently implementable and
testable. MVP = the three P1 stories (US1 + US2 + US3); US4 (P2) builds on top.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete tasks)
- **[Story]**: US1/US2/US3/US4 (user-story phases only)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Monorepo skeleton and shared tooling.

- [X] T001 Create pnpm monorepo structure (`apps/web`, `apps/worker`, `packages/core`, `packages/db`, `packages/connectors`, `deploy/`) per plan.md (`packages/notifications` added in US4)
- [X] T002 [P] Configure root TypeScript (project references), ESLint + Prettier at repo root
- [X] T003 [P] Configure Vitest at repo root with per-package test projects
- [X] T004 [P] Configure Playwright Test harness for connector contract tests in `packages/connectors/` (vitest harness + playwright-core for browser fixtures)
- [X] T005 [P] Add root README + CONTRIBUTING pointing to `AGENTS.md`, constitution, and specs

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T006 Implement env/config validation (Zod) incl. `APP_ENCRYPTION_KEY`, `DATABASE_URL`, `PORT` in `packages/core/src/config.ts`
- [X] T007 [P] Implement AES-256-GCM envelope encryption (master key → per-record data key) + unit tests in `packages/core/src/crypto.ts`
- [X] T008 [P] Implement redacting structured logger (forbids secret fields) + unit tests in `packages/core/src/logger.ts`
- [X] T009 [P] Define `CaptchaSolver` interface + anti-captcha.com implementation (stub-injectable) in `packages/core/src/captcha.ts`
- [X] T010 Define Drizzle schema for all entities (admin, security_question, service, connected_account, consent_record, job, notification_target) in `packages/db/src/schema.ts` per data-model.md
- [X] T011 Create migrations + seed the `service` catalog (Epic) in `packages/db/migrations/` and `packages/db/src/seed.ts`
- [X] T012 [P] Set up pg-boss (job queue) + Postgres `LISTEN/NOTIFY` helpers for job events in `packages/db/src/queue.ts`
- [X] T012a [P] Add connector run-outcome + failure-rate accounting (table + accessor) that feeds the health monitor (Principle I; consumed by T052) in `packages/db/src/connector-health.ts`
- [X] T013 Implement the `Connector` interface + runtime `ConnectorContext` (CloakBrowser-under-Xvfb browser factory, `cookies.txt`/JSON parser, TOTP via otplib) in `packages/connectors/src/connector.ts` per contracts/connector-interface.md
- [X] T014 Implement worker skeleton: pull jobs from pg-boss, job state machine, per-account singleton, startup reconciliation of interrupted jobs (FR-016) in `apps/worker/src/index.ts`
- [X] T015 Implement Next.js app skeleton + admin session auth (signed HttpOnly cookie) + argon2 hashing in `apps/web/src/server/session.ts` + `auth.ts`
- [X] T016 Establish the portal design-system baseline — theme-aware tokens (color, typography, spacing) in `apps/web/src/app/globals.css` (impeccable/taste-skill refinement passes deferred to Polish T049–T050)
- [X] T017 Author `deploy/Dockerfile.web`, `deploy/Dockerfile.worker` (CloakBrowser + Xvfb), minimal `deploy/docker-compose.yml` (web, worker, postgres) and `deploy/.env.example`

**Checkpoint**: Foundation ready — user stories can begin.

---

## Phase 3: User Story 1 — First-run onboarding & admin setup (P1) 🎯 MVP

**Goal**: From a clean deployment, the operator sets up the single admin (with optional
recovery + webhook) and can authenticate; no config files edited by hand.

**Independent Test**: Deploy clean, complete the wizard, confirm login is required after and
no second admin can be created.

### Tests

- [X] T018 [P] [US1] Integration test: setup → login → reject second setup + recovery, in `apps/web/tests/onboarding.integration.test.ts` (gated on `DATABASE_URL_TEST`; runs against a real Postgres)
- [X] T019 [P] [US1] Unit test: admin singleton, argon2id password + security-answer hashing, 3-answer recovery in `apps/web/src/server/admin-service.test.ts` (8 tests, fake in-memory store)

### Implementation

- [X] T020 [P] [US1] Data access for `admin` + `security_question` (singleton enforcement) in `packages/db/src/admin.ts`
- [X] T020a [P] [US1] Data access for `notification_target` (store/read the encrypted webhook config set at onboarding; consumed by T044) in `packages/db/src/notification-target.ts`
- [X] T021 [US1] Setup API (`GET /api/setup/state`, `POST /api/setup`) in `apps/web/src/app/api/setup/`
- [X] T022 [US1] Auth API (`login`, `logout`, `recover`) in `apps/web/src/app/api/auth/`
- [X] T023 [US1] Host-side `reset-admin` CLI (works regardless of recovery, FR-002b) in `apps/web/src/cli/reset-admin.ts`
- [X] T024 [US1] Onboarding wizard UI (password; optional 3 security questions with decline + warning; optional webhook) in `apps/web/src/app/setup/` + `login/` + `recover/`
- [X] T025 [US1] Docs: onboarding + password reset in `docs/operations/onboarding.md`

**Checkpoint**: Operator can set up and authenticate to their instance.

---

## Phase 4: User Story 2 — Connect an account with TOS consent (P1)

**Goal**: Connect one Epic account (guided cookies import or credential+TOTP) behind a
blocking TOS consent; secrets stored encrypted, never echoed.

**Independent Test**: Connect Epic, verify a timestamped consent row exists, one-account-per-
service is enforced, and no plaintext secret exists anywhere.

### Tests

- [X] T026 [P] [US2] Contract test: Epic `authenticate()` against valid + expired session fixtures in `packages/connectors/tests/epic.auth.test.ts` (5 tests, fake driver)
- [X] T027 [P] [US2] Integration test: consent-gated connect, one-account-per-service, no-plaintext-secret assertion in `apps/web/tests/connect.integration.test.ts` (gated on `DATABASE_URL_TEST`)
- [X] T027a [P] [US2] Contract test: services/accounts/consent API request schemas in `apps/web/src/server/schemas.test.ts`
- [X] T028 [P] [US2] Data access for `connected_account` + `consent_record` (unique service_id) in `packages/db/src/accounts.ts`
- [X] T029 [P] [US2] Epic connector `authenticate()` incl. `cookies.txt`/JSON import and credential+TOTP path in `packages/connectors/src/epic/`
- [X] T030 [US2] Services API (`GET /api/services`, `GET /api/services/{id}/tos`, `POST /api/services/{id}/consent`) in `apps/web/src/app/api/services/`
- [X] T031 [US2] Accounts API (`POST`/`GET`/`DELETE`, encrypt on store via core crypto, never echo secrets) in `apps/web/src/app/api/accounts/`
- [X] T032 [US2] Connect UI: TOS-warning gate, method selection, guided cookies-export instructions in `apps/web/src/app/connect/[id]/`
- [X] T033 [US2] Docs: connecting an account + guided cookies export in `docs/operations/connecting-accounts.md`

**Checkpoint**: An Epic account can be connected and consented; secrets safe.

---

## Phase 5: User Story 3 — Run a claim on demand & see the result (P1)

**Goal**: Trigger a claim; the worker runs CloakBrowser via the Epic connector; the
dashboard shows a live status to a persisted terminal outcome.

**Independent Test**: With a connected account, Run claim → live status → persisted outcome;
second concurrent run returns `409`.

### Tests

- [X] T034 [P] [US3] Contract test: Epic `claim()` against available / nothing / expired / captcha fixtures in `packages/connectors/tests/epic.claim.test.ts` (6 tests)
- [X] T035 [P] [US3] Integration test: enqueue → run → terminal outcome (orchestration unit test `apps/worker/src/run-claim.test.ts`, 5 tests) + concurrency/reconcile DB integration `apps/web/tests/claim.integration.test.ts` (gated)
- [X] T035a [P] [US3] Contract test: jobs + SSE event payload schemas in `apps/web/tests/api-contract.jobs-sse.test.ts`
- [X] T036 [P] [US3] Data access for `job` + state transitions in `packages/db/src/jobs.ts`
- [X] T037 [US3] Claim enqueue API (`POST /api/accounts/{id}/claim`) with consent + concurrency guards in `apps/web/src/app/api/accounts/[id]/claim/`
- [X] T038 [US3] Worker claim execution: launch CloakBrowser, run `connector.claim`, persist outcome, `reauth_needed` handling in `apps/worker/src/run-claim.ts` + `index.ts`
- [X] T039 [US3] SSE endpoint (`GET /api/events`) relaying Postgres `NOTIFY` + jobs API (`GET /api/jobs`, `GET /api/jobs/{id}`) in `apps/web/src/app/api/events/` and `apps/web/src/app/api/jobs/`
- [X] T040 [US3] Dashboard UI: account list, Run claim, live job status via SSE in `apps/web/src/app/dashboard/`
- [X] T041 [US3] Docs: running a claim + outcomes in `docs/operations/running-claims.md`

**Checkpoint**: Core value delivered — MVP complete (US1 + US2 + US3).

---

## Phase 6: User Story 4 — Captcha / required human action (P2)

**Goal**: Layered captcha handling (prevent → auto-solve → human fallback, no VNC) with
in-portal + optional webhook notification, and resumable jobs.

**Independent Test**: Force a captcha fixture → auto-solve attempt → `requires_human_action`
→ resolve in portal → job resumes (not restarts); webhook failure never fails the job.

### Tests

- [X] T042 [P] [US4] Contract test: captcha fixture → auto-solve attempt → `requires_human_action` with stub solver (covered by the two captcha cases in `packages/connectors/tests/epic.claim.test.ts`)
- [X] T043 [P] [US4] Integration test: human-action pause (unit in `apps/worker/src/run-claim.test.ts`) → resume (gated DB test in `apps/web/tests/claim.integration.test.ts`) + best-effort webhook (unit in `packages/notifications/src/index.test.ts`)
- [X] T044 [P] [US4] Notifications package: outbound webhook delivery (Discord/Telegram/ntfy), best-effort, failures logged only in `packages/notifications/src/`
- [X] T045 [US4] Worker: unsolved captcha → `requires_human_action` (non-terminal pause), notify (SSE + webhook); handled in `apps/worker/src/run-claim.ts` + `index.ts` (screenshot relay deferred; MVP uses hand-back per FR-014)
- [X] T046 [US4] Human-action API (`POST /api/jobs/{id}/human-action`) + resume logic in `apps/web/src/app/api/jobs/[id]/human-action/`
- [X] T047 [US4] Human-action UI: resume control + "solve in your own browser" guidance (no VNC) in `apps/web/src/app/dashboard/ClaimPanel.tsx`
- [X] T048 [US4] Docs: layered captcha strategy + human-action flow in `docs/operations/captcha-and-human-action.md`

**Checkpoint**: All user stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Design quality, project-wide hardening, docs, validation.

- [X] T049 [P] Design hardening pass across onboarding, dashboard, connect, and human-action screens — accessible focus states, consistent button/input styling, hover/disabled states in `apps/web/src/app/globals.css` (impeccable/taste-skill CLIs unavailable in this environment; their principles applied manually)
- [X] T050 [P] Design refinement (layout, typography, spacing, responsive) across the portal in `apps/web/src/app/globals.css`
- [ ] T051 [P] (Optional) Build an open-source project landing page with **scroll-world** — SKIPPED (optional; requires the scroll-world toolchain / external asset generation not available here)
- [X] T052 [P] Connector health monitor: failure-rate accounting + auto-disable over threshold (`packages/db/src/connector-health.ts`, wired in `apps/worker`), enqueue blocked with `503` and shown on the dashboard when disabled (Principle I)
- [X] T053 [P] Close unit-test coverage gaps (rate-limit tests, telegram delivery, human-action pause path)
- [X] T054 Security hardening: rate-limit `login`/`recover` (429), session cookie flags (HttpOnly/SameSite=Strict/Secure), secret-redaction verified by the logger test
- [X] T055 [P] Sync `AGENTS.md` and `docs/vision.md` with decisions changed during implementation (governance rule)
- [X] T056 Ran end-to-end validation against a live Postgres (Docker): all 87 tests green incl. the 5 gated integration tests; `next build` production build passes; migrations + seed applied; and a full browser walkthrough (onboarding → dashboard → connect Epic with cookies.txt + TOS consent → Run claim → live SSE job status → failed-gracefully without CloakBrowser). Real bugs found + fixed: (1) pg-boss v10 needs explicit `createQueue` (queue.ts); (2) Next build failed on `.js` ESM imports and bundling playwright-core → fixed via webpack `extensionAlias` + server external in next.config; (3) `output: standalone` gated behind `NEXT_OUTPUT` env (Windows symlink EPERM). The actual Epic DOM claim still needs the CloakBrowser binary to validate live.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)**: no dependencies.
- **Foundational (P2)**: depends on Setup; **blocks all user stories**.
- **User stories (P3–P6)**: all depend on Foundational. The three P1 stories have a natural
  data flow (US1 admin → US2 connect → US3 run) but each is independently testable with
  seeded fixtures. US4 (P2) depends on US3's run pipeline.
- **Polish (P7)**: depends on the targeted user stories being complete.

### Within each user story

- Tests written and failing first, then models → services → API → UI → docs.

### Parallel opportunities

- Setup: T002–T005 in parallel.
- Foundational: T007, T008, T009, T012 in parallel; T010→T011 sequential; T013/T014/T015/T016 largely parallel after their deps.
- Each story's `[P]` tests and `[P]` data-access tasks run in parallel.
- Polish: T049–T053, T055 in parallel.

---

## Parallel Example: User Story 2

```bash
# Tests first (parallel):
Task: "Contract test: Epic authenticate() in packages/connectors/tests/epic.auth.test.ts"
Task: "Integration test: consent-gated connect in apps/web/tests/connect.test.ts"

# Then parallel implementation of independent files:
Task: "connected_account + consent_record data access in packages/db/src/accounts.ts"
Task: "Epic connector authenticate() in packages/connectors/src/epic/"
```

---

## Implementation Strategy

### MVP first (US1 → US2 → US3)

1. Phase 1 Setup → Phase 2 Foundational.
2. US1 onboarding → validate independently.
3. US2 connect+consent → validate independently.
4. US3 run claim → **STOP and VALIDATE the full chain** (quickstart V1–V3). This is the MVP.

### Incremental delivery

5. Add US4 (captcha/human-action) → validate (quickstart V4).
6. Polish: design passes (impeccable + taste-skill), health monitor, security, docs, full
   quickstart V1–V5.

---

## Notes

- `[P]` = different files, no incomplete-task dependency.
- Every user story ships its own tests and docs (Principle III) — a story is not "done"
  without both.
- Verify tests fail before implementing.
- Keep the design-system baseline (T016) consistent; the polish passes (T049–T051) refine,
  they do not redefine tokens.
- Commit after each task or logical group.
