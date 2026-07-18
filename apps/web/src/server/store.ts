import {
  createAdmin,
  getAdmin,
  getSecurityQuestions,
  replaceSecurityQuestions,
  updateAdminPassword,
  type Database,
} from "@uc/db";
import type { AdminRecord, AdminStore, SecurityQ } from "./admin-service.js";

/** Postgres-backed AdminStore used in production (the fake is used in unit tests). */
export class DrizzleAdminStore implements AdminStore {
  constructor(private readonly db: Database) {}

  getAdmin(): Promise<AdminRecord | null> {
    return getAdmin(this.db);
  }
  createAdmin(passwordHash: string, recoveryEnabled: boolean): Promise<AdminRecord> {
    return createAdmin(this.db, passwordHash, recoveryEnabled);
  }
  async updatePassword(passwordHash: string): Promise<void> {
    await updateAdminPassword(this.db, passwordHash);
  }
  getSecurityQuestions(): Promise<SecurityQ[]> {
    return getSecurityQuestions(this.db);
  }
  async replaceSecurityQuestions(qs: SecurityQ[]): Promise<void> {
    await replaceSecurityQuestions(this.db, qs);
  }
}
