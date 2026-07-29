# Design: Account insights (who's connected, what's active, what was claimed)

Goal: make the dashboard answer, per connected account — **which account is this**, **what benefit
is currently active** (and when it runs out), and **what has actually been claimed**. Plus schedule
runs at a slightly random time so the automation isn't obvious.

## Why not parse job summaries

Job rows already carry a human summary (`"Claimed: Foretales"`). That's fine to read, but it is
free text: it can't be listed, filtered or counted reliably, and it changes whenever wording does.
So claims are recorded as **structured rows** instead.

## Data model

- **`claim_event`** — one row per item obtained: `connected_account_id`, `service_id`, `job_id`,
  `kind` (`game` | `prime_sub` | `points`), `title`, `claimed_at`. Backs both the "recently
  claimed" list and the stats.
- **`connected_account.display_name`** — the account's own username on the service (e.g.
  `ExampleUser`), so the dashboard shows *which* account is connected.
- **`connected_account.facts`** (jsonb) + `facts_updated_at` — non-secret observations, currently
  `{ entitlements: [{ kind: "prime_sub", channel, endsAt }] }`.
- **`schedule.jitter_minutes`** — randomization window for automatic runs.

## How the data is collected (no extra browser launches)

A claim already opens an authenticated session, so connectors report what they see *during that
run*: `ClaimResult` gained optional `claimedItems` and `accountFacts`. The worker persists both in
`recordInsights` before branching on the outcome — so facts are captured even when there was
nothing to claim. A failure to record never fails the job.

- **Epic**: reports each claimed game as a `game` item, plus the account display name.
- **Twitch**: reports a `prime_sub` item on a successful resub, plus the username (read from the
  language-independent `login` cookie) and the active sub's channel + end date.

## Scheduling

- **`applyJitter(runAt, jitterMinutes, rand)`** (in `@uc/core`, unit-tested) shifts a run by a
  random offset within ±N minutes. Applied both when the schedule is saved (first run) and when
  the scheduler advances it, so no run lands on a machine-perfect time (Principle VII).
- **Suggested next run**: when an account has an entitlement with an `endsAt` and no schedule yet,
  the editor pre-fills the schedule from that date — renewing a Prime sub right when it expires.
  Only a pre-fill: the operator stays in control.

## Dashboard

Each connected account card shows the username, the configured channel, active entitlements with
their end date and days remaining, and the most recent claims. `GET /api/accounts` returns these
alongside the existing non-secret fields (FR-008 — never secret material).
