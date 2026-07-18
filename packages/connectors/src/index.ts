export * from "./connector.js";
export * from "./cookies.js";
export * from "./totp.js";
export * from "./registry.js";
export * from "./fingerprint.js";
export { EpicConnector } from "./epic/index.js";
export type { EpicPageDriver, EpicDriverFactory } from "./epic/index.js";

// NOTE: the CloakBrowser factory (./browser.js) is intentionally NOT re-exported here — it
// pulls in `cloakbrowser`/Playwright. Import it from the "@uc/connectors/browser" subpath so
// the web app (which never launches a browser) keeps those out of its bundle.
