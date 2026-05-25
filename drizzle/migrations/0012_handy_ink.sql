CREATE TABLE "answer_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"session_id" uuid,
	"card_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"selected_answer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_correct" boolean NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	"elapsed_ms" integer,
	"sync_status" text DEFAULT 'synced' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "card_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mutation_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"patch" jsonb NOT NULL,
	"edited_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_mutations_mutation_id_unique" UNIQUE("mutation_id")
);
--> statement-breakpoint
CREATE TABLE "study_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"exam_id" uuid,
	"mode" text NOT NULL,
	"card_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"query" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "content_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "content_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "answer_events" ADD CONSTRAINT "answer_events_session_id_study_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."study_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_events" ADD CONSTRAINT "answer_events_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_events" ADD CONSTRAINT "answer_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_mutations" ADD CONSTRAINT "card_mutations_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_mutations" ADD CONSTRAINT "card_mutations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_events_user_idx" ON "answer_events" USING btree ("user_id","answered_at");--> statement-breakpoint
CREATE INDEX "answer_events_card_idx" ON "answer_events" USING btree ("card_id","answered_at");--> statement-breakpoint
CREATE INDEX "answer_events_session_idx" ON "answer_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "card_mutations_card_idx" ON "card_mutations" USING btree ("card_id","edited_at");--> statement-breakpoint
CREATE INDEX "card_mutations_user_idx" ON "card_mutations" USING btree ("user_id","edited_at");--> statement-breakpoint
CREATE INDEX "study_sessions_user_idx" ON "study_sessions" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "study_sessions_exam_idx" ON "study_sessions" USING btree ("exam_id");