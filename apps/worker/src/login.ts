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
  clearLoginFrame,
  createAccount,
  drainInputs as dbDrainInputs,
  setLoginFrame,
  setLoginStatus,
  type Database,
  type InputEvent,
} from "@uc/db";
import type { LoginDeps, LoginJob } from "./run-login.js";

async function applyInput(page: Page, ev: InputEvent): Promise<void> {
  const p = ev.payload;
  switch (ev.kind) {
    case "click":
      await page.mouse.click(Number(p.x), Number(p.y));
      break;
    case "type":
      await page.keyboard.type(String(p.text ?? ""));
      break;
    case "key":
      await page.keyboard.press(String(p.key ?? ""));
      break;
    case "scroll":
      await page.mouse.wheel(0, Number(p.dy ?? 0));
      break;
  }
}

/**
 * Build the production dependencies for {@link runLogin}: launch CloakBrowser at the
 * connector's login page, relay screenshot frames + operator inputs, and on success capture
 * the cookies and store them as a session_import account (docs/design/assisted-login.md).
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

  let handle: SessionHandle | null = null;
  const pageOf = async (ctxt: BrowserContext): Promise<Page> => {
    const pages = ctxt.pages();
    return pages[0] ?? (await ctxt.newPage());
  };

  return {
    openSession: async () => {
      handle = await browser.launch(defaultFingerprint());
      const page = await pageOf(handle.context);
      await page.goto(connector.loginUrl, { waitUntil: "domcontentloaded" });
      return handle;
    },
    closeSession: async (session) => {
      await clearLoginFrame(db, job.sessionId);
      await browser.close(session as SessionHandle);
    },
    captureFrame: async (session, sessionId) => {
      const page = await pageOf((session as SessionHandle).context);
      const png = await page.screenshot();
      await setLoginFrame(db, sessionId, png);
    },
    drainInputs: async (session, sessionId) => {
      const events = await dbDrainInputs(db, sessionId);
      if (events.length === 0) return;
      const page = await pageOf((session as SessionHandle).context);
      for (const ev of events) await applyInput(page, ev);
    },
    isLoggedIn: async (session) => connector.isLoggedIn(session as SessionHandle, ctx),
    captureCookiesAndStore: async (session) => {
      const cookies = await connector.extractCookies(session as SessionHandle);
      const sealed = sealSecret(JSON.stringify({ cookies }), masterKey);
      await createAccount(db, {
        serviceId: job.serviceId,
        method: "session_import",
        secretCiphertext: sealed.ciphertext,
        secretDataKey: sealed.wrappedDataKey,
        fingerprint: defaultFingerprint(),
      });
    },
    setStatus: async (sessionId, status) => setLoginStatus(db, sessionId, status),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
