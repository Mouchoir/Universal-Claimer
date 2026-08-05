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

1. resolve the **secrets** — `APP_ENCRYPTION_KEY` and `RELAY_TOKEN` — from the environment, then
   from the `uc_config` volume, generating and persisting only what neither supplies,
2. start **Xvfb** — the worker runs Chromium headed for stealth, so it needs a display even on a
   headless host,
3. apply **migrations**, seed services, and **verify the encryption key** is the one this database
   was written with,
4. fetch the **CloakBrowser** binary into `/var/lib/cloakbrowser`. ~200MB on first boot, then a
   no-op — mount the `uc_browser` volume and it survives redeploys,
5. start the **web portal** and the **worker**, supervised together.

Supervision is a real supervisor, not `sh -c 'a & b'`: if either process dies the container exits
non-zero so the restart policy fires, and `docker stop` reaches both so they close their database
pools (`packages/core/src/supervisor.ts`).

Open `http://<host>:<PORT>` and complete the first-run onboarding. Allow a couple of minutes on
the very first boot — step 4 runs before the portal starts listening.

## Not losing your data on an update

Three volumes, and losing either of the first two is what an update must never do:

| volume | holds | if lost |
|---|---|---|
| `uc_pgdata` | accounts, schedules, history | everything, irrecoverably |
| `uc_config` | the generated `APP_ENCRYPTION_KEY` | every stored account session becomes unreadable |
| `uc_browser` | the Chromium binary | nothing; re-downloaded on next boot |

The encryption key used to live only in the compose file, which for a Portainer stack means it is
pasted into a web form. Redeploying with a regenerated key was silent and fatal: the app started
normally and every stored session was undecryptable from then on. Now the key is generated once
into `uc_config`, the stack file carries no secrets, and its fingerprint is recorded in the
database — so a mismatched key stops the boot with an explanation instead of quietly corrupting
access to every account.

Setting `APP_ENCRYPTION_KEY` in the environment still works and takes precedence; the value is
copied into the volume as well, so removing it later is harmless.

To back up: the `uc_pgdata` and `uc_config` volumes together. Either alone is useless.

## Updates

A version is one merge to `main`. The release workflow tags the commit and publishes a release
whose body is the patch note — but only **after** the image has been pushed, so a release existing
always means there is an image to install.

The dashboard checks the published releases hourly and shows two things: the note for the version
it is now running, once, and a banner for anything newer. The "seen" marker lives in the database,
not the browser, so a note appears exactly once rather than once per machine you open it on.

### Applying them

Nothing to configure: the stack includes an `updater` service that pulls the new image and
recreates the app. It runs on a schedule — six hours by default, `UPDATE_INTERVAL_SECONDS` to
change it, `0` to switch scheduled updates off — and also on demand, which is what **Update now**
calls.

A container cannot recreate itself, so something with access to the Docker daemon has to. That
access is the whole reason the updater is its own service rather than a socket mounted into `app`:
it has no exposed port, no dependencies of its own, and one job, while `app` is a public-facing
server with a large dependency tree. Both arrangements grant the same power; one puts it behind
far less surface.

`--scope` confines the updater to containers carrying a matching label. Only `app` has it —
postgres is pinned and a database is not something to restart on a timer.

Updating never touches the volumes, so nothing is lost. A claim running at the moment of an update
is interrupted and reconciled on the next start, the same as any restart.

To use a Portainer stack webhook instead, point `UPDATE_WEBHOOK_URL` at it, set
`UPDATE_WEBHOOK_METHOD=POST` — Portainer expects a POST where the updater's trigger is a GET —
and delete the `updater` service.

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
