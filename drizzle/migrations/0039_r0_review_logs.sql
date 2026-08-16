CREATE TABLE "review_logs" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"state_before" integer NOT NULL,
	"due_before" timestamp with time zone NOT NULL,
	"stability_before" double precision NOT NULL,
	"difficulty_before" double precision NOT NULL,
	"elapsed_days" integer NOT NULL,
	"last_elapsed_days" integer NOT NULL,
	"scheduled_days" integer NOT NULL,
	"learning_steps" integer NOT NULL,
	"review" timestamp with time zone NOT NULL,
	"state_after" integer NOT NULL,
	"stability_after" double precision NOT NULL,
	"difficulty_after" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_logs_rating_range" CHECK ("review_logs"."rating" BETWEEN 1 AND 4),
	CONSTRAINT "review_logs_state_before_range" CHECK ("review_logs"."state_before" BETWEEN 0 AND 3),
	CONSTRAINT "review_logs_state_after_range" CHECK ("review_logs"."state_after" BETWEEN 0 AND 3)
);
--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_event_id_answer_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."answer_events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;