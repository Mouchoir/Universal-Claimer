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
cp .env.example .env      # set APP_ENCRYPTION_KEY + RELAY_TOKEN (see the file), and PORT
docker compose up -d --build
```

`docker compose up` starts Postgres, applies migrations (one-shot `migrate` service), then the
web portal + worker. Open `http://<host>:<PORT>` for first-run onboarding. x86_64 host
required. Full guide: [docs/operations/deploy.md](docs/operations/deploy.md).

## Session exporter extension

Some services refuse the instance-controlled browser used by assisted login, so an account is
connected by importing a session instead. The companion browser extension exports one locally —
it lives in its own repository, published from source to both stores:

**[Mouchoir/universal-claimer-extension](https://github.com/Mouchoir/universal-claimer-extension)**

It is deliberately not vendored here: while a copy lived in this repo it drifted from the real one
within days, and the two had to be hand-synchronised on every change.
## Development

```bash
corepack pnpm install     # pnpm via corepack (Node 20+)
corepack pnpm test        # run all tests
corepack pnpm build       # typecheck/build all packages
corepack pnpm lint        # lint
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgements

This project stands on other people's work, and in a couple of places on their hard-won knowledge
of how these sites actually behave.

- **[CloakBrowser](https://github.com/CloakHQ/CloakBrowser)** — the source-patched Chromium every
  claim runs in, and a drop-in replacement for `playwright-core`. Without it this project would be
  a detection lesson rather than an automation one.
- **[epicgames-freegames-node](https://github.com/claabs/epicgames-freegames-node)** (claabs) —
  the reference implementation for Epic. Scraping the store page for "Free Now" labels broke as soon
  as the UI rendered in another language; this project pointed the way to Epic's free-games
  promotions feed, which is what the Epic connector reads today.
- **[Get cookies.txt LOCALLY](https://github.com/kairi003/Get-cookies.txt-LOCALLY)** (kairi003) —
  the open-source, local-only cookie exporter that proved the pattern, and the honest alternative
  if you would rather not run
  [ours](https://github.com/Mouchoir/universal-claimer-extension). Its Netscape `cookies.txt`
  output is the format this project's session import accepts.
- **[Playwright](https://github.com/microsoft/playwright)** — the browser automation API the
  connectors are written against, and the CDP plumbing the assisted-login relay builds on.
- **[pg-boss](https://github.com/timgit/pg-boss)** — Postgres-backed job queue, which is why this
  stack needs no Redis.
- **[Drizzle ORM](https://github.com/drizzle-team/drizzle-orm)** — schema, typed queries and
  migrations.
- **[Next.js](https://github.com/vercel/next.js)** — the web portal.
- **[otplib](https://github.com/yeojz/otplib)** and
  **[@node-rs/argon2](https://github.com/napi-rs/node-rs)** — TOTP generation and password hashing.
- **[spec-kit](https://github.com/github/spec-kit)** (GitHub) — the spec-driven workflow this repo
  was built with; the `specs/` directory is its output.

Thanks also to the people who documented Twitch's and Amazon's internal GraphQL endpoints in the
open. Reading a site's own API beats guessing at its markup, and it is the reason the connectors
work in any display language rather than only in English.

## Licence

MIT — see [LICENSE](LICENSE).

Automating claims may violate the terms of service of the platforms involved and could get your
accounts suspended. You run this on your own accounts, at your own risk; the instance warns you
and records your consent per service before it touches anything.
