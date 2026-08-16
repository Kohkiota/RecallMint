-- R0 (ReviewLog 持続化) Task 1: 新設 review_logs 表の policy 有効化。
-- owner (postgres) 実行前提。app_current_user_id() は 0025 で定義済。FORCE RLS は
-- しない (owner bypass で seed/migrate/operator を素通し)。(SELECT
-- public.app_current_user_id()) 包みで initPlan 化 (per-row 評価回避)。
--
-- Wave 1 / Wave 2 / ②-4a と完全同型: FOR ALL・USING=WITH CHECK=
-- user_id = (SELECT app_current_user_id())。単純 tenant 表 (common-form)。
--
-- policy は drizzle migration にしない (P2 §2.9 踏襲・spec §12-1 裁定): versioned SQL
-- として db/policies/ に置き、test:iso は global-setup が migrate + grants +
-- p2/wave1/wave2/ocr-2-4a-enable の直後に流す。prod は operator 手動適用。
--
-- 冪等性: 各 CREATE POLICY の直前に DROP POLICY IF EXISTS を置く (既存 enable file と
-- 同じ理由 — fresh DB / disable→再 enable / partial 失敗後の再適用のいずれでも安全に
-- 再実行できる。postgres-js .simple() は file 全体を 1 暗黙 tx で流すため途中の
-- 42710 が ENABLE 群ごと rollback するのを DROP で構造的に封じる)。ENABLE ROW LEVEL
-- SECURITY 自体は冪等 no-op。
SET lock_timeout = '5s';

-- review_logs (R0 Task 1・ts-fsrs ReviewLog の永続化。書込は ingest 手順 7.5 のみ)
ALTER TABLE review_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_logs_tenant ON review_logs;
CREATE POLICY review_logs_tenant ON review_logs FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));
