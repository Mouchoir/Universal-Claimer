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

/** Postgres channel used for LISTEN/NOTIFY job-event relay to the web app's SSE stream. */
export const JOB_EVENTS_CHANNEL = "job_events";
