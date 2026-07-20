# Tasks: Per-Account Proxy & IP Isolation

- [X] T001 core: `isValidProxyUrl` + `maskProxy` + unit tests (`packages/core/src/proxy.ts`)
- [X] T002 schema: encrypted proxy columns on `connected_account` + `login_session`; migration 0004
- [X] T003 `CloakBrowserFactory` accepts a `proxy` option (injected at the worker; connectors unchanged)
- [X] T004 db data access: `createAccount`/`getAccountSecret` + login session carry sealed proxy
- [X] T005 worker: decrypt per-account proxy → per-run browser factory (claims + assisted login)
- [X] T006 web: connect + login-session APIs validate + seal proxy; connect UI proxy field
- [X] T007 docs `docs/operations/proxies.md`
- [X] T008 build + typecheck + tests
