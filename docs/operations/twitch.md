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
2. Asks whether the account already holds a live sub to it. Twitch's own subscription API (the
   GraphQL query the site itself uses) answers first. The channel page's markers answer only
   when the API gave no usable answer (see [When the page decides](#when-the-page-decides)).
3. Already subscribed → **nothing_to_claim** (not a failure), with a summary that says what the
   verdict rests on (see below).
4. Otherwise clicks Subscribe → Use Prime → Subscribe with Prime → **claimed**. A resub that did
   not go through is **failed**, with the reason.
5. Expired session → **reauth_needed** (reconnect the account). Channel not found →
   **failed**. Captcha → auto-solve, else human action (the layered strategy in
   [captcha-and-human-action.md](captcha-and-human-action.md)).

## Reading an "already active" summary

The summary names the kind of sub, its date, and who said so:

| Summary | Meaning |
|---|---|
| `Prime sub to "examplechannel" is active until 2026-10-16 (from Twitch's API).` | Twitch flags the sub as bought with Prime. |
| `Paid sub to "examplechannel" is active, renewing on 2026-10-05 (from Twitch's API).` | Not Prime, but it renews on its own: a sub someone pays for, almost always the account itself. |
| `A non-Prime sub to "examplechannel" is active until 2026-11-01 (from Twitch's API).` | Neither Prime nor renewing: a gift, a cancelled sub or a promotion. The reply cannot tell them apart. |
| `A non-Prime sub to "examplechannel" is active with no end date (from Twitch's API).` | A permanent grant. |
| `A sub to "examplechannel" is active (from the channel page; Twitch's API could not be asked: HTTP 401).` | The page showed the subscribed marker, and the API gave no answer, for the reason given. |

Dates are the UTC calendar day, whatever the instance's locale. Only "from Twitch's API" rests on
Twitch's own record of the sub; a page verdict rests on which buttons the page showed.

## When the page decides

The page is read only when the API gave no usable answer, and the reason follows "Twitch's API
could not be asked:". A failed call is never read as "not subscribed", since that is the answer
that starts a resubscribe.

| Reason | What happened |
|---|---|
| `HTTP <status>` | The API answered with an error status. Its first error message follows in quotes when it gave one. |
| `the request failed (...)` | The request itself did not complete. |
| `the reply was not JSON` | Typically a gateway or error page. |
| `Twitch returned an error ("...")`, `the reply carried no data` | An error reply, or a reply with nothing in it. |
| `the reply named no signed-in account` | The API did not recognize the session. |
| `the reply carried no subscription list` | The reply came without the list. |
| `the reply could not be read (...)` | The reply had a shape the parser did not expect. |
| `the reply's date for this channel does not parse` | A benefit for the channel has an end date that does not parse, and no other benefit for it is live. That benefit could be the live one. |
| `the reply's list is incomplete ("...")` | Twitch returned an error alongside a list with entries it could not name a channel for, and nothing live for this channel came through. A missing entry could be the live one. |

A renewal date that does not parse is dropped instead: it never decides whether a sub runs, so
the verdict stands and only the summary loses its "renewing on" date.

## Diagnosing a verdict

Each run logs one `twitch sub verdict` line. It carries no cookie or token value.

- `decidedBy`: `api`, `page`, or `none` when the run stopped before asking (channel not found,
  captcha).
- `apiHttpStatus`, `apiErrors` (the reply's first error) and `apiUnavailable` (the reason above).
- `edgeCount`: how many entries the API's list held. The query asks for the first 100, so 100
  means the list may have been cut short.
- `listCount`: the benefits kept from that list, i.e. those with a channel to match on.
  `listHasChannel`: whether any of them is for the configured channel, live or lapsed.
- `kind`, `endsAt`, `renewsAt`: the benefit the verdict rests on.
- `subscribeishTargets`: the page's subscribe-like `data-a-target` values, when no subscribe
  control matched.

## Schedule it

Twitch is scheduled **on expiry**: turn on **Run automatically** and the next run is due when the
current sub ends (or, for a sub with no end date, when it renews), plus the optional delay. The
date comes from the run: the API's verdict when the API decided, otherwise a fresh read of the
subscription list. Only a date still ahead is kept. With none (nothing known yet, or a date that
has already passed), the next run is a day later.

## Notes

- One channel per account (per-account config `{ channel }`). Not a secret — stored as plain
  JSON.
- Twitch Prime must be available/linked on the account (you manage that on Amazon/Twitch).
- Adding Twitch required **no** changes to the scheduler, job pipeline, or SSE — it is a
  drop-in connector (Constitution Principle I).
