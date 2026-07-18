# Phase 1 Data Model: Connect an Account and Run an Automated Claim

Single-user deployment: there is exactly one operator, so tables carry no `user_id` /
tenant column and no row-level security. All timestamps are UTC. Secrets are stored only as
ciphertext (see [research.md](research.md) §4).

## Entities

### admin
The single operator account. Enforced singleton (at most one row).

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | always a single row |
| password_hash | text | argon2id hash |
| recovery_enabled | boolean | true if security questions were set |
| created_at | timestamptz | |

- Singleton enforced by a unique constraint on a constant column (e.g. `singleton bool
  DEFAULT true UNIQUE`).
- FR-002: no second admin can be created.

### security_question
Zero or three rows, tied to the admin. Present only if `admin.recovery_enabled` is true.

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| position | smallint | 1..3 |
| question | text | operator-chosen prompt |
| answer_hash | text | argon2id hash of the normalized answer |

- FR-002a: all three answers must verify to reset the password; answers never stored plain.

### service
Static catalog of supported target platforms. Seeded (not user-created) in this feature.

| Field | Type | Notes |
|---|---|---|
| id | text PK | e.g. `epic` |
| display_name | text | e.g. "Epic Games" |
| connector_version | text | version of the connector plugin |
| tos_warning | text | service-specific warning shown at connect time |
| methods | text[] | allowed connection methods: `session_import`, `credential_totp` |

### connected_account
A third-party account linked to a service. **At most one per service** (FR-006a).

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| service_id | text FK → service.id | UNIQUE (enforces one account per service) |
| method | text | `session_import` \| `credential_totp` |
| secret_ciphertext | bytea | envelope-encrypted payload (cookies, or credentials+TOTP seed) |
| secret_data_key | bytea | per-account data key, wrapped by the app master key |
| fingerprint | jsonb | persistent UA/timezone/locale/viewport |
| status | text | `connected` \| `needs_reauth` |
| created_at | timestamptz | |
| updated_at | timestamptz | |

- FR-007/008: only ciphertext persisted; never returned to the client in plaintext.
- FR-015: `status` flips to `needs_reauth` when a run detects an expired session.

### consent_record
Timestamped proof the operator accepted a service's TOS warning. Precondition for running.

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| service_id | text FK → service.id | |
| accepted_at | timestamptz | |
| tos_warning_snapshot | text | exact warning text shown, for auditability |

- FR-005: a matching consent record must exist before any job runs for a service.

### job
One claim attempt for a connected account.

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| connected_account_id | uuid FK → connected_account.id | |
| state | text | see state machine below |
| outcome | text | `claimed` \| `nothing_to_claim` \| `failed` \| `reauth_needed` (null until terminal) |
| summary | text | human-readable result; **never contains secrets** |
| created_at | timestamptz | |
| started_at | timestamptz | nullable |
| finished_at | timestamptz | nullable |

- FR-011: exactly one terminal outcome persisted per job.
- No secret field exists on this table by design.

### notification_target
Optional single outbound webhook for the deployment.

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | at most one row |
| kind | text | `discord` \| `telegram` \| `ntfy` |
| config_ciphertext | bytea | encrypted webhook URL / token |
| created_at | timestamptz | |

## Relationships

```
admin (1) ──< security_question (0 or 3)
service (1) ──< connected_account (0..1)   # unique service_id
service (1) ──< consent_record (0..n)
connected_account (1) ──< job (0..n)
notification_target (0..1 per deployment)
```

## Job state machine

```
queued ──► running ──► succeeded        (outcome: claimed | nothing_to_claim)
                   ├──► failed           (outcome: failed | reauth_needed)
                   └──► requires_human_action ──► running ──► (terminal as above)
```

- `queued → running`: worker picks up the job (pg-boss singleton key = account id ⇒ no two
  concurrent running jobs for one account, FR-010).
- `running → requires_human_action`: captcha unsolved by auto-solver / login anomaly
  (Story 4). On operator resolution, resumes to `running` (does not restart).
- On worker startup, any job left `running`/`requires_human_action` from a crash is
  reconciled to `failed` with summary "interrupted" (FR-016).
- Terminal states: `succeeded`, `failed`. `requires_human_action` is non-terminal.

## Validation rules

- `connected_account.method` must be one of `service.methods`.
- Creating a `job` requires a `consent_record` for the account's service (else rejected).
- `security_question` rows exist iff `admin.recovery_enabled` is true, and then exactly 3.
- `connected_account.service_id` is unique (one account per service).
