# Onboarding & admin recovery

Universal Claimer is single-user per deployment. First-run setup and all configuration are
done in the web portal — no config files to hand-edit beyond `deploy/.env`.

## First run

1. Start the stack (`docker compose up`, see the [quickstart](../../specs/001-connect-and-claim/quickstart.md)).
2. Open the portal. With no admin yet, you are sent to **/setup**.
3. Set an **admin password** (min 8 characters).
4. Optionally enable **password recovery** with three security questions. If you decline,
   the setup screen warns that a forgotten password can then only be reset with the
   host-side command below.
5. Optionally add one **notification webhook** (Discord / Telegram / ntfy). Its URL is stored
   encrypted.
6. You land on the dashboard, signed in. A second admin can never be created.

## Signing in / recovery

- **/login** — enter the admin password.
- **/recover** — if recovery was enabled, answer the three security questions to set a new
  password. Answers are matched case- and whitespace-insensitively and are stored only as
  argon2 hashes.

## Host-side password reset (always available)

Whoever controls the host can reset the password regardless of recovery settings (FR-002b):

```bash
# from the repo, against the same DATABASE_URL as the deployment:
corepack pnpm --filter @uc/web reset-admin
# non-interactive:
UC_NEW_PASSWORD='new-strong-password' corepack pnpm --filter @uc/web reset-admin
```

## Security notes

- The admin password and security-question answers are hashed with **argon2id**; they are
  never stored or logged in clear text.
- The session is a signed (HMAC) HttpOnly cookie keyed from `APP_ENCRYPTION_KEY`; there is no
  server-side session store.
