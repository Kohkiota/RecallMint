CREATE TABLE "tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tombstones" ADD CONSTRAINT "tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tombstones_user_deleted_idx" ON "tombstones" USING btree ("user_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tombstones_entity_uq" ON "tombstones" USING btree ("entity_type","entity_id");