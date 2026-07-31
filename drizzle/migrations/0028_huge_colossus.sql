CREATE TABLE "asset_derivations" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"orig_bbox" jsonb NOT NULL,
	"padding_pct" real NOT NULL,
	"clamped_bbox" jsonb NOT NULL,
	"crop_w" integer NOT NULL,
	"crop_h" integer NOT NULL,
	"detect_target" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_derivations" ADD CONSTRAINT "asset_derivations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_derivations" ADD CONSTRAINT "asset_derivations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_derivations" ADD CONSTRAINT "asset_derivations_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;