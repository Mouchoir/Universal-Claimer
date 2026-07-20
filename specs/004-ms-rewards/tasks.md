# Tasks: Microsoft Rewards Daily Tasks Connector

**Tests**: mandatory (constitution).

- [X] T001 MS Rewards driver (`isAuthenticated`, `remainingSearches`, `search(query)`, `getCookies`, `goto`, `loginWithPassword`) in `packages/connectors/src/msrewards/driver.ts`
- [X] T002 Search-term source + `pickQuery(rand)` (varied credible queries) in `packages/connectors/src/msrewards/queries.ts`
- [X] T003 `MsRewardsConnector` (Connector + InteractiveLogin, no config, claim = run daily searches with humanized delays + captcha layering; injectable sleep/rand) in `packages/connectors/src/msrewards/index.ts`
- [X] T004 [P] Contract tests: claim (nothing/partial/claimed/reauth/captcha) + auth with fake driver
- [X] T005 Register in `defaultRegistry()`; seed the `microsoft` service
- [X] T006 Docs `docs/operations/microsoft-rewards.md`
- [X] T007 Build + typecheck + tests
