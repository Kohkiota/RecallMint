ALTER TABLE "user_settings" ALTER COLUMN "session_limit" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "custom_session_limit" integer DEFAULT 20;