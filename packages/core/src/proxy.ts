const PROXY_SCHEMES = ["http:", "https:", "socks4:", "socks5:"];

/** Validate a proxy URL: supported scheme + host + explicit port. */
export function isValidProxyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return PROXY_SCHEMES.includes(u.protocol) && u.hostname.length > 0 && u.port.length > 0;
  } catch {
    return false;
  }
}

/** A display-safe form of a proxy URL: scheme://host:port, credentials stripped. */
export function maskProxy(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port}`;
  } catch {
    return "(invalid proxy)";
  }
}
