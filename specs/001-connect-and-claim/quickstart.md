# Quickstart & Validation: Connect an Account and Run an Automated Claim

How to run this feature end-to-end and confirm it works. This is a validation guide, not an
implementation guide — data shapes live in [data-model.md](data-model.md) and
[contracts/](contracts/).

## Prerequisites

- An x86_64 host with Docker + Docker Compose (a home NAS or any Linux/Windows/macOS dev
  machine). ARM is unsupported (CloakBrowser binary).
- Nothing else — Postgres and the browser ship inside the stack.

## Setup

1. Copy the env example and set the two required values:

   ```bash
   cp deploy/.env.example deploy/.env
   # In deploy/.env:
   #   APP_ENCRYPTION_KEY = a base64-encoded 32-byte key (generate: openssl rand -base64 32)
   #   PORT               = e.g. 8080
   #   (DATABASE_URL is preset to the bundled postgres service)
   ```

2. Bring up the stack:

   ```bash
   docker compose -f deploy/docker-compose.yml up -d
   ```

   Expected: three healthy services — `web`, `worker`, `postgres`. Migrations run on `web`
   startup.

## Validation scenarios

Each maps to a user story / success criterion in [spec.md](spec.md).

### V1 — First-run onboarding (US1, SC-001)
1. Open `http://<host>:<PORT>`. Expect the first-run wizard (not the dashboard).
2. Set an admin password; optionally set 3 security questions or decline them (declining
   shows the "only a host-side reset can recover" warning); optionally add a webhook.
3. Land on an empty dashboard. Open the app in a new private window → expect a login prompt.
4. Re-open `/api/setup/state` → `needsSetup: false`; re-posting setup → `409`.
- **Pass**: reachable dashboard only after auth; no second admin creatable; under 3 minutes.

### V2 — Connect an Epic account with consent (US2, SC-002, SC-004)
1. Go to Services → Epic Games → Connect. Expect the Epic-specific TOS warning; the connect
   button is disabled until consent is accepted.
2. Accept consent, choose **session import**, follow the guided cookies export, upload the
   `cookies.txt`. Expect account status `connected`.
3. `GET /api/accounts` → the account appears with no secret fields.
4. Inspect Postgres (`connected_account`): `secret_ciphertext` is bytea, unreadable; grep
   logs for the cookie value → **zero matches**.
- **Pass**: consent row exists with timestamp; no plaintext secret anywhere (SC-004).

### V3 — Run a claim on demand (US3, SC-003, SC-005)
1. From the dashboard, click **Run claim** on the Epic account.
2. Watch the status via the SSE stream: `queued → running → <terminal>` within 5s of each
   transition, no manual refresh.
3. Terminal outcome is one of `claimed` / `nothing_to_claim` (both succeed) or `failed`
   with a readable reason. Check `GET /api/jobs/{id}` → outcome persisted.
4. Click **Run claim** again while one is running → `409 CLAIM_IN_PROGRESS`.
- **Pass**: every run ends with a persisted terminal outcome; live status < 5s.

### V4 — Captcha / human action (US4)
Run against the captcha contract fixture (see below) rather than live Epic:
1. Force a captcha condition. With no anti-captcha key configured, the job goes straight to
   `requires_human_action` and (if a webhook is set) notifies it.
2. Resolve via the portal (screenshot + confirm) → `POST /api/jobs/{id}/human-action` →
   job resumes to `running`, not restarted.
3. Confirm no VNC/remote-desktop is ever offered.
- **Pass**: layered fallback works; resume (not restart); webhook failure never fails the job.

### V5 — Edge cases
- Stop `worker` mid-run, restart it → the interrupted job shows `failed: interrupted`, never
  stuck `running` (FR-016).
- Change `APP_ENCRYPTION_KEY` to a wrong value and restart → connecting/using an existing
  account surfaces a clear "encryption key does not match" error, no opaque crash.
- Expire the stored session fixture → a run returns `reauth_needed` and the account flips to
  `needs_reauth`.

## Running the tests

```bash
pnpm install
pnpm test            # Vitest unit tests across packages
pnpm test:contract   # Playwright connector contract tests against recorded fixtures (no live calls)
pnpm test:integration# onboarding → connect → run against a stub connector
```

- Contract fixtures live in `packages/connectors/tests/fixtures/epic/`
  (`available`, `nothing`, `expired`, `captcha`).
- A redaction assertion in the shared test util fails if any secret appears in logs/outputs.

## Host-side admin password reset

If the operator forgets the password and declined security questions:

```bash
docker compose -f deploy/docker-compose.yml exec web node dist/cli/reset-admin.js
# prompts for a new password; works regardless of recovery settings (FR-002b)
```
