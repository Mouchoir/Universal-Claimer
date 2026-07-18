# Contract: HTTP API

Portal endpoints exposed by `apps/web`. Single-user: all non-setup routes require the admin
session cookie. All request/response bodies are JSON unless noted. Errors use
`{ "error": { "code": string, "message": string } }` with appropriate HTTP status.

Auth model: session cookie (HttpOnly, SameSite=Strict) issued on login; no external IdP.

## Onboarding & auth

### `GET /api/setup/state`
Returns whether first-run setup is needed.
- `200 { "needsSetup": boolean }`

### `POST /api/setup`
First-run only. Creates the single admin and optional recovery + webhook.
- Body: `{ password: string, recovery?: { questions: [{q,a},{q,a},{q,a}] }, webhook?: { kind, url } }`
- `201 { ok: true }` — issues a session.
- `409 SETUP_ALREADY_DONE` if an admin already exists (FR-002).

### `POST /api/auth/login`
- Body: `{ password: string }`
- `200 { ok: true }` (sets session) | `401 INVALID_CREDENTIALS`

### `POST /api/auth/recover`
Password reset via the three security questions (only if recovery enabled).
- Body: `{ answers: [string, string, string], newPassword: string }`
- `200 { ok: true }` | `400 RECOVERY_DISABLED` | `401 ANSWERS_INCORRECT`
- Host-side reset command is separate (not an HTTP route) — see quickstart.

### `POST /api/auth/logout`
- `200 { ok: true }`

## Services & accounts

### `GET /api/services`
Catalog of supported services + whether each is already connected and consented.
- `200 { services: [{ id, displayName, methods, connected: boolean, consented: boolean }] }`

### `GET /api/services/{id}/tos`
Returns the service-specific TOS warning to render before connecting (FR-004).
- `200 { serviceId, warning }`

### `POST /api/services/{id}/consent`
Records timestamped consent (FR-005). Required before connecting/running.
- Body: `{ accepted: true }`
- `201 { consentedAt }` | `400 CONSENT_REQUIRED` if `accepted` is not true

### `POST /api/accounts`
Connect the (single) account for a service. Requires prior consent.
- Body (session import): `{ serviceId, method: "session_import", cookiesText?: string, cookiesJson?: BrowserCookie[] }`
- Body (credential): `{ serviceId, method: "credential_totp", email, password, totpSeed? }`
- `201 { accountId, status: "connected" }`
- `409 ACCOUNT_EXISTS` if the service already has an account (FR-006a)
- `400 CONSENT_REQUIRED` if no consent record exists
- `422 AUTH_FAILED` if the connector cannot authenticate the provided secret
- Secrets are accepted, encrypted, and **never** echoed back (FR-008).

### `GET /api/accounts`
- `200 { accounts: [{ id, serviceId, method, status }] }` — no secret fields ever.

### `DELETE /api/accounts/{id}`
Disconnect and delete the stored secret.
- `200 { ok: true }`

## Jobs

### `POST /api/accounts/{id}/claim`
Trigger a claim on demand (FR-009). Enqueues a job.
- `202 { jobId, state: "queued" }`
- `409 CLAIM_IN_PROGRESS` if a job is already running for this account (FR-010)
- `403 CONSENT_REQUIRED` if consent is missing

### `GET /api/jobs`
- `200 { jobs: [{ id, serviceId, state, outcome, summary, createdAt, finishedAt }] }`

### `GET /api/jobs/{id}`
- `200 { id, state, outcome, summary, createdAt, startedAt, finishedAt }`

### `POST /api/jobs/{id}/human-action`
Operator signals a human-action challenge is resolved so the job resumes (Story 4, FR-014).
- Body: `{ resolved: true }`
- `200 { state: "running" }` | `409 NOT_WAITING` if the job is not awaiting human action

Realtime job updates are delivered separately — see
[realtime-events.md](realtime-events.md).
