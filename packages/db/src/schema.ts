import {
  boolean,
  customType,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Raw bytea column for encrypted blobs. */
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Schema for the single-user deployment (data-model.md). No tenant/user_id columns and no
 * RLS: the isolation boundary is the deployment itself.
 */

export const admin = pgTable(
  "admin",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Constant column with a unique index enforces a single admin row.
    singleton: boolean("singleton").notNull().default(true),
    passwordHash: text("password_hash").notNull(),
    recoveryEnabled: boolean("recovery_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ singletonUq: uniqueIndex("admin_singleton_uq").on(t.singleton) }),
);

/**
 * Small key/value store for deployment-level facts that are neither configuration the operator
 * types nor per-account data: the fingerprint of the encryption key this database was written
 * with, and the last release whose notes have been shown.
 *
 * In the database rather than a file because both must survive the container being replaced,
 * which is the whole point of the things being recorded here.
 */
export const appSetting = pgTable("app_setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const securityQuestion = pgTable("security_question", {
  id: uuid("id").defaultRandom().primaryKey(),
  position: smallint("position").notNull(), // 1..3
  question: text("question").notNull(),
  answerHash: text("answer_hash").notNull(),
});

export const service = pgTable("service", {
  id: text("id").primaryKey(), // e.g. "epic"
  displayName: text("display_name").notNull(),
  connectorVersion: text("connector_version").notNull(),
  tosWarning: text("tos_warning").notNull(),
  methods: text("methods").array().notNull(),
});

export const connectedAccount = pgTable(
  "connected_account",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id),
    method: text("method").notNull(), // session_import | credential_totp
    secretCiphertext: bytea("secret_ciphertext").notNull(),
    secretDataKey: bytea("secret_data_key").notNull(),
    fingerprint: jsonb("fingerprint").notNull(),
    // Non-secret per-account connector config (e.g. { channel } for Twitch). Plain JSON.
    config: jsonb("config").notNull().default({}),
    // The account's own username on the service, observed during runs (e.g. "ExampleUser").
    displayName: text("display_name"),
    // Non-secret facts observed during runs: { entitlements: [{ kind, channel, endsAt }] }.
    // Surfaced in the dashboard (e.g. an active Prime sub and when it ends).
    facts: jsonb("facts").notNull().default({}),
    factsUpdatedAt: timestamp("facts_updated_at", { withTimezone: true }),
    // Optional per-account proxy URL, envelope-encrypted (may embed credentials).
    proxyCiphertext: bytea("proxy_ciphertext"),
    proxyDataKey: bytea("proxy_data_key"),
    status: text("status").notNull().default("connected"), // connected | needs_reauth
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // One account per service (FR-006a).
  (t) => ({ serviceUq: uniqueIndex("connected_account_service_uq").on(t.serviceId) }),
);

export const consentRecord = pgTable("consent_record", {
  id: uuid("id").defaultRandom().primaryKey(),
  serviceId: text("service_id")
    .notNull()
    .references(() => service.id),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  tosWarningSnapshot: text("tos_warning_snapshot").notNull(),
});

export const job = pgTable("job", {
  id: uuid("id").defaultRandom().primaryKey(),
  connectedAccountId: uuid("connected_account_id")
    .notNull()
    .references(() => connectedAccount.id, { onDelete: "cascade" }),
  // queued | running | requires_human_action | succeeded | failed
  state: text("state").notNull().default("queued"),
  // What started this run: the operator pressing Run claim, or the scheduler. Worth recording —
  // "did my automation actually fire?" cannot be answered from the outcome alone.
  trigger: text("trigger").notNull().default("manual"), // manual | scheduled
  // claimed | nothing_to_claim | failed | reauth_needed (null until terminal)
  outcome: text("outcome"),
  summary: text("summary"), // human-readable, never secrets
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const notificationTarget = pgTable(
  "notification_target",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    singleton: boolean("singleton").notNull().default(true),
    kind: text("kind").notNull(), // discord | telegram | ntfy
    configCiphertext: bytea("config_ciphertext").notNull(),
    configDataKey: bytea("config_data_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ singletonUq: uniqueIndex("notification_target_singleton_uq").on(t.singleton) }),
);

/**
 * Per-connector run-outcome accounting feeding the health monitor (T012a / Principle I):
 * a rolling record of runs so the monitor can compute a failure rate and auto-disable a
 * connector whose UI has drifted.
 */
export const connectorRun = pgTable("connector_run", {
  id: uuid("id").defaultRandom().primaryKey(),
  serviceId: text("service_id").notNull(),
  connectorVersion: text("connector_version").notNull(),
  success: boolean("success").notNull(),
  outcome: text("outcome").notNull(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
});

export const connectorState = pgTable("connector_state", {
  serviceId: text("service_id").primaryKey(),
  disabled: boolean("disabled").notNull().default(false),
  disabledReason: text("disabled_reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Recurring claim schedule for a connected account (feature 002). At most one per account;
 * removed with the account. Times are in the deployment's local timezone.
 */
export const schedule = pgTable(
  "schedule",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectedAccountId: uuid("connected_account_id")
      .notNull()
      .references(() => connectedAccount.id, { onDelete: "cascade" }),
    frequency: text("frequency").notNull(), // daily | weekly
    hour: smallint("hour").notNull(), // 0..23
    minute: smallint("minute").notNull(), // 0..59
    dayOfWeek: smallint("day_of_week"), // 0..6 (Sun..Sat); null for daily
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Randomize each run's time by up to ±N minutes so automatic claims don't fire at a
     * machine-perfect hour every day, which is an obvious automation signal to the services
     * (Constitution Principle VII). 0 disables randomization.
     */
    jitterMinutes: smallint("jitter_minutes").notNull().default(0),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ accountUq: uniqueIndex("schedule_account_uq").on(t.connectedAccountId) }),
);

/**
 * Assisted-login session: the operator logs in inside the instance-controlled browser and
 * cookies are captured automatically (docs/design/assisted-login.md). In headless deployments
 * the login page is relayed over the CDP screencast WebSocket (docs/design/cdp-relay.md) —
 * frames and input are event-driven and never persisted, so there is no frame column or input
 * table.
 */
export const loginSession = pgTable("login_session", {
  id: uuid("id").defaultRandom().primaryKey(),
  serviceId: text("service_id")
    .notNull()
    .references(() => service.id),
  // pending | awaiting_user | connected | timed_out | failed
  status: text("status").notNull().default("pending"),
  // Operator has finished logging in and asked to capture the session.
  confirmed: boolean("confirmed").notNull().default(false),
  // Per-account connector config carried through assisted login (e.g. { channel }).
  config: jsonb("config").notNull().default({}),
  // Optional proxy (encrypted) carried through assisted login onto the created account.
  proxyCiphertext: bytea("proxy_ciphertext"),
  proxyDataKey: bytea("proxy_data_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per item actually obtained by a claim (a free game, a Prime sub, a points set). Kept
 * as structured rows — rather than parsed out of a job's summary text — so the dashboard can
 * list what was claimed and compute reliable stats over time.
 */
export const claimEvent = pgTable("claim_event", {
  id: uuid("id").defaultRandom().primaryKey(),
  connectedAccountId: uuid("connected_account_id")
    .notNull()
    .references(() => connectedAccount.id, { onDelete: "cascade" }),
  serviceId: text("service_id").notNull(),
  // The job that obtained it; kept for traceability. Null if the job row is gone.
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  kind: text("kind").notNull(), // game | prime_sub | points
  title: text("title").notNull(),
  // Where the item must be redeemed when it is not delivered in place (GOG, Epic, …), and the
  // deadline to do it — Prime Gaming keys stop working when the offer ends.
  platform: text("platform"),
  redeemBy: timestamp("redeem_by", { withTimezone: true }),
  // The redemption key, envelope-encrypted like every other secret (Principle II). Null when the
  // item needed no key.
  codeCiphertext: bytea("code_ciphertext"),
  codeDataKey: bytea("code_data_key"),
  // Operator has redeemed it; lets the dashboard stop nagging about it.
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Postgres channel used for LISTEN/NOTIFY job-event relay to the web app's SSE stream. */
export const JOB_EVENTS_CHANNEL = "job_events";
