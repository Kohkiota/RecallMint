CREATE TABLE "source_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"object_key" text NOT NULL,
	"mime" text NOT NULL,
	"content_hash" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"original_filename" text NOT NULL,
	"source_kind" text DEFAULT 'image' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"page_count" integer,
	"rotation" integer,
	"rasterizer" text,
	CONSTRAINT "source_assets_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
ALTER TABLE "source_assets" ADD CONSTRAINT "source_assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_assets" ADD CONSTRAINT "source_assets_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_assets_doc_source_uq" ON "source_assets" USING btree ("source_document_id","source_id");--> statement-breakpoint
CREATE INDEX "source_assets_user_status_idx" ON "source_assets" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "source_assets_source_document_idx" ON "source_assets" USING btree ("source_document_id");