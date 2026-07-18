import { asc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { service } from "./schema.js";

export interface ServiceRow {
  id: string;
  displayName: string;
  connectorVersion: string;
  tosWarning: string;
  methods: string[];
}

export async function listServices(db: Database): Promise<ServiceRow[]> {
  return db.select().from(service).orderBy(asc(service.displayName));
}

export async function getService(db: Database, id: string): Promise<ServiceRow | null> {
  const [row] = await db.select().from(service).where(eq(service.id, id)).limit(1);
  return row ?? null;
}
