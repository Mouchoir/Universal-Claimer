CREATE TABLE IF NOT EXISTS "claim_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connected_account_id" uuid NOT NULL,
	"service_id" text NOT NULL,
	"job_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connected_account" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "connected_account" ADD COLUMN "facts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_account" ADD COLUMN "facts_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "jitter_minutes" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claim_event" ADD CONSTRAINT "claim_event_connected_account_id_connected_account_id_fk" FOREIGN KEY ("connected_account_id") REFERENCES "public"."connected_account"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claim_event" ADD CONSTRAINT "claim_event_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
