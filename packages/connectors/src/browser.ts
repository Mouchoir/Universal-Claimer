import { launchContext } from "cloakbrowser";
import type { BrowserContext } from "playwright-core";
import type { BrowserFactory, Fingerprint, SessionHandle } from "./connector.js";

export interface CloakBrowserOptions {
  /**
   * Run headed (the default). On a headless host, run under Xvfb — anti-detect Chromium is
   * more detectable in true headless mode. Pass `headed: false` to force headless.
   */
  headed?: boolean;
  /** CloakBrowser Pro license key. The free v146 binary needs none. */
  licenseKey?: string;
  /** Optional proxy URL for this account (http(s)/socks). Injected by the worker. */
  proxy?: string;
}

/**
 * BrowserFactory backed by the official `cloakbrowser` package, which downloads and manages
 * the source-patched Chromium binary automatically (cached under ~/.cloakbrowser or
 * `CLOAKBROWSER_CACHE_DIR`). No manual binary path is required — the finished product bundles
 * the binary by pre-downloading it during the Docker build (see deploy/Dockerfile.worker).
 */
export class CloakBrowserFactory implements BrowserFactory {
  constructor(private readonly opts: CloakBrowserOptions = {}) {}

  async launch(fingerprint: Fingerprint): Promise<SessionHandle> {
    const context = await launchContext({
      headless: this.opts.headed === false,
      ...(this.opts.licenseKey ? { licenseKey: this.opts.licenseKey } : {}),
      ...(this.opts.proxy ? { proxy: this.opts.proxy } : {}),
      timezone: fingerprint.timezoneId,
      locale: fingerprint.locale,
      userAgent: fingerprint.userAgent,
      viewport: fingerprint.viewport,
    });
    // cloakbrowser is built on playwright-core; the returned context is a Playwright
    // BrowserContext (cast across the package boundary).
    return { context: context as unknown as BrowserContext };
  }

  async close(session: SessionHandle): Promise<void> {
    const browser = session.context.browser();
    await session.context.close();
    await browser?.close();
  }
}
