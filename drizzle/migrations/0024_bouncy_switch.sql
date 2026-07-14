CREATE TABLE "card_asset_refs" (
	"card_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "card_asset_refs_card_id_field_key_ordinal_pk" PRIMARY KEY("card_id","field_key","ordinal")
);
--> statement-breakpoint
ALTER TABLE "card_asset_refs" ADD CONSTRAINT "card_asset_refs_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_asset_refs" ADD CONSTRAINT "card_asset_refs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_asset_refs" ADD CONSTRAINT "card_asset_refs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_asset_refs_asset_idx" ON "card_asset_refs" USING btree ("asset_id");