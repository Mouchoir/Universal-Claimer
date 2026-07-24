import type { BrowserContext, Page } from "playwright-core";
import { sealSecret } from "@uc/core";
import {
  defaultFingerprint,
  supportsInteractiveLogin,
  type BrowserFactory,
  type ConnectorContext,
  type ConnectorRegistry,
  type SessionHandle,
} from "@uc/connectors";
import {
  createAccount,
  getLoginSession,
  setLoginStatus,
  type Database,
} from "@uc/db";
import { startCdpRelay, type CdpRelay } from "./cdp-relay.js";
import type { LoginDeps, LoginJob } from "./run-login.js";

/** Read the headless-relay configuration from the environment (docs/design/cdp-relay.md). */
function relayConfig(): { enabled: boolean; webUrl: string; token: string } {
  return {
    enabled: process.env.LOGIN_RELAY_EMBED === "true",
    webUrl: process.env.RELAY_INTERNAL_URL ?? "ws://web:8080",
    token: process.env.RELAY_TOKEN ?? "",
  };
}

/**
 * Build the production dependencies for {@link runLogin}: launch CloakBrowser at the
 * connector's login page. In headless deployments (LOGIN_RELAY_EMBED=true) it also starts the
 * CDP screencast relay so the operator can log in from the wizard; locally the operator uses
 * the native window. On success it captures the cookies and stores them as a session_import
 * account (docs/design/assisted-login.md, cdp-relay.md).
 */
export function makeLoginDeps(args: {
  db: Database;
  registry: ConnectorRegistry;
  browser: BrowserFactory;
  ctx: ConnectorContext;
  masterKey: Buffer;
  job: LoginJob;
}): LoginDeps {
  const { db, registry, browser, ctx, masterKey, job } = args;
  const connector = registry.require(job.serviceId);
  if (!supportsInteractiveLogin(connector)) {
    throw new Error(`connector ${job.serviceId} does not support assisted login`);
  }

  const relayCfg = relayConfig();
  let handle: SessionHandle | null = null;
  let relay: CdpRelay | null = null;
  const pageOf = async (ctxt: BrowserContext): Promise<Page> => {
    const pages = ctxt.pages();
    return pages[0] ?? (await ctxt.newPage());
  };

  return {
    openSession: async () => {
      handle = await browser.launch(defaultFingerprint());
      const page = await pageOf(handle.context);
      await page.goto(connector.loginUrl, { waitUntil: "domcontentloaded" });
      if (relayCfg.enabled) {
        if (relayCfg.token) {
          relay = await startCdpRelay(handle.context, page, {
            webUrl: relayCfg.webUrl,
            token: relayCfg.token,
            sessionId: job.sessionId,
            log: ctx.log,
          });
        } else {
          ctx.log.warn("LOGIN_RELAY_EMBED set but RELAY_TOKEN missing; relay disabled");
        }
      }
      return handle;
    },
    closeSession: async (session) => {
      await relay?.stop();
      await browser.close(session as SessionHandle);
    },
    // Non-navigating: the loop must NOT reload the page while the operator is logging in.
    // Capture is triggered when the operator confirms they have finished.
    isLoggedIn: async () => {
      const s = await getLoginSession(db, job.sessionId);
      return s?.confirmed ?? false;
    },
    captureCookiesAndStore: async (session) => {
      const cookies = await connector.extractCookies(session as SessionHandle);
      const sealed = sealSecret(JSON.stringify({ cookies }), masterKey);
      const loginSession = await getLoginSession(db, job.sessionId);
      await createAccount(db, {
        serviceId: job.serviceId,
        method: "session_import",
        secretCiphertext: sealed.ciphertext,
        secretDataKey: sealed.wrappedDataKey,
        fingerprint: defaultFingerprint(),
        config: loginSession?.config ?? {},
        proxyCiphertext: loginSession?.proxyCiphertext ?? null,
        proxyDataKey: loginSession?.proxyDataKey ?? null,
      });
    },
    setStatus: async (sessionId, status) => setLoginStatus(db, sessionId, status),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
