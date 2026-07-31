CREATE TABLE "upload_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"exam_id" uuid NOT NULL,
	"source_document_id" uuid,
	"status" text DEFAULT 'awaiting_sources' NOT NULL,
	"lease_version" bigint DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_error_code" text,
	"input_fingerprint" text,
	"prepared_schema_version" integer,
	"prepared_hash" text,
	"prepared_payload" jsonb,
	"result_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "upload_operations" ADD CONSTRAINT "upload_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_operations" ADD CONSTRAINT "upload_operations_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_operations" ADD CONSTRAINT "upload_operations_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "upload_operations_user_idempotency_uq" ON "upload_operations" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "upload_operations_user_status_idx" ON "upload_operations" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "upload_operations_next_retry_idx" ON "upload_operations" USING btree ("next_retry_at");