import type { Connector } from "./connector.js";

/**
 * Registry of available connectors, keyed by service id. The app and worker resolve
 * connectors by id here — they never import a concrete connector directly (Principle I).
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    if (this.connectors.has(connector.id)) {
      throw new Error(`Connector already registered: ${connector.id}`);
    }
    this.connectors.set(connector.id, connector);
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  require(id: string): Connector {
    const connector = this.get(id);
    if (!connector) throw new Error(`Unknown connector: ${id}`);
    return connector;
  }

  ids(): string[] {
    return [...this.connectors.keys()];
  }
}
