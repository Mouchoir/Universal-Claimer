import { ConnectorRegistry } from "./registry.js";
import { EpicConnector } from "./epic/index.js";
import { TwitchConnector } from "./twitch/index.js";

/**
 * The registry of all built-in connectors. Constructing them is cheap and pulls in no
 * browser runtime (the CloakBrowser factory lives at the @uc/connectors/browser subpath), so
 * both the worker (to run) and the web app (to read config fields / methods) can use this.
 */
export function defaultRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(new EpicConnector());
  registry.register(new TwitchConnector());
  return registry;
}
