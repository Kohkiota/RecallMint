ALTER TABLE "users" ADD COLUMN "scheduled_downgrade_schedule_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "scheduled_target_price_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "scheduled_change_effective_at" timestamp with time zone;