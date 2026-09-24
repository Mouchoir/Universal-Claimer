# Epic Games

Claims the Epic Games Store's weekly free games.

## What a claim does

1. Signs in from the stored session (see [connecting accounts](connecting-accounts.md)).
2. Reads what is free right now from Epic's public promotions feed, not from the store page.
3. For each game, opens its product page in the en-US store (`/en-US/` and `?lang=en-US`, with
   the browser itself set to en-US), so the labels read the same for every account whatever its
   language.
4. Reads the purchase button. "In Library" means owned already; anything else is a checkout to
   walk through.

## The checkout, step by step

The walk waits for things to happen rather than for a fixed time, and each wait has a budget:

| Step | What it waits for | Budget |
|---|---|---|
| Before the click | The button's placeholder "Get" to turn into "In Library" if the game is owned | 2 s |
| After "Get" | The purchase window (an iframe) to open | 30 s |
| In the window | "Add to library" (or "Place Order") to be clickable, not disabled or loading | 30 s |
| After the confirm click | Epic's confirmation in the window, or the purchase button turning to "In Library" | 30 s |
| Verification | The reloaded product page to show the game as owned (the library lags the order) | 3 reloads, 5 s apart |

On the way it clears what stands in front of the order: a "Continue" notice on the page (mature
content, "Device not supported", an updated privacy policy), "Yes, buy now" for an edition that
overlaps something owned, the EULA (its agree box, then Accept), and the EU right-of-withdrawal
"I Accept" that a European account gets after the confirm click. A cookie banner is never
accepted.

A claim is only reported as claimed once the product page, reloaded, shows the game as owned.
When nothing confirmed the order within the budget, one reload still decides, so a claim whose
confirmation Epic reworded is not reported as a failure.

## Reading a failure

When a game is not claimed, the run summary lists every step the checkout reached, in order,
ending with where it stopped and what the purchase button reads now:

```
Astrea (clicked 'Get'; purchase window opened; clicked 'Add to library'; no confirmation within 30 s; the purchase button still reads 'Get')
```

| The reason says | It means |
|---|---|
| `the purchase window did not open within 30 s` | The click did not lead to a checkout. If buttons from a dialog are listed, that dialog was in the way. |
| `no 'Add to library' or 'Place Order' button (buttons seen: ...)` | The window opened but offered something else. The listed buttons say what. |
| `'Add to library' stayed busy for 30 s` | The confirm button never left its loading state. |
| `Epic said "..."` | The checkout showed an error; its text is quoted, with anything that looks like an address or a number replaced. |
| `no confirmation within 30 s` | The confirm click happened, and neither Epic nor the library confirmed it. |
| `the product page did not show it as owned after 3 reloads` | Epic confirmed the order but the library did not list it. The next run will see it as owned if it landed. |
| `Epic says the product is unavailable in your region` | Region-locked for the account. |
| `Epic asks for the parental-controls PIN` | The account has parental controls; claim it by hand. |

The same trail goes to the worker log (`epic checkout`), including for a captcha hand-off, whose
summary does not carry it.

## Captcha

A captcha challenge that shows up on the product page, in the purchase window, or in a frame
inside it ends the checkout for that game, and the run follows the
[captcha path](captcha-and-human-action.md): auto-solve if configured, otherwise the run pauses for
you. Epic's checkout always loads an invisible hCaptcha that passes by itself for a genuine
session; only a challenge that is actually shown counts. Epic's own "Failed to challenge captcha"
message counts too.

## Where the behaviour comes from

Epic changes this checkout without notice, and the maintained reference that still clicks through
it is `vogler/free-games-claimer` on its `dev` branch (`epic-games.js`). The walk takes from it
the confirm label "Add to library" (commit 28b0afc7), the confirmation texts (28b0afc7, 50fef25e,
ccb9e726), the wait for the purchase button to stop reading "Loading" (5938bf46), the
`.payment-loading--loading` guard on the confirm button, the checkout captcha selector, the page
notices, and the EULA and "I Accept" steps. From `P-Adamiec/Free-Games-Claimer-Remaster` it takes
the verification by reload, and from `feldorn/free-games-claimer` the re-read of the button
before clicking and the purchase button turning owned as a success signal.
`claabs/epicgames-freegames-node` no longer automates the checkout (it has sent a checkout link
to finish by hand since v5.0.0), so it is not a reference for this part.

Not validated against the live store yet: the selectors come from the references above and were
exercised against a local stand-in of the checkout in a real Chromium.
