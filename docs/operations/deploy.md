# Self-host & deploy

Universal Claimer ships as a single Docker Compose stack. One deployment = one user.

## Requirements

- An **x86_64** host with Docker + Docker Compose (home NAS, VPS, or dev machine). ARM is
  unsupported (the CloakBrowser binary is x86_64).
- Nothing else — Postgres and the browser ship inside the stack.

## Steps

```bash
git clone https://github.com/Mouchoir/Universal-Claimer.git
cd Universal-Claimer/deploy
cp .env.example .env
#   set APP_ENCRYPTION_KEY (openssl rand -base64 32) and PORT in .env
docker compose up -d --build
```

## The two containers

`postgres`, and `app` — the portal, the claim worker and the migrations all live in the second
one. Only the database has a reason to keep its own lifecycle (backups, restores and major-version
upgrades that must not move in lockstep with the application image); splitting the rest into
separate containers only made the stack harder to read in a Docker UI.

`deploy/entrypoint.mjs` runs the startup steps in order, failing loudly at the first one that
breaks rather than deferring the error to the first claim:

1. start **Xvfb** — the worker runs Chromium headed for stealth, so it needs a display even on a
   headless host,
2. apply **migrations** (and seed services),
3. fetch the **CloakBrowser** binary into `/var/lib/cloakbrowser`. ~200MB on first boot, then a
   no-op — mount the `uc_browser` volume and it survives redeploys,
4. start the **web portal** and the **worker**, supervised together.

Supervision is a real supervisor, not `sh -c 'a & b'`: if either process dies the container exits
non-zero so the restart policy fires, and `docker stop` reaches both so they close their database
pools (`packages/core/src/supervisor.ts`).

Open `http://<host>:<PORT>` and complete the first-run onboarding. Allow a couple of minutes on
the very first boot — step 3 runs before the portal starts listening.

## Health

- `GET /api/health` → `{ ok, db }` (200 when the DB is reachable, 503 otherwise).
- The `app` container has a healthcheck hitting `/api/health`, with a long `start_period` so the
  first-boot browser download does not mark it unhealthy.

## CI

`.github/workflows/ci.yml` runs on every push/PR: install (frozen lockfile) → build (`tsc -b`)
→ web typecheck → tests (unit + contract + **gated DB integration** against a Postgres
service) → web production build. This is the automated full-suite gate.

Run the same suite locally:

```bash
corepack pnpm install
corepack pnpm verify        # build + web typecheck + tests
# with a disposable Postgres for the integration tests:
#   docker run -d -e POSTGRES_USER=uc -e POSTGRES_PASSWORD=uc -e POSTGRES_DB=uc -p 5433:5432 postgres:16-alpine
#   DATABASE_URL_TEST=postgres://uc:uc@localhost:5433/uc corepack pnpm test
```

## Notes

- Secrets (`APP_ENCRYPTION_KEY`, account cookies/credentials, proxies, webhook) are never
  committed; `.env` and `*.e2e-key` are gitignored.
- Managed PaaS that ban "userbots"/VNC are not suitable for the worker; use your own host.
