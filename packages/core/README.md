# @uc/core

Shared foundations used across the app, worker, and connectors.

## Modules

- **config** — `loadConfig(env)`: Zod-validated environment (`APP_ENCRYPTION_KEY`,
  `DATABASE_URL`, `PORT`). Only boot-critical values live here; everything else is set in the
  onboarding wizard.
- **crypto** — envelope encryption (AES-256-GCM). `loadMasterKey`, `sealSecret`,
  `openSecret`/`openSecretString`, `safeEqual`. A fresh per-record data key encrypts each
  secret and is wrapped by the master key. `openSecret` throws `EncryptionKeyMismatchError`
  when the key is wrong or the ciphertext was tampered with.
- **logger** — `createLogger()` + `redact()`: structured JSON logging that redacts any
  secret-looking field (password, cookie, token, totp, ciphertext, …). Never log raw
  secrets; pass objects and let the logger redact.
- **captcha** — `CaptchaSolver` interface with `AntiCaptchaSolver` (anti-captcha.com) and
  `NullCaptchaSolver`. Solvers return `null` on failure so callers fall back to the
  human-action flow.

## Usage

```ts
import { loadConfig, loadMasterKey, sealSecret, openSecretString } from "@uc/core";

const cfg = loadConfig();
const key = loadMasterKey(cfg.APP_ENCRYPTION_KEY);
const sealed = sealSecret("cookie-jar", key); // -> { ciphertext, wrappedDataKey }
const plain = openSecretString(sealed, key);
```

## Test

```bash
corepack pnpm --filter @uc/core test   # or: corepack pnpm test
```
