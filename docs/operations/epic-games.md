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
| Verification | The reloaded product page to show the game as owned (the library lags the order) | 3 reloads, 5 s apart, each up to 37 s |

A verification reload gets 15 s to load, 12 s for the purchase button to appear and 10 s for it to
settle. The budgets are per step, so a game whose every wait runs out takes about four minutes
(the three step budgets back to back, then three full reloads), plus up to 52 s for the first read
of the product page. Plan a run with several free games on that, not on the 30 s of one step.

On the way it clears what stands in front of the order: a "Continue" notice on the page (mature
content, "Device not supported", an updated privacy policy), "Yes, buy now" for an edition that
overlaps something owned, the EULA (its agree box, then Accept), and the EU right-of-withdrawal
"I Accept" that a European account gets after the confirm click. A cookie banner is never
accepted: a button is clicked by its whole label, so the EULA's "Accept" is never taken for an
"Accept All Cookies" that comes before it on the page.

Epic's confirmation copy only counts once the confirm button was clicked, or when the window
shows no confirm button at all. Copy that was already in the window when it opened, next to its
confirm button, counts only once it has gone and come back.

A claim is only reported as claimed once the product page, reloaded, shows the game as owned.
When nothing confirmed the order within the budget, one reload still decides, so a claim whose
confirmation Epic reworded is not reported as a failure. A purchase button that turns to
"In Library" before any purchase window opened was Epic's placeholder "Get" loading slowly: once a
reload agrees, the game is reported as already owned, not as claimed.

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
| `the purchase button turned to 'In Library' before any purchase window opened` | Followed by the reloads that did not agree: the store showed the game as owned, the library did not. |
| `the product page closed before the checkout ended` | The browser page went away mid-checkout (the browser was closed or crashed). |

The same trail goes to the worker log (`epic checkout`), including for a captcha hand-off, whose
summary does not carry it.

## Captcha

A captcha challenge that shows up on the product page, in the purchase window, or in a frame
inside it ends the checkout for that game, and the run pauses for you straight away
([human action](captcha-and-human-action.md)): claim the game in your own browser, then resume.
The auto-solver is not asked, even with a key configured. Epic's checkout challenge is an hCaptcha
inside its own purchase window, and a token solved elsewhere has nowhere to go in it, so a solve
would only spend the solver's credit. Epic's checkout always loads an invisible hCaptcha that
passes by itself for a genuine session; only a challenge that is actually shown counts. Epic's own
"Failed to challenge captcha" message counts too.

The pause keeps what the run already did: games claimed before the captcha are recorded in the
history, and the summary names them, along with any that failed before it.

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

Not validated against the live store yet: the selectors come from the references above and are
exercised against local stand-ins of the checkout in a real Chromium by an opt-in suite,
`packages/connectors/tests/epic.checkout.browser.test.ts`. It runs when `EPIC_BROWSER_TESTS` is set
and a browser is at hand (the CloakBrowser binary once downloaded, Playwright's Chromium, or
`EPIC_BROWSER_PATH`), and skips itself otherwise:

```
EPIC_BROWSER_TESTS=1 corepack pnpm vitest run packages/connectors/tests/epic.checkout.browser.test.ts
```

The stand-ins are served by the test itself under Epic's own addresses, so the frames are read as
the checkout reads them; nothing reaches the network.
