# Deployment validation (what was actually built and run)

The Docker stack in `deploy/` is what a self-hosted instance runs. It had never been built since the
CDP relay landed; building it surfaced three faults that would each have broken a NAS deployment on
first contact. All three are fixed, and the notes below say how each was caught so the next change
can be checked the same way.

## 1. Stale `.tsbuildinfo` silently produced an empty build

`.dockerignore` excluded `dist/` but not TypeScript's incremental stamps. The host's
`*.tsbuildinfo` files were copied into the image, `tsc -b` concluded every project was already up
to date, emitted nothing, and the next package in the graph failed with `Cannot find module
'@uc/core'`. The give-away was `packages/core build: Done` in 0.2 s — far too fast for a cold build.

`*.tsbuildinfo` is now excluded.

## 2. `xvfb-run` swallowed every log line

The worker container ran but `docker logs` was completely empty — the process was alive and
healthy, yet invisible. On a headless NAS that removes any means of diagnosis.

Xvfb is now started explicitly and the worker is `exec`'d, so its stdout goes straight to
`docker logs` and `docker stop` delivers SIGTERM to the worker rather than to a wrapper script.

## 3. Chromium was missing shared libraries

`libcairo.so.2` (and, behind it, pango/GTK/others) were absent, so every browser launch failed
with `error while loading shared libraries` buried inside a Playwright launch log. Nothing failed
until the first claim.

The dependency list is now complete, and the image build **verifies** it: `ldd` must report no
missing library and Chromium must actually render a page, or the build fails. A missing library is
now a build error instead of a runtime mystery.

## How it was verified

- `docker build` for both images, from a clean context.
- Web image: started against Postgres, `GET /api/health` → `{"ok":true,"db":true}`, `/login` → 200,
  with the relay WebSocket enabled.
- Worker image: started (log visible), then a **real claim** dispatched through the queue and
  executed by the containerised worker driving CloakBrowser under Xvfb — outcome
  `nothing_to_claim` ("Prime sub … already active"), i.e. the connector ran the site for real.

## Still unverified

The stack has only been exercised as individual containers against a local Postgres, not through
`docker compose up` on the target NAS. Compose adds: the one-shot `migrate` service ordering,
service-name DNS (`postgres`, `web`), and the published port. Nothing there is exotic, but it has
not been run.
