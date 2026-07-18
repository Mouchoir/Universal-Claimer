CREATE TABLE IF NOT EXISTS "admin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"password_hash" text NOT NULL,
	"recovery_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connected_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" text NOT NULL,
	"method" text NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_data_key" "bytea" NOT NULL,
	"fingerprint" jsonb NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" text NOT NULL,
	"connector_version" text NOT NULL,
	"success" boolean NOT NULL,
	"outcome" text NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_state" (
	"service_id" text PRIMARY KEY NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"disabled_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consent_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tos_warning_snapshot" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connected_account_id" uuid NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"outcome" text,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_target" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"kind" text NOT NULL,
	"config_ciphertext" "bytea" NOT NULL,
	"config_data_key" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_question" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" smallint NOT NULL,
	"question" text NOT NULL,
	"answer_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"connector_version" text NOT NULL,
	"tos_warning" text NOT NULL,
	"methods" text[] NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connected_account" ADD CONSTRAINT "connected_account_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job" ADD CONSTRAINT "job_connected_account_id_connected_account_id_fk" FOREIGN KEY ("connected_account_id") REFERENCES "public"."connected_account"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admin_singleton_uq" ON "admin" USING btree ("singleton");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connected_account_service_uq" ON "connected_account" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_target_singleton_uq" ON "notification_target" USING btree ("singleton");