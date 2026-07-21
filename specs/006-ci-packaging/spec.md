# Feature Specification: CI & Packaging / Hardening

**Feature Branch**: `006-ci-packaging`

**Created**: 2026-07-18

**Status**: Draft

**Input**: Make the project self-hostable by third parties and automate the full test suite.

## Overview

Operational hardening so anyone can self-host and so the whole test suite runs automatically:
- **CI** (GitHub Actions): install → build/typecheck → unit+contract tests → gated DB
  integration tests (against a Postgres service) → web production build, on every push/PR. This
  is the automated "run all the tests" gate.
- **Migrations on `docker compose up`**: a one-shot `migrate` service applies migrations +
  seeds before web/worker start, so the stack is correct out of the box.
- **Health endpoint + healthchecks**: `/api/health` (DB reachability) wired to the web
  container healthcheck.
- **Install docs**: a clear self-host quickstart.

## Requirements

- **FR-001**: CI MUST run `build`, `test`, and the web build on every push/PR, and MUST run
  the gated DB integration tests against a real Postgres (setting `DATABASE_URL_TEST`).
- **FR-002**: CI MUST use the committed lockfile (`--frozen-lockfile`) for reproducibility.
- **FR-003**: `docker compose up` MUST apply migrations + seed before web/worker accept work
  (a one-shot migrate service that both depend on).
- **FR-004**: The web app MUST expose an unauthenticated `/api/health` returning DB
  reachability; the web container healthcheck MUST use it.
- **FR-005**: A root `verify` script MUST run build + tests locally in one command.
- **FR-006**: A self-host quickstart MUST document the minimal steps (`.env`, `compose up`).

## Success Criteria

- **SC-001**: CI is green on a clean checkout (install → build → tests → web build).
- **SC-002**: `docker compose up` on a fresh host reaches a working app with the schema
  applied, no manual migration step.
- **SC-003**: `/api/health` returns `{ ok, db }` and the container is marked healthy when the
  DB is reachable.

## Out of Scope

- Publishing images to a registry; Kubernetes/Helm; blue-green deploy.
