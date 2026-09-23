# Amazon Prime Gaming

Claims the free games included with Amazon Prime (the "Free Games with Prime" offers).

## Connecting

Prime Gaming only supports **session import**. Amazon's password flow is heavily challenged
(OTP, device verification, CAPTCHAs), so the connector deliberately refuses `credential_totp`
and points you at session import instead:

1. Sign in on **your own marketplace's Luna page** in your normal browser: `luna.amazon.fr` for
   an amazon.fr account, `luna.amazon.co.uk` for amazon.co.uk, and so on. Sign in on
   `luna.amazon.com` only when amazon.com is your marketplace.
2. Export the cookies with the [session exporter extension](https://github.com/Mouchoir/universal-claimer-extension)
   (pick **Amazon Prime Gaming**).
3. In Universal Claimer: `/connect/primegaming` → **Session import** → paste → connect.

## How detection works

`gaming.amazon.com/home` now redirects to Amazon Luna's claims page. Offers are read from the
rendered cards using Amazon's `data-a-target` attributes (`learn-more-card`, `FGWPOffer`), which
stay in English whatever the account's display language — so the connector works for users in any
locale.

Amazon's GraphQL endpoint is **not** used: it answers `403` to anything outside its own persisted
query set, so hand-written queries are not a viable path.

## Marketplaces (read this if it says you are not signed in)

Amazon signs you in **per marketplace**: the auth cookie is `at-main` on `.amazon.com` and
`at-acb<country>` elsewhere (`at-acbfr` on `.amazon.fr`, `at-acbde` on `.amazon.de`), and Luna
serves each marketplace on its own host, `https://luna.amazon.<marketplace>/claims/home`.

The `gaming.amazon.com` entry point only sees `.amazon.com` cookies, which is what used to go
wrong. A session signed in on amazon.com is recognized there and sent to the account's own Luna
host (`luna.amazon.fr` for a French account). A session signed in only on amazon.fr looks
anonymous to it and is sent to `luna.amazon.com`, where that account is signed out. The offers
still list there (they are public), so nothing looked wrong until the claim failed.

So the sign-in check works in two steps:

1. It opens `gaming.amazon.com/home` and asks the page it lands on, exactly as before. If that
   page is signed in, offers are listed on that same Luna host.
2. If it is signed out, the connector reads which marketplaces the imported cookies hold a live
   auth cookie for (non-empty and not expired, the most recently renewed first), and opens each
   one's Luna claims page in turn. The first one that shows the account signed in is where offers
   are listed and claimed. A marketplace without a Luna host (`luna.amazon.co.jp`,
   `luna.amazon.com.au` and `luna.amazon.sg` do not resolve) is skipped, not treated as an error.

Every cookie is imported as it came; the marketplace reading only decides which hosts to try.
The marketplace is taken from the cookie's domain (`.amazon.co.uk` is amazon.co.uk), with no
region table, so it works for any marketplace.

When no page accepts the session, the `reauth_needed` message says which case it is: no Amazon
sign-in in the session at all, or signed in on amazon.X while `luna.amazon.X` showed the account
signed out (the sign-in expired or Amazon rejected it). It lists the hosts that were tried, and it
only ever tells you to sign in on the Luna host of your own marketplace. Every check is also
logged with marketplace and host names, never a cookie.

Authentication is always decided by a page (`data-a-target="sign-in-button"`), never by the
cookies alone: a cookie check once reported success on a session that could not claim anything.
The cookies only choose where to look. A fallback page only counts when it is a Luna page, since
Amazon's own sign-in form has no sign-in button and would otherwise read as signed in.

## How claiming works

For each claimable offer the connector opens the offer page, clicks the claim control (located by
attribute, with a text fallback), then **reloads and verifies** that the claim affordance is gone
before reporting success — the same verify-don't-assume rule the Epic connector follows. A claim
that doesn't complete is reported as `failed`, never as a phantom success.

## Scheduling

`recurring` — new games rotate regularly, so a daily check with randomization is appropriate.

## Status

- Offer detection is **validated live** (16 real offers listed with correct titles and URLs).
- The claim CTA on an offer page is `buy-box_call-to-action`. `FGWPOffer` is deliberately not
  used there: on an offer page those belong to the "more offers" carousel, so matching them
  clicked through to a different game instead of claiming (found on the first live run).
- End-to-end claiming needs a session signed in on your own marketplace's Luna host; the
  connector now finds that host by itself instead of relying on `gaming.amazon.com`'s redirect.

## Terms of service

Automating Prime Gaming claims may violate the Amazon Prime Gaming Terms of Service and could
result in suspension of your Amazon account. You use this at your own risk.

## Where a claimed game has to be redeemed

Prime Gaming does not always drop a game straight into a library. When the store account is
linked to Amazon the page says so ("Sent to your Epic Games Store library") and there is nothing
to do. When it is not linked, the offer hands out a **key** that stops working once the offer ends.

The store is derived from the slug suffix Amazon puts on every claim URL —
`framed-collection-gog`, `lonestar-epic`, `terraforming-mars-aga`,
`please-touch-the-artwork-legacy` — which lives in the URL rather than the rendered page, so it is
immune to the display language. An unknown suffix yields no platform rather than a guess.

Claimed items therefore record the platform and, when known, the redeem-by date; the activity page
shows both and warns when a deadline is within a week.

### A caution about scraping keys

The only `<input>` on a claimed offer page holds a CSRF token, not a game key. Harvesting inputs
blindly would store tokens as "keys". Key capture is therefore deliberately narrow, and
`claim_event` keeps the key envelope-encrypted like every other secret, with `hasCode` the only
thing exposed by the API until the key is explicitly requested.

Not yet validated live: no offer in the test account handed out a key (the Epic and Amazon stores
were linked, so games were delivered directly). Expect to confirm the capture on an unlinked store.