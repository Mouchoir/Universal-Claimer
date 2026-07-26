# Amazon Prime Gaming

Claims the free games included with Amazon Prime (the "Free Games with Prime" offers).

## Connecting

Prime Gaming only supports **session import**. Amazon's password flow is heavily challenged
(OTP, device verification, CAPTCHAs), so the connector deliberately refuses `credential_totp`
and points you at session import instead:

1. Sign in to `amazon.com` / `gaming.amazon.com` in your normal browser.
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

## How claiming works

For each claimable offer the connector opens the offer page, clicks the claim control (located by
attribute, with a text fallback), then **reloads and verifies** that the claim affordance is gone
before reporting success — the same verify-don't-assume rule the Epic connector follows. A claim
that doesn't complete is reported as `failed`, never as a phantom success.

## Scheduling

`recurring` — new games rotate regularly, so a daily check with randomization is appropriate.

## Status

- Offer detection is **validated live** (16 real offers listed with correct titles and URLs).
- The claim + verification path is **not yet validated against a connected Amazon account**; the
  claim affordance only renders for a signed-in Prime member. Expect to tune the selectors in
  `claimButton()` on the first live run.

## Terms of service

Automating Prime Gaming claims may violate the Amazon Prime Gaming Terms of Service and could
result in suspension of your Amazon account. You use this at your own risk.
