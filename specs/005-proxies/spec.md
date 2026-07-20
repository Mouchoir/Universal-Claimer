# Feature Specification: Per-Account Proxy & IP Isolation

**Feature Branch**: `005-proxies`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Per-account proxy and IP isolation"

## Overview

Let the operator assign a proxy per connected account so different accounts don't all act
from the same IP — the platform-flagging risk raised from the start (Constitution Principle
VII, deferred at MVP). Combined with the already-persistent per-account fingerprint, each
account gets a coherent, isolated network+browser identity. Proxies are optional and
bring-your-own (the operator supplies a proxy URL).

## Clarifications

### Session 2026-07-18

- Q: Where does the proxy come from? → A: Bring-your-own — the operator pastes a proxy URL
  (`http(s)://[user:pass@]host:port` or `socks5://...`). No proxy provider is bundled.
- Q: Is the proxy sensitive? → A: Yes (it may embed credentials) → stored **encrypted**, like
  the account secret; never returned in plaintext.
- Q: How is it applied? → A: The worker launches CloakBrowser with the account's proxy for
  every claim/assisted-login run. Connectors are unchanged (proxy injected at the worker).
- Q: Optional? → A: Yes. No proxy → runs from the host IP as today.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Assign a proxy to an account (Priority: P1)

When connecting (or editing) an account, the operator can optionally provide a proxy URL. It
is validated, stored encrypted, and used for that account's runs.

**Acceptance Scenarios**:

1. **Given** the connect flow, **When** the operator provides a valid proxy URL, **Then** it
   is stored encrypted and the account uses it.
2. **Given** an invalid proxy URL, **When** submitted, **Then** it is rejected with a clear
   message.
3. **Given** a connected account, **When** the operator views it, **Then** the proxy is never
   shown in plaintext (masked / host only).
4. **Given** no proxy is provided, **When** the account runs, **Then** it uses the host IP
   (unchanged behavior).

---

### User Story 2 - Runs use the account's proxy (Priority: P1)

Claims and assisted-login sessions for an account are routed through that account's proxy.

**Acceptance Scenarios**:

1. **Given** an account with a proxy, **When** a claim runs, **Then** CloakBrowser launches
   with that proxy.
2. **Given** an account with a proxy, **When** an assisted-login session runs, **Then** the
   login browser also uses that proxy.
3. **Given** two accounts with different proxies, **When** both run, **Then** each uses its own
   proxy (no shared IP).

### Edge Cases

- Proxy unreachable / auth fails at launch: the run reports `failed` with a readable,
  secret-free reason (the proxy URL/credentials are never in the message or logs).
- A datacenter proxy shared across accounts is discouraged in docs (residential recommended
  where the platform is sensitive) but not enforced.

## Requirements *(mandatory)*

- **FR-001**: An account MAY have an optional proxy URL, validated for scheme+host+port.
- **FR-002**: The proxy MUST be stored encrypted at rest (envelope encryption) and never
  returned in plaintext or written to logs/errors (Principle II).
- **FR-003**: The worker MUST launch CloakBrowser with the account's proxy for claims and
  assisted-login runs; no proxy → host IP.
- **FR-004**: Connectors MUST NOT need changes — the proxy is injected at the worker/browser
  layer (Principle I).
- **FR-005**: Each account keeps its own persistent fingerprint + proxy = one coherent
  identity (Principle VII).
- **FR-006**: Invalid proxy URLs MUST be rejected at connect time.

## Success Criteria *(mandatory)*

- **SC-001**: A proxy can be set on an account and is stored only as ciphertext.
- **SC-002**: A claim/login run for that account launches the browser with the proxy.
- **SC-003**: Adding proxies requires no connector changes.

## Assumptions

- Bring-your-own proxy; proxy provisioning/rotation services are out of scope.
- Proxy applies at the browser-context level (CloakBrowser `proxy` launch option).

## Out of Scope

- Bundled proxy pools, automatic rotation, health-checking proxies, geo selection UI.
