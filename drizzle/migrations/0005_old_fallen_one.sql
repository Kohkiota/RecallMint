-- S1.9.2: source_documents.mode を NOT NULL で追加。
-- production active user 0 件だが staging に test row が残る可能性があるため、
-- 「nullable 追加 → backfill → NOT NULL 化」 の 3 段で空/非空どちらでも安全に。
-- 既存 row の backfill 値は 'existing' (= discard で exam を消さない保守側。
-- 旧 row が万一 discard されても auto-created exam の cascade 削除を起こさない)。
-- drizzle snapshot は最終形 (mode NOT NULL) を表すため本 hand-edit と整合する。
ALTER TABLE "source_documents" ADD COLUMN "mode" text;--> statement-breakpoint
UPDATE "source_documents" SET "mode" = 'existing' WHERE "mode" IS NULL;--> statement-breakpoint
ALTER TABLE "source_documents" ALTER COLUMN "mode" SET NOT NULL;
