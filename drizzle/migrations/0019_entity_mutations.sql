-- S-sync-1: card_mutations → entity_mutations 汎用化 (mutation-driven push の汎用 outbox)。
-- truncate 済前提 (アクティブユーザー 0 / prod 含むデータ破棄可) のため、 ALTER ではなく
-- 旧 table を物理 DROP し、 新 table を CREATE する (backfill 不要)。
-- entity_id には FK を付けない (entity_type ごとに参照先が違うため、 app 層 = apply
-- registry で integrity 保証)。

DROP TABLE "card_mutations" CASCADE;--> statement-breakpoint
CREATE TABLE "entity_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mutation_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"op" text NOT NULL,
	"patch" jsonb NOT NULL,
	"edited_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_mutations_mutation_id_unique" UNIQUE("mutation_id")
);
--> statement-breakpoint
ALTER TABLE "entity_mutations" ADD CONSTRAINT "entity_mutations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_mutations_entity_idx" ON "entity_mutations" USING btree ("entity_type","entity_id","edited_at");--> statement-breakpoint
CREATE INDEX "entity_mutations_user_idx" ON "entity_mutations" USING btree ("user_id","edited_at");
