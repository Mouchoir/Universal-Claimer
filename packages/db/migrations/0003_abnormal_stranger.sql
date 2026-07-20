ALTER TABLE "connected_account" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "login_session" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;