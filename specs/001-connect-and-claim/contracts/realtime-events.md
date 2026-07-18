# Contract: Realtime Events (SSE)

The dashboard receives near-real-time job updates over Server-Sent Events (research.md §3).
This satisfies SC-005 (status change reflected within 5s, no manual refresh).

## Endpoint

### `GET /api/events` (SSE stream)
- Requires the admin session cookie.
- Content-Type: `text/event-stream`.
- The web app subscribes to Postgres `LISTEN job_events` and relays each notification as an
  SSE message. On connect, it first replays the current state of any non-terminal jobs so a
  freshly opened dashboard is immediately consistent.

## Event payloads

Each SSE `data:` line is a JSON object with a `type`:

```jsonc
// job entered a new lifecycle state
{ "type": "job_state", "jobId": "...", "serviceId": "epic", "state": "running" }

// terminal outcome reached
{ "type": "job_outcome", "jobId": "...", "outcome": "claimed",
  "summary": "Claimed: <game title>", "finishedAt": "2026-07-17T..." }

// human action needed (captcha unsolved / login anomaly)
{ "type": "requires_human_action", "jobId": "...", "serviceId": "epic",
  "prompt": "Solve the challenge shown, then confirm.",
  "screenshotUrl": "/api/jobs/<id>/challenge.png" }

// account flagged for re-auth (expired session)
{ "type": "account_status", "accountId": "...", "status": "needs_reauth" }
```

## Rules

- Payloads are secret-free (Principle II); `summary`/`prompt` are human-readable only.
- The screenshot for a human-action challenge is served on demand from the job's transient
  state and is deleted once the job reaches a terminal state; it never contains credentials.
- SSE is server→client only. The operator's resolution of a human-action challenge goes back
  via `POST /api/jobs/{id}/human-action` (see [http-api.md](http-api.md)).

## Outbound webhook (parallel channel)

When a `notification_target` is configured, `requires_human_action`, `job_outcome:failed`,
and `account_status:needs_reauth` events are ALSO delivered to the webhook
(Discord/Telegram/ntfy). Webhook delivery is best-effort: failures are logged and never fail
or block the job (FR-014a); the SSE/in-portal channel remains authoritative.
