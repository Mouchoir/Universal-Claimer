# @uc/web

The Next.js portal: onboarding wizard, dashboard, HTTP API, and the SSE realtime stream.
Single-user — one admin per deployment, authenticated with a signed session cookie.

## Contents (foundational)

- **src/server/session.ts** — stateless signed session token (HMAC keyed from
  `APP_ENCRYPTION_KEY`), stored in an HttpOnly cookie. No server-side session store needed.
- **src/server/auth.ts** — argon2id hashing/verification for the admin password and recovery
  answers; `normalizeAnswer` for security-question matching.
- **src/app/** — App Router shell + `globals.css` design-system baseline (T016).

The API routes, onboarding wizard, connect flow, dashboard, and SSE endpoint are implemented
in the user-story phases (US1–US3), per `specs/001-connect-and-claim/tasks.md`.

## Commands

```bash
corepack pnpm --filter @uc/web dev     # local dev server
corepack pnpm --filter @uc/web build   # next build (standalone output for Docker)
```
