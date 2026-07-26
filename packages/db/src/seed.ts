import type { Database } from "./client.js";
import { service } from "./schema.js";

/** Service catalog seeded into the DB (not user-created). Epic ships with this feature. */
export const SEED_SERVICES = [
  {
    id: "epic",
    displayName: "Epic Games",
    connectorVersion: "0.1.0",
    methods: ["assisted_login", "session_import", "credential_totp"],
    tosWarning:
      "Automating claims on Epic Games may violate the Epic Games Store Terms of Service " +
      "and could result in suspension or loss of your Epic account. You use this at your own " +
      "risk. Continue only if you accept this.",
  },
  {
    id: "twitch",
    displayName: "Twitch Prime",
    connectorVersion: "0.1.0",
    methods: ["assisted_login", "session_import", "credential_totp"],
    tosWarning:
      "Automating Twitch Prime resubscriptions may violate Twitch's Terms of Service and " +
      "could result in suspension of your Twitch account. You use this at your own risk. " +
      "Continue only if you accept this.",
  },
  {
    id: "microsoft",
    displayName: "Microsoft Rewards",
    connectorVersion: "0.1.0",
    methods: ["assisted_login", "session_import", "credential_totp"],
    tosWarning:
      "Automating Microsoft Rewards may violate the Microsoft Rewards Terms of Service and " +
      "could result in suspension of your Microsoft account and loss of points. You use this " +
      "at your own risk. Continue only if you accept this.",
  },
  {
    id: "primegaming",
    displayName: "Amazon Prime Gaming",
    connectorVersion: "0.1.0",
    methods: ["assisted_login", "session_import"],
    tosWarning:
      "Automating Prime Gaming claims may violate the Amazon Prime Gaming Terms of Service and " +
      "could result in suspension of your Amazon account. You use this at your own risk. " +
      "Continue only if you accept this.",
  },
] as const;

/** Insert/refresh the seeded services (idempotent). */
export async function seedServices(db: Database): Promise<void> {
  for (const s of SEED_SERVICES) {
    await db
      .insert(service)
      .values({
        id: s.id,
        displayName: s.displayName,
        connectorVersion: s.connectorVersion,
        methods: [...s.methods],
        tosWarning: s.tosWarning,
      })
      .onConflictDoUpdate({
        target: service.id,
        set: {
          displayName: s.displayName,
          connectorVersion: s.connectorVersion,
          methods: [...s.methods],
          tosWarning: s.tosWarning,
        },
      });
  }
}
