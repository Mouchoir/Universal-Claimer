# Running claims

Once an account is connected and consented, you can run a claim on demand from the
dashboard. Scheduling (automatic recurring runs) is a later feature; this is manual.

## How it works

1. On the dashboard, click **Run claim** for a connected account.
2. The web app enqueues a job (state `queued`) on the pg-boss queue and returns immediately.
   A second run for the same account while one is active returns `409` (no concurrent claims
   for one account, FR-010).
3. The **worker** picks up the job, opens the account's encrypted secret in memory, launches
   CloakBrowser with the account's fingerprint, re-establishes the session, and runs the
   connector's claim.
4. The dashboard reflects the status live over SSE (`queued → running → terminal`) within a
   few seconds, no manual refresh.

## Outcomes

Every run ends with exactly one persisted terminal outcome (FR-011):

- **claimed** — a free item was claimed (the summary lists what).
- **nothing_to_claim** — nothing was available; this is a **success**, not a failure.
- **failed** — a platform/UI/network error; the summary gives a readable reason (never a
  secret).
- **reauth_needed** — the stored session is no longer valid; the account is flagged
  `needs_reauth`, and you should reconnect it.

## Interruptions & captcha

- If the worker restarts mid-run, the interrupted job is marked `failed: interrupted` on
  startup — it never stays stuck as `running` (FR-016).
- If a captcha appears and cannot be auto-solved, the run reports the need for human action.
  The pause/resume flow and webhook notification are added in the US4 phase.

## Notes

- The web app never launches a browser; only the worker does. The worker uses the official
  `cloakbrowser` package, which **manages the Chromium binary automatically** — it is
  pre-downloaded into the worker Docker image at build time (and would otherwise download on
  first launch, ~535MB, cached). No manual binary path is needed. For the CloakBrowser Pro
  binary, set `CLOAKBROWSER_LICENSE_KEY`; the free v146 needs no key.
- Connector runs are recorded; a connector whose recent failure rate crosses the threshold is
  auto-disabled (Constitution Principle I).
