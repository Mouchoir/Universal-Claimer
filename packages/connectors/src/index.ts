export * from "./connector.js";
export * from "./cookies.js";
export * from "./totp.js";
export * from "./registry.js";
export * from "./fingerprint.js";
export { EpicConnector } from "./epic/index.js";
export type { EpicPageDriver, EpicDriverFactory } from "./epic/index.js";
export { TwitchConnector } from "./twitch/index.js";
export type { TwitchPageDriver, TwitchDriverFactory } from "./twitch/index.js";
export { MsRewardsConnector } from "./msrewards/index.js";
export type { MsRewardsPageDriver, MsRewardsDriverFactory } from "./msrewards/index.js";
export { PrimeGamingConnector } from "./primegaming/index.js";
export type { PrimeGamingPageDriver, PrimeGamingDriverFactory, PrimeOffer } from "./primegaming/index.js";
export { defaultRegistry } from "./all.js";

// NOTE: the CloakBrowser factory (./browser.js) is intentionally NOT re-exported here — it
// pulls in `cloakbrowser`/Playwright. Import it from the "@uc/connectors/browser" subpath so
// the web app (which never launches a browser) keeps those out of its bundle.
