ALTER TABLE "connected_account" ADD COLUMN "proxy_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "connected_account" ADD COLUMN "proxy_data_key" "bytea";--> statement-breakpoint
ALTER TABLE "login_session" ADD COLUMN "proxy_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "login_session" ADD COLUMN "proxy_data_key" "bytea";