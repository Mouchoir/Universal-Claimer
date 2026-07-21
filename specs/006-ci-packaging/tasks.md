# Tasks: CI & Packaging / Hardening

- [X] T001 GitHub Actions CI (`.github/workflows/ci.yml`): install (frozen) → build → web typecheck → tests (incl. gated DB integration on a Postgres service) → web build
- [X] T002 One-shot `migrate` service in `deploy/docker-compose.yml`; web + worker depend on it (service_completed_successfully)
- [X] T003 `GET /api/health` (DB reachability) + web container healthcheck
- [X] T004 Root `verify` script (build + web typecheck + tests)
- [X] T005 Self-host quickstart: README section + `docs/operations/deploy.md`
- [X] T006 Verify locally (build + typecheck + tests) and against a disposable Postgres
