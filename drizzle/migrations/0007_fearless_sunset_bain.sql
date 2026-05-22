ALTER TABLE "exams" ADD COLUMN "card_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- B1 backfill (S2.0c): ADD COLUMN は既存行を 0 で埋めるため、 cards の実件数で
-- 上書きして整合させる。 現状ほぼ 0 行だが念のため。 以降の増減は
-- process.ts / delete-card.ts が transaction 内で維持する。
UPDATE "exams" SET "card_count" = (
  SELECT count(*) FROM "cards" WHERE "cards"."exam_id" = "exams"."id"
);