CREATE TABLE "upload_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"pages_processed" integer DEFAULT 0 NOT NULL,
	"ocr_cost_yen" numeric(10, 4),
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_documents" ALTER COLUMN "status" SET DEFAULT 'processing';--> statement-breakpoint
ALTER TABLE "source_documents" ALTER COLUMN "ocr_cost_yen" SET DATA TYPE numeric(10, 4);--> statement-breakpoint
ALTER TABLE "upload_records" ADD CONSTRAINT "upload_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "upload_records_user_created_idx" ON "upload_records" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "source_documents" DROP COLUMN "file_url";