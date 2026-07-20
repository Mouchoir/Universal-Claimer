# Twitch Prime resub

Automatically re-subscribe to a channel each month using your Twitch Prime sub.

## Connect

1. On the dashboard, connect **Twitch Prime**, accept the TOS warning.
2. Enter the **channel to resubscribe to** (a required per-account config field the connector
   declares — the connect form renders it automatically).
3. Log in via **assisted login** (recommended — you log in on the official Twitch page in the
   instance-controlled browser; only the session is captured, encrypted) or paste a Twitch
   `cookies.txt`. The channel is stored alongside the account.

## How a run works

A claim for the Twitch account:

1. Opens the configured channel.
2. If already subscribed / Prime already used this cycle → **nothing_to_claim** (not a
   failure).
3. Otherwise clicks Subscribe → Use Prime → Subscribe with Prime → **claimed**.
4. Expired session → **reauth_needed** (reconnect the account). Channel not found →
   **failed**. Captcha → auto-solve, else human action (same layered strategy as Epic).

## Schedule it

Set the account to **Weekly** (or monthly-ish via weekly) in the schedule editor so the resub
runs automatically. Prime resubs are monthly, so a weekly schedule simply no-ops
(`nothing_to_claim`) until the sub is renewable again.

## Notes

- One channel per account (per-account config `{ channel }`). Not a secret — stored as plain
  JSON.
- Twitch Prime must be available/linked on the account (you manage that on Amazon/Twitch).
- Adding Twitch required **no** changes to the scheduler, job pipeline, or SSE — it is a
  drop-in connector (Constitution Principle I).
