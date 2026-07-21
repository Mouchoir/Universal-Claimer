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

On startup the stack:

1. starts **postgres**,
2. runs the one-shot **migrate** service (applies migrations + seeds services),
3. starts **web** (portal) and **worker** (automation). The worker image pre-downloads the
   CloakBrowser binary at build.

Open `http://<host>:<PORT>` and complete the first-run onboarding.

## Health

- `GET /api/health` → `{ ok, db }` (200 when the DB is reachable, 503 otherwise).
- The `web` container has a healthcheck hitting `/api/health`.

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
