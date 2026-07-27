# Design: keeping stored sessions alive

## The problem

Services hand out **short-lived auth tokens**. Epic's `EPIC_SSO` / `EPIC_BEARER_TOKEN` expire in
about two days (measured on a real account: they were 46 hours past expiry when a claim first
failed with `reauth_needed`).

A browser you use yourself never notices, because every visit silently renews those tokens. The
copy we store is a **snapshot frozen at connect time**: nothing renews it, so it dies while your
own browser stays happily signed in. That mismatch is exactly the "why do I have to reconnect
when I'm still logged in on Chrome?" surprise.

Amazon's long-lived `EPIC_SSO_RM` "remember me" cookie does **not** rescue it — visiting the login
page with only that cookie cleared it and left the session logged out (verified).

## The fix

A claim already drives a real browser through the site, so the service renews the tokens *during
the run*. Those refreshed cookies are right there in the browser context — persisting them keeps
the stored session alive indefinitely, as long as runs happen more often than the token lifetime.

`ConnectorContext` gained an optional hook:

```ts
persistRefreshedSession?(cookies: BrowserCookie[]): Promise<void>;
```

Each connector calls it in its `finally`, but only when:
- the session **was** authenticated for this run (no point saving logged-out cookies), and
- the account uses `session_import` (a credential account re-logs in every run anyway).

The worker binds the hook to the account being claimed, re-seals the cookies with the same
envelope encryption as the original secret, and writes them with `refreshAccountSecret` — which
touches *only* the secret, leaving method, fingerprint, status and config alone. It is a
maintenance update, not a reconnection.

## Why a hook rather than a field on ClaimResult

`ClaimResult` is logged and summarized into job history. Cookies are secrets and have no business
travelling in it. The hook keeps them on a dedicated path: connector → worker → sealed storage,
never through a value that gets stringified into a summary. (The logger would redact a
`cookie`-ish key anyway, but not relying on that is the point.)

## Failure behaviour

Refreshing is **best-effort**: connectors swallow errors from the hook, and the worker's own
recording failure never fails a completed claim. A run that obtained a game must not be reported
as failed because a follow-up write did not land.

## Validated

Against the live instance: the sealed secret's hash changed across a real Twitch run
(`25abf541…` → `499dc5f1…`), confirming the refreshed cookies were persisted.

## Limits

This keeps a session alive; it cannot resurrect one that already expired. If a session lapses
(no runs for longer than the token lifetime), reconnect once via the dashboard's **Reconnect**
button — the session exporter extension makes that a paste. For fully unattended operation on a
service with aggressive expiry, `credential_totp` remains the method that never needs a human.
