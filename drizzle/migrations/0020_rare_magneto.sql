CREATE TABLE "card_tags" (
	"card_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_tags_card_id_option_id_pk" PRIMARY KEY("card_id","option_id")
);
--> statement-breakpoint
CREATE TABLE "tag_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"select_type" text NOT NULL,
	"color" text,
	"sort_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"sort_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "cards_props_gin_idx";--> statement-breakpoint
ALTER TABLE "card_tags" ADD CONSTRAINT "card_tags_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_tags" ADD CONSTRAINT "card_tags_option_id_tag_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."tag_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_tags" ADD CONSTRAINT "card_tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_categories" ADD CONSTRAINT "tag_categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_options" ADD CONSTRAINT "tag_options_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_options" ADD CONSTRAINT "tag_options_category_id_tag_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."tag_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_tags_option_idx" ON "card_tags" USING btree ("option_id");--> statement-breakpoint
CREATE INDEX "card_tags_user_idx" ON "card_tags" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tag_categories_user_updated_idx" ON "tag_categories" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "tag_options_user_updated_idx" ON "tag_options" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "tag_options_category_idx" ON "tag_options" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_options_category_name_uq" ON "tag_options" USING btree ("category_id","name");--> statement-breakpoint
ALTER TABLE "cards" DROP COLUMN "custom_props";--> statement-breakpoint
ALTER TABLE "cards" DROP COLUMN "tags";