# Universal Claimer

Personal, open-source, **self-hosted** platform that automatically performs recurring
"claim" actions on your own third-party accounts — free games (Epic), Microsoft Rewards,
Twitch Prime resub, and more.

> ⚠️ Automating these platforms may violate their Terms of Service and can get your
> accounts suspended. This is used at your own risk. See the per-service warning shown in
> the app before connecting any account.

## Start here

- **[AGENTS.md](AGENTS.md)** — the maintained entry point for any contributor (human or AI):
  what the project is, the rules, the key decisions, the architecture, and the current state.
- **[.specify/memory/constitution.md](.specify/memory/constitution.md)** — non-negotiable
  principles (the source of truth).
- **[docs/vision.md](docs/vision.md)** — product vision, technical reality, and decisions.
- **[specs/](specs/)** — spec-driven development artifacts (spec → plan → tasks per feature).

## Tech stack

TypeScript monorepo (pnpm workspaces) on Node 20+. Next.js portal, a worker driving
CloakBrowser (headed via Xvfb), Postgres (bundled), pg-boss job queue. Distributed as a
single Docker Compose stack — see [docs/vision.md](docs/vision.md).

## Layout

```
apps/web        # Next.js portal + API + realtime (SSE)
apps/worker     # job worker driving CloakBrowser through connectors
packages/core   # config, crypto, logging, captcha-solver interface
packages/db     # Drizzle schema, migrations, data access, pg-boss
packages/connectors    # connector interface + per-service plugins (Epic, ...)
packages/notifications # optional outbound webhook (Discord/Telegram/ntfy)
deploy          # Dockerfiles + docker-compose.yml + .env.example
```

## Self-host (Docker)

```bash
git clone https://github.com/Mouchoir/Universal-Claimer.git
cd Universal-Claimer/deploy
cp .env.example .env      # set APP_ENCRYPTION_KEY (openssl rand -base64 32) + PORT
docker compose up -d --build
```

`docker compose up` starts Postgres, applies migrations (one-shot `migrate` service), then the
web portal + worker. Open `http://<host>:<PORT>` for first-run onboarding. x86_64 host
required. Full guide: [docs/operations/deploy.md](docs/operations/deploy.md).

## Development

```bash
corepack pnpm install     # pnpm via corepack (Node 20+)
corepack pnpm test        # run all tests
corepack pnpm build       # typecheck/build all packages
corepack pnpm lint        # lint
```

See [CONTRIBUTING.md](CONTRIBUTING.md).
