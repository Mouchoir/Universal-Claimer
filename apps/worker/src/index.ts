import {
  AntiCaptchaSolver,
  NullCaptchaSolver,
  createLogger,
  loadConfig,
  loadMasterKey,
  openSecretString,
  type CaptchaSolver,
} from "@uc/core";
import {
  ConnectorRegistry,
  EpicConnector,
  defaultFingerprint,
  generateTotp,
  type ConnectorContext,
  type Fingerprint,
} from "@uc/connectors";
import { CloakBrowserFactory } from "@uc/connectors/browser";
import {
  CLAIM_QUEUE,
  LOGIN_QUEUE,
  createDb,
  createQueue,
  evaluateConnectorHealth,
  finishJob,
  getAccountSecret,
  getNotificationTarget,
  markRequiresHumanAction,
  markRunning,
  notifyJobEvent,
  recordConnectorRun,
  updateAccountStatus,
  type ClaimJobData,
  type LoginJobData,
} from "@uc/db";
import { deliver, type NotificationKind } from "@uc/notifications";
import { reconcileInterruptedJobs } from "./reconcile.js";
import { runClaim, type ClaimJobDeps, type LoadedAccount } from "./run-claim.js";
import { runLogin } from "./run-login.js";
import { makeLoginDeps } from "./login.js";

const log = createLogger({ name: "worker" });

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const masterKey = loadMasterKey(cfg.APP_ENCRYPTION_KEY);
  const { db, pool, close } = createDb(cfg.DATABASE_URL);

  const registry = new ConnectorRegistry();
  registry.register(new EpicConnector());

  const captcha: CaptchaSolver = process.env.ANTI_CAPTCHA_KEY
    ? new AntiCaptchaSolver({ apiKey: process.env.ANTI_CAPTCHA_KEY })
    : new NullCaptchaSolver();

  // CloakBrowser manages its own binary (auto-downloaded, or pre-baked in the Docker image).
  const browserFactory = new CloakBrowserFactory({
    headed: true,
    ...(process.env.CLOAKBROWSER_LICENSE_KEY
      ? { licenseKey: process.env.CLOAKBROWSER_LICENSE_KEY }
      : {}),
  });

  const makeContext = (): ConnectorContext => ({
    browser: browserFactory,
    captcha,
    totp: generateTotp,
    emit: (event) => {
      // US3: surface events to logs. US4 wires pause/resume + webhook delivery.
      log.info("connector event", { event: event.type });
    },
    log,
  });

  const deps: ClaimJobDeps = {
    getConnector: (serviceId) => registry.require(serviceId),
    loadAccount: async (id): Promise<LoadedAccount | null> => {
      const row = await getAccountSecret(db, id);
      if (!row) return null;
      const secretJson = openSecretString(
        { ciphertext: row.secretCiphertext, wrappedDataKey: row.secretDataKey },
        masterKey,
      );
      return {
        method: row.method,
        serviceId: row.serviceId,
        fingerprint: (row.fingerprint as Fingerprint) ?? defaultFingerprint(),
        secretJson,
      };
    },
    markRunning: async (jobId) => {
      await markRunning(db, jobId);
      await notifyJobEvent(pool);
    },
    finish: async (jobId, outcome, summary) => {
      if (outcome === "requires_human_action") return; // handled by pauseForHumanAction
      await finishJob(db, jobId, outcome, summary);
      await notifyJobEvent(pool);
    },
    pauseForHumanAction: async (jobId) => {
      await markRequiresHumanAction(db, jobId);
      await notifyJobEvent(pool);
    },
    markNeedsReauth: async (accountId) => updateAccountStatus(db, accountId, "needs_reauth"),
    recordRun: async (serviceId, version, success, outcome) => {
      await recordConnectorRun(db, { serviceId, connectorVersion: version, success, outcome });
      await evaluateConnectorHealth(db, serviceId);
    },
    notify: async (message) => {
      const target = await getNotificationTarget(db);
      if (!target) return;
      const url = JSON.parse(
        openSecretString(
          { ciphertext: target.configCiphertext, wrappedDataKey: target.configDataKey },
          masterKey,
        ),
      ).url as string;
      await deliver({ kind: target.kind as NotificationKind, url }, message);
    },
    makeContext,
  };

  const reconciled = await reconcileInterruptedJobs(db);
  if (reconciled > 0) log.warn("reconciled interrupted jobs on startup", { count: reconciled });

  const boss = await createQueue(cfg.DATABASE_URL);
  await boss.work<ClaimJobData>(CLAIM_QUEUE, async (pgJobs) => {
    for (const pgJob of pgJobs) {
      await runClaim(deps, pgJob.data);
    }
  });

  await boss.work<LoginJobData>(LOGIN_QUEUE, async (pgJobs) => {
    for (const pgJob of pgJobs) {
      const loginDeps = makeLoginDeps({
        db,
        registry,
        browser: browserFactory,
        ctx: makeContext(),
        masterKey,
        job: pgJob.data,
      });
      await runLogin(loginDeps, pgJob.data);
    }
  });

  log.info("worker started", { queue: CLAIM_QUEUE, browser: "cloakbrowser" });

  const shutdown = async () => {
    log.info("worker shutting down");
    await boss.stop();
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err: unknown) => {
    log.error("worker crashed", { error: String(err) });
    process.exit(1);
  });
}
