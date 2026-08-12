DROP TABLE "answer_events" CASCADE;--> statement-breakpoint
DROP TABLE "reviews" CASCADE;--> statement-breakpoint
DROP TABLE "study_sessions" CASCADE;--> statement-breakpoint
CREATE TABLE "answer_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"session_id" uuid,
	"selected_answer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_correct" boolean NOT NULL,
	"rating" integer NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	"elapsed_ms" integer,
	"applied" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "answer_events_rating_range" CHECK ("answer_events"."rating" BETWEEN 1 AND 4),
	CONSTRAINT "answer_events_elapsed_ms_nonneg" CHECK ("answer_events"."elapsed_ms" IS NULL OR "answer_events"."elapsed_ms" >= 0),
	CONSTRAINT "answer_events_answered_at_le_created_at" CHECK ("answer_events"."answered_at" <= "answer_events"."created_at")
);
--> statement-breakpoint
ALTER TABLE "answer_events" ADD CONSTRAINT "answer_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_events_user_idx" ON "answer_events" USING btree ("user_id","answered_at");--> statement-breakpoint
TRUNCATE TABLE "study_days";
