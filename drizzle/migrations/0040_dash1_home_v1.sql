ALTER TABLE "answer_events" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "first_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "daily_new_target" integer;--> statement-breakpoint
CREATE INDEX "answer_events_user_card_answered_idx" ON "answer_events" USING btree ("user_id","card_id","answered_at","event_id");--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_daily_new_target_nonneg" CHECK ("exams"."daily_new_target" IS NULL OR "exams"."daily_new_target" >= 0);