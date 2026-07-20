# Tasks: Twitch Prime Resub Connector

**Tests**: mandatory. Each connector ships contract tests + docs (constitution).

## Phase 1: Per-account connector config (generic)

- [X] T001 Add `config` jsonb to `connected_account` + `login_session` (carry it through assisted login); migration
- [X] T002 Connector interface: `configFields?: ConfigField[]` + `claim(input, fingerprint, config, ctx)`; update Epic (ignores config)
- [X] T003 db data access: `createAccount`/`getAccountSecret` carry `config`; services API exposes `configFields`
- [X] T004 Worker `run-claim` + `login` wiring: load + pass `config`

## Phase 2: Twitch connector

- [X] T005 Twitch driver (`isAuthenticated`, `resubWithPrime(channel)`, `getCookies`, `goto`) in `packages/connectors/src/twitch/driver.ts`
- [X] T006 `TwitchConnector` (Connector + InteractiveLogin, `configFields=[channel]`, claim=resub) in `packages/connectors/src/twitch/index.ts`
- [X] T007 [P] Contract tests: authenticate + claim (subscribed/nothing/reauth/captcha) with fake driver
- [X] T008 Register Twitch in the worker registry; seed the `twitch` service

## Phase 3: Connect UI (generic config fields)

- [X] T009 Connect page renders connector `configFields`; connect API validates + stores config; assisted-login carries config
- [X] T010 [P] Schema/contract test for config validation

## Phase 4: Polish

- [X] T011 Docs `docs/operations/twitch.md`
- [X] T012 Build + typecheck + tests
