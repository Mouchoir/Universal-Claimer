import { hashSecret, normalizeAnswer, verifySecret } from "./auth.js";

/**
 * Admin onboarding / auth / recovery logic (US1), written against a small store interface so
 * it is unit-testable with an in-memory fake and reused by both the API routes and the
 * host-side reset CLI.
 */

export interface AdminRecord {
  id: string;
  passwordHash: string;
  recoveryEnabled: boolean;
}

export interface SecurityQ {
  position: number;
  question: string;
  answerHash: string;
}

export interface AdminStore {
  getAdmin(): Promise<AdminRecord | null>;
  createAdmin(passwordHash: string, recoveryEnabled: boolean): Promise<AdminRecord>;
  updatePassword(passwordHash: string): Promise<void>;
  getSecurityQuestions(): Promise<SecurityQ[]>;
  replaceSecurityQuestions(qs: SecurityQ[]): Promise<void>;
}

export class SetupAlreadyDoneError extends Error {
  constructor() {
    super("setup already completed");
    this.name = "SetupAlreadyDoneError";
  }
}
export class RecoveryDisabledError extends Error {
  constructor() {
    super("password recovery is not enabled");
    this.name = "RecoveryDisabledError";
  }
}
export class AnswersIncorrectError extends Error {
  constructor() {
    super("security answers are incorrect");
    this.name = "AnswersIncorrectError";
  }
}

export interface RecoveryQuestionInput {
  question: string;
  answer: string;
}

export interface SetupInput {
  password: string;
  /** When present, exactly three questions enable password recovery. */
  recovery?: RecoveryQuestionInput[];
}

export async function isSetupNeeded(store: AdminStore): Promise<boolean> {
  return (await store.getAdmin()) === null;
}

/** First-run setup: create the single admin and, optionally, recovery questions (FR-001/002a). */
export async function setupAdmin(store: AdminStore, input: SetupInput): Promise<void> {
  if (await store.getAdmin()) throw new SetupAlreadyDoneError();

  const recoveryEnabled = input.recovery !== undefined;
  if (recoveryEnabled && input.recovery!.length !== 3) {
    throw new Error("exactly 3 security questions are required to enable recovery");
  }
  if (!input.password || input.password.length < 8) {
    throw new Error("password must be at least 8 characters");
  }

  const passwordHash = await hashSecret(input.password);
  await store.createAdmin(passwordHash, recoveryEnabled);

  if (recoveryEnabled) {
    const qs: SecurityQ[] = await Promise.all(
      input.recovery!.map(async (q, i) => ({
        position: i + 1,
        question: q.question,
        answerHash: await hashSecret(normalizeAnswer(q.answer)),
      })),
    );
    await store.replaceSecurityQuestions(qs);
  }
}

/** A recovery question as shown on the reset form — the prompt only, never the answer hash. */
export interface RecoveryPrompt {
  position: number;
  question: string;
}

/**
 * The three questions to display on the reset form, in order. Empty when recovery is off.
 *
 * The caller for this is unauthenticated by necessity: it is the "I forgot my password" screen,
 * and an answer cannot be given to a question the operator cannot see. So the questions are
 * readable by anyone who can reach the portal — which is the accepted trade of this recovery
 * mechanism, and the reason the answers are hashed rather than the questions kept secret.
 */
export async function listRecoveryQuestions(store: AdminStore): Promise<RecoveryPrompt[]> {
  const admin = await store.getAdmin();
  if (!admin || !admin.recoveryEnabled) return [];
  return (await store.getSecurityQuestions())
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((q) => ({ position: q.position, question: q.question }));
}

/** Verify a login password against the admin hash (FR-002). */
export async function verifyLogin(store: AdminStore, password: string): Promise<boolean> {
  const admin = await store.getAdmin();
  if (!admin) return false;
  return verifySecret(admin.passwordHash, password);
}

/**
 * Reset the password by answering all three security questions correctly (FR-002a).
 * Throws RecoveryDisabledError if recovery is off, AnswersIncorrectError if any answer fails.
 */
export async function recoverPassword(
  store: AdminStore,
  answers: string[],
  newPassword: string,
): Promise<void> {
  const admin = await store.getAdmin();
  if (!admin || !admin.recoveryEnabled) throw new RecoveryDisabledError();

  const qs = await store.getSecurityQuestions();
  if (qs.length !== 3 || answers.length !== 3) throw new RecoveryDisabledError();

  for (let i = 0; i < 3; i++) {
    const q = qs.find((x) => x.position === i + 1);
    const provided = answers[i];
    if (!q || provided === undefined || !(await verifySecret(q.answerHash, normalizeAnswer(provided)))) {
      throw new AnswersIncorrectError();
    }
  }
  if (!newPassword || newPassword.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  await store.updatePassword(await hashSecret(newPassword));
}

/** Host-side reset (CLI): set a new password unconditionally (FR-002b). */
export async function resetPassword(store: AdminStore, newPassword: string): Promise<void> {
  const admin = await store.getAdmin();
  if (!admin) throw new Error("no admin exists yet; complete first-run setup instead");
  if (!newPassword || newPassword.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  await store.updatePassword(await hashSecret(newPassword));
}
