# Design: keeping stored sessions alive

## The problem

Services hand out **short-lived auth tokens**. Epic's `EPIC_BEARER_TOKEN` / `EPIC_SSO` last
**hours, around 8 h**, not days. An earlier version of this document said "about two days",
reading it off a session whose tokens were already 46 hours past expiry when a claim first failed
with `reauth_needed`. That measured how long the session outlived its tokens, not how long the
tokens last.

The session survives its tokens through Epic's **longer-lived cookies** (`EPIC_SESSION_AP`,
`EPIC_SSO_RM`, ...). When the tokens have lapsed, the account page sends the browser to the login
page, and the login page, seeing those cookies still valid, issues fresh tokens and bounces
straight back to the account page. No password, no human.

A browser you use yourself never notices, because every visit goes through that renewal. The
copy we store is a **snapshot frozen at connect time**: nothing renews it, so once the
longer-lived cookies behind it lapse too, it dies while your own browser stays happily signed in.
That mismatch is exactly the "why do I have to reconnect when I'm still logged in on Chrome?"
surprise.

`EPIC_SSO_RM` on its own does **not** carry the session: visiting the login page with only that
cookie cleared it and left the session logged out (verified). It is the set of longer-lived
cookies together that lets the login page renew the tokens.

## The fix

A claim already drives a real browser through the site, so the service renews the tokens *during
the run* (on Epic, often through the login-page bounce described above). Those refreshed cookies
are right there in the browser context - persisting them keeps the stored session alive
indefinitely, as long as runs happen more often than the longer-lived cookies last. The
short-lived tokens can lapse between runs; the bounce renews them.

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

## Checking the session without catching it mid-renewal

The renewal goes through the login page, so "the account page landed on the login page" is not,
by itself, "signed out". Epic's signed-in check used to read the URL the instant the document
loaded, and so caught a live session half-way through its own renewal and reported it as
`reauth_needed`.

`checkSignIn()` in the Epic driver now returns where it ended up, as
`{ state: "signed_in" | "signed_out" | "blocked", path, status, bounced }`, and decides like this
(`settleSignIn`, unit-tested against a fake clock):

- **Any landing but the login page is signed in**, exactly as before, so a session that passed
  the old check still passes.
- **A login landing gets a bounded wait (about 25 s)** for the bounce back to an `/account/...`
  page, polling the page URL. If it comes, the session is signed in with `bounced: true`, and the
  run's cookies, which now hold the tokens the login page just issued, are persisted as above.
  If it does not, the session is `signed_out`.
- **A Cloudflare challenge** keeps the account URL, so it used to read as signed in. It is now
  recognised by Cloudflare's `cf-mitigated: challenge` header on the latest page document, or by
  the challenge page's own markup (element ids, the `_cf_chl_opt` script global), never by its
  text, which is localized. Not by the `__cf_chl_` URL tokens either: a solved challenge reloads
  into the real page with them still in the query, so they outlive it. It gets up to about 20 s
  to clear by itself; one that stays is `blocked`, which fails the run with "Blocked by a
  Cloudflare challenge at ..." instead of asking for a reconnect that could not help. The account
  page a bounce comes back to gets the same wait, and is `blocked` (with `bounced: true`) if its
  challenge stays.
- **A password login** ends on the same check and hands it back whole, so a challenge there is
  reported as `blocked` too rather than as "login failed", and a claim does not run the check a
  second time.
- Nothing waits for network idle: Epic's pages keep connections open, and it may never come.

A `signed_out` summary names where the check stopped (the path after the wait, never the query
string) and which of Epic's auth cookies the browser still holds (`EPIC_SSO`,
`EPIC_BEARER_TOKEN`, `EPIC_SESSION_AP`, `EPIC_SSO_RM`, `EPIC_DEVICE`), each as `valid`, `session`
or `expired`, or as missing. Names and states only, never a value. The cookies are diagnostics,
not a gate: Epic renames and reshuffles them without notice, and the account page stays the only
verdict.

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
(no runs for longer than the longer-lived cookies last; the `signed_out` summary's cookie states
show which ones are gone), reconnect once via the dashboard's **Reconnect** button - the session
exporter extension makes that a paste. For fully unattended operation on a service with
aggressive expiry, `credential_totp` remains the method that never needs a human.
