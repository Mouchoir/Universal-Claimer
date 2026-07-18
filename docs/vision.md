# Universal Claimer — Vision & Ideation

> Status: ideation. This document feeds the spec-kit `/specify` step. It captures the
> product intent, the confirmed technical reality, key decisions, and open questions.
> Everything here is subject to refinement in formal specs.

## 1. What it is

A platform where anyone can sign up, register their third-party accounts, and have the
system automatically perform recurring "claim" actions on their behalf:

- Claim free games (Epic Games weekly, Amazon Prime Gaming, GOG)
- Collect Microsoft Rewards
- Resubscribe to a Twitch channel using Twitch Prime
- (extensible to more services over time)

## 2. Confirmed technical reality (from research)

Six reference bots were analyzed (vogler/free-games-claimer, srhinos/primelooter,
Falyrion/Loot-Bot, TheNetsky/Microsoft-Rewards-Script, charlesbel/Microsoft-Rewards-Farmer,
kylefmohr/twitch_prime_autosub). Findings that shape the architecture:

- **No public OAuth exists for the claim action.** OAuth grants identity, not the right to
  act on a storefront. Every bot drives a logged-in browser session instead
  (Playwright / Selenium / nodriver-CDP).
- **Auth is session custody, not OAuth.** Bots either import already-authenticated cookies,
  or log in with stored credentials plus an auto-generated TOTP code.
- **Captcha handling is layered** (see decisions): an anti-detect browser prevents most
  challenges, a solving service handles the rest, and manual resolution is the last resort.
  Reference bots historically used human intervention via VNC — which we reject.
- **Headless Chromium triggers captchas.** We use CloakBrowser (source-patched Chromium),
  run headed via a virtual display (Xvfb) on the headless host, to evade detection.
- **The mature reference is TheNetsky/Microsoft-Rewards-Script**: per-account proxy,
  per-account persistent fingerprint, parallel clustering, a control API, and webhook
  notifications. This is the closest existing analogue to the target architecture.
- **Platform UI changes are the dominant cause of breakage** — one of the two Microsoft
  Rewards projects is already archived. Connectors must be treated as fragile, versioned,
  health-monitored modules.

## 3. Key decisions (made during ideation)

| Decision | Choice | Rationale |
|---|---|---|
| Project model | **Personal, open-source, self-hosted. No monetization.** | Operator self-hosts and is their own custodian; anyone can self-host the same code. Removes commercial/legal-entity and billing concerns. |
| Tenancy | **Single-user per deployment** | One instance serves one operator. Friends run their own Docker instance on their own PC/server. No multi-tenancy, no RLS complexity; auth reduces to a single admin login set at onboarding. |
| Distribution | **Docker Compose, deliberately minimal YAML** | `docker compose up` must Just Work. The YAML carries only what must exist before the app boots (DB connection, an app encryption key, port). Everything else is configured in the web portal. |
| Configuration | **Web onboarding wizard configures everything** | No hand-editing config files. First-run wizard collects: admin password, connected accounts, service selection + TOS consent, anti-captcha key, schedules. Stored (encrypted) in the DB. |
| Third-party account auth | **Hybrid per service** | Session import where possible (less custody, revocable); one-shot login + TOTP as fallback. |
| MVP scope | **Epic + Microsoft Rewards + Twitch Prime** | Covers the three headline use cases end-to-end. |
| Browser engine | **CloakBrowser via the official `cloakbrowser` npm package, headed via Xvfb** | Drop-in for Playwright; evades bot detection at the binary level so captchas rarely appear. The package auto-manages the Chromium binary (pre-downloaded into the worker image at build, ~535MB, signature+checksum verified); no manual binary path. Free v146 needs no key; Pro via `CLOAKBROWSER_LICENSE_KEY`. Requires an x86_64 host. Binary license: free for personal/commercial self-hosted use, redistribution restricted — so the operator's own build fetches it from CloakHQ (we never redistribute it). |
| Captcha strategy | **Layered: prevent (CloakBrowser) → auto-solve (anti-captcha.com) → manual last resort (no VNC)** | Minimizes challenges; solves the rest cheaply (~$1–2/1000); manual only as fallback, via screenshot+relay or handing back to the user's browser. |
| Proxy / IP isolation | **None for the POC/MVP; add later** | Running the operator's own few accounts from a home residential IP is low-risk and less bot-like than a datacenter. Per-account proxies required only when scaling to many accounts. |
| Worker host | **Self-hosted on a home NAS (x86_64), then optionally a bare VPS** | The workload is a "userbot" that managed PaaS ban. Own hardware = own AUP. NAS must be Intel/AMD (not ARM) for the CloakBrowser binary. |
| Data layer | **Bundled plain Postgres (no Supabase)** | Single-user tenancy makes Supabase Auth/RLS pointless, and a managed dependency conflicts with easy self-hosting. Postgres runs as a container in the compose. Auth = single admin login set at onboarding; realtime = Server-Sent Events (SSE) in the app. |

## 4. Architecture (proposed)

Everything below runs from a single Docker Compose stack on the operator's host:

```
Web app (Next.js: portal + onboarding wizard + SSE)
        │
        ▼
   Postgres  ◄── stores admin account, connected accounts (secrets encrypted),
        │        jobs, results, consent records
        ▼
Job orchestrator / queue
        │
   ┌────┼─────────────────────┬─────────────────────┐
   ▼                          ▼                     ▼
Worker: Epic          Worker: MS Rewards     Worker: Twitch   ← CloakBrowser
(fingerprint A)        (fingerprint B)       (fingerprint C)     (headed via Xvfb, x86_64)
```

- Single admin login, set during the first-run onboarding wizard (no external auth).
- Postgres stores the admin account, connected accounts (secrets encrypted), jobs,
  results, and consent records.
- Third-party secrets are protected by envelope encryption; the app encryption key comes
  from the compose env (YAML), so the key lives outside the database.
- Server-Sent Events (SSE) push job status to the dashboard (e.g. "captcha required",
  "claim succeeded"); the worker signals state changes via Postgres LISTEN/NOTIFY.
- Workers pull jobs, receive decrypted secrets just-in-time in memory, drive a CloakBrowser
  session (headed via Xvfb) through the relevant connector, and report results back.
  No proxies in the MVP (home IP).
- Each connector is an isolated, versioned plugin with its own health-check.

## 5. Security posture

### Hosting constraint (important)
The worker layer performs browser automation on behalf of user accounts — i.e. a
"userbot" workload. Managed PaaS providers ban this: Railway explicitly prohibits
"Userbots" and "VNC / Virtual Desktops"; most managed hosts can suspend on abuse
complaints from target platforms even without an explicit clause. Because this is a
personal, self-hosted project, the worker layer runs on the operator's own hardware
(a home NAS, x86_64), which sidesteps PaaS acceptable-use policies entirely. Do NOT use
VNC for the human captcha fallback (banned by some hosts and fragile); instead stream a
browser screenshot + relay inputs through the dashboard, or hand the challenge back to the
user's own browser and re-import cookies.

### User target-accounts (avoiding platform detection)
- Persistent, coherent browser fingerprint per target account (UA, timezone, locale,
  viewport), via CloakBrowser.
- Humanized delays; randomized run schedules (never all at midnight).
- No proxies in the MVP: the operator's own accounts run from a home residential IP, which
  is low-risk and less bot-like than a datacenter. Per-account residential proxies
  (~$3–15/GB) are a later addition, required only when scaling to many accounts.

### Platform (custody of user secrets)
- Envelope encryption at rest; the app encryption key is supplied via the compose env and
  lives outside Postgres. Secrets never in plaintext, logs, screenshots, or dumps.
- Worker gets the decrypted secret only in memory, only during a job.
- Minimize custody: prefer revocable session cookies over passwords.
- Being single-user and self-hosted, the operator is their own custodian; the trust
  surface is the operator's own host, not a shared multi-tenant service. No RLS needed.

## 6. Legal / TOS

- Automation + multi-accounting violates the TOS of Epic, Microsoft, Twitch, and Amazon.
  Real risk: suspension of the operator's own third-party accounts. This is used at the
  operator's own risk.
- Mandatory, service-specific TOS warning shown on every account-add for a service, with
  timestamped consent (Constitution Principle VI).
- As a personal, non-commercial, open-source project there is no paid service organizing
  violations for third parties; the commercial/legal-entity concerns of a hosted business
  do not apply. (Not legal advice.)

## 7. Monetization

None. This is a personal, open-source, self-hosted project. All services are available to
whoever self-hosts it; there is no free/paid tiering, no billing, no Stripe.

## 8. Open questions for `/specify` and `/plan`

- Session-import UX: browser extension vs guided manual export.
- Job scheduling/queue technology (worker pull model, retries, backoff).
- Cookie/session expiry handling and re-auth prompts.
- anti-captcha.com integration point and per-connector wiring.
- Data retention policy for secrets and job history.
- First-run bootstrapping: confirm the minimal set of values in the YAML/env (DB URL, app
  encryption key, port) vs the web wizard (everything else).

## 9. Non-goals (v1)

- Any action beyond claiming/collecting/resubscribing (no purchases, no transfers).
- Per-account proxies (deferred until scaling beyond the operator's own accounts).
- Monetization / billing.
- Mobile native apps (web first).
