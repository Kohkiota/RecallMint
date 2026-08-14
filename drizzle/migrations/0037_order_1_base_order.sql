ALTER TABLE "cards" RENAME COLUMN "sort_key" TO "question_label";--> statement-breakpoint
DROP INDEX "cards_sort_idx";--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "base_order" integer NOT NULL;--> statement-breakpoint
CREATE INDEX "cards_order_idx" ON "cards" USING btree ("user_id","exam_id","base_order","id");--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_base_order_positive" CHECK ("cards"."base_order" >= 1);