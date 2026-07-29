ALTER TABLE "claim_event" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "claim_event" ADD COLUMN "redeem_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claim_event" ADD COLUMN "code_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "claim_event" ADD COLUMN "code_data_key" "bytea";--> statement-breakpoint
ALTER TABLE "claim_event" ADD COLUMN "redeemed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;