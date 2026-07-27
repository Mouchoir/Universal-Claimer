import {
  AntiCaptchaSolver,
  NullCaptchaSolver,
  applyJitter,
  nextRunAfterExpiry,
  computeNextRun,
  createLogger,
  jitterSeconds,
  loadConfig,
  loadMasterKey,
  openSecretString,
  type CaptchaSolver,
} from "@uc/core";
import {
  defaultFingerprint,
  defaultRegistry,
  generateTotp,
  type ConnectorContext,
  type Fingerprint,
} from "@uc/connectors";
import { CloakBrowserFactory } from "@uc/connectors/browser";
import {
  CLAIM_QUEUE,
  LOGIN_QUEUE,
  SCHEDULER_QUEUE,
  claimSendOptions,
  createDb,
  createJob,
  createQueue,
  evaluateConnectorHealth,
  finishJob,
  getAccount,
  getAccountSecret,
  getLoginSession,
  getNotificationTarget,
  recordClaimEvents,
  updateAccountFacts,
  hasActiveJobForAccount,
  listDueSchedules,
  markRequiresHumanAction,
  markRunning,
  markScheduleRan,
  notifyJobEvent,
  recordConnectorRun,
  updateAccountStatus,
  type ClaimJobData,
  type LoginJobData,
  type ScheduleRow,
} from "@uc/db";
import { deliver, type NotificationKind } from "@uc/notifications";
import { reconcileInterruptedJobs } from "./reconcile.js";
import { runClaim, type ClaimJobDeps, type LoadedAccount } from "./run-claim.js";
import { runLogin } from "./run-login.js";
import { makeLoginDeps } from "./login.js";
import { runScheduler, type SchedulerDeps } from "./run-scheduler.js";

const log = createLogger({ name: "worker" });

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const masterKey = loadMasterKey(cfg.APP_ENCRYPTION_KEY);
  const { db, pool, close } = createDb(cfg.DATABASE_URL);

  const registry = defaultRegistry(); // Epic + Twitch

  const captcha: CaptchaSolver = process.env.ANTI_CAPTCHA_KEY
    ? new AntiCaptchaSolver({ apiKey: process.env.ANTI_CAPTCHA_KEY })
    : new NullCaptchaSolver();

  const licenseKey = process.env.CLOAKBROWSER_LICENSE_KEY;

  // CloakBrowser manages its own binary (auto-downloaded, or pre-baked in the Docker image).
  // A fresh factory per run bakes in that account's proxy (Principle VII: per-account IP).
  // Headed by default (best stealth; on a headless host it runs under Xvfb so no window
  // appears). Set WORKER_HEADED=false to run truly headless (e.g. a local desktop where a
  // popup window is unwanted — the operator then logs in via the in-page relay only).
  const headed = process.env.WORKER_HEADED !== "false";
  const makeBrowser = (proxy?: string): CloakBrowserFactory =>
    new CloakBrowserFactory({
      headed,
      ...(licenseKey ? { licenseKey } : {}),
      ...(proxy ? { proxy } : {}),
    });

  const makeContext = (proxy?: string): ConnectorContext => ({
    browser: makeBrowser(proxy),
    captcha,
    totp: generateTotp,
    emit: (event) => {
      log.info("connector event", { event: event.type });
    },
    log,
  });

  const openProxy = (
    ciphertext: Buffer | null,
    dataKey: Buffer | null,
  ): string | undefined => {
    if (!ciphertext || !dataKey) return undefined;
    return openSecretString({ ciphertext, wrappedDataKey: dataKey }, masterKey);
  };

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
        config: row.config ?? {},
        proxy: openProxy(row.proxyCiphertext, row.proxyDataKey),
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
    recordInsights: async ({ jobId, connectedAccountId, serviceId, claimedItems, accountFacts }) => {
      if (claimedItems?.length) {
        await recordClaimEvents(
          db,
          claimedItems.map((item) => ({
            connectedAccountId,
            serviceId,
            jobId,
            kind: item.kind,
            title: item.title,
          })),
        );
      }
      if (accountFacts) {
        await updateAccountFacts(db, connectedAccountId, {
          displayName: accountFacts.username,
          facts: accountFacts.entitlements ? { entitlements: accountFacts.entitlements } : undefined,
        });
      }
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
      const sess = await getLoginSession(db, pgJob.data.sessionId);
      const proxy = sess ? openProxy(sess.proxyCiphertext, sess.proxyDataKey) : undefined;
      const loginDeps = makeLoginDeps({
        db,
        registry,
        browser: makeBrowser(proxy),
        ctx: makeContext(proxy),
        masterKey,
        job: pgJob.data,
      });
      await runLogin(loginDeps, pgJob.data);
    }
  });

  // Scheduler: a pg-boss cron fires the tick every minute; the tick dispatches due claims.
  const schedulerDeps: SchedulerDeps = {
    now: () => new Date(),
    listDue: (now) => listDueSchedules(db, now),
    hasActiveJob: (accountId) => hasActiveJobForAccount(db, accountId),
    enqueueClaim: async (accountId) => {
      const account = await getAccount(db, accountId);
      if (!account) return false;
      const jobId = await createJob(db, accountId);
      await boss.send(
        CLAIM_QUEUE,
        { jobId, connectedAccountId: accountId, serviceId: account.serviceId },
        { ...claimSendOptions(accountId), startAfter: jitterSeconds() },
      );
      await notifyJobEvent(pool);
      return true;
    },
    advance: async (s: ScheduleRow, now: Date) => {
      // Randomize the next run within the account's configured window so automatic claims don't
      // fire at an identical time every day (an obvious automation signal).
      let next: Date;
      if (s.frequency === "on_expiry") {
        // Benefit-driven: re-read the entitlement the run just refreshed and aim at its new end
        // date. Unknown (nothing observed yet) → look again tomorrow.
        const account = await getAccount(db, s.connectedAccountId);
        const endsAt = account?.facts.entitlements?.find((e) => e.endsAt)?.endsAt;
        const parsed = endsAt ? Date.parse(endsAt) : NaN;
        next = Number.isFinite(parsed)
          ? nextRunAfterExpiry(new Date(parsed), s.jitterMinutes ?? 0)
          : new Date(now.getTime() + 86_400_000);
      } else {
        next = applyJitter(
          computeNextRun(s.frequency, s.hour, s.minute, s.dayOfWeek, now),
          s.jitterMinutes ?? 0,
        );
      }
      await markScheduleRan(db, s.id, now, next);
    },
  };
  await boss.work(SCHEDULER_QUEUE, async () => {
    const dispatched = await runScheduler(schedulerDeps);
    if (dispatched > 0) log.info("scheduler dispatched claims", { count: dispatched });
  });
  await boss.schedule(SCHEDULER_QUEUE, "* * * * *");

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
