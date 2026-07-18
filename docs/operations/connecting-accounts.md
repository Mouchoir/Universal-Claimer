# Connecting accounts

Before automating a service you connect the third-party account and accept a service-specific
Terms-of-Service warning. One account per service (this MVP).

## Consent first

Opening **Connect** for a service shows its TOS warning (e.g. Epic Games). You must tick "I
understand and accept the risk" — this records timestamped consent. Automation for a service
never runs without a consent record on file (Constitution Principle VI).

## Connection methods

Chosen per service; Epic supports both.

### Session import (recommended)

1. Sign in to the service in your own browser.
2. Export cookies with a "Get cookies.txt" browser extension.
3. Paste the file contents into the connect form.

The cookies are sealed (envelope-encrypted) and stored; you never enter the account
password into the platform. This is preferred because it keeps less custody (cookies are
revocable and expire).

### Email + password + TOTP (fallback)

Provide the account email, password, and — if the account uses an authenticator app — the
TOTP secret. These are sealed and stored the same way. Use this only when session import is
impractical.

## What happens at connect time

The web app does **not** run a browser. It parses/validates the input, seals the secret with
`APP_ENCRYPTION_KEY`, and stores the account as `connected`. The session is actually
exercised on the first claim (run by the worker); an expired/invalid session surfaces there
as `needs_reauth`, prompting you to reconnect.

## Security

- Secrets are stored only as ciphertext (`secret_ciphertext` + wrapped `secret_data_key`);
  they are never returned to the browser or written to logs (FR-008 / SC-004).
- Disconnecting an account deletes its stored secret.
