-- ②-4a (OCR image-figure-crop) Phase A: 新設 tenant 表の policy 有効化。
-- owner (postgres) 実行前提。app_current_user_id() は 0025 で定義済。FORCE RLS は
-- しない (owner bypass で seed/migrate/operator を素通し)。(SELECT
-- public.app_current_user_id()) 包みで initPlan 化 (per-row 評価回避)。
--
-- Wave 1 / Wave 2 / P2 と完全同型: FOR ALL・USING=WITH CHECK=
-- user_id = (SELECT app_current_user_id())。全表とも単純 tenant 表 (common-form)。
--
-- policy は drizzle migration にしない (P2 §2.9 踏襲): versioned SQL として
-- db/policies/ に置き、test:iso は global-setup が migrate + grants +
-- p2/wave1/wave2-enable の直後に流す。prod は operator 手動適用。
--
-- 冪等性: 各 CREATE POLICY の直前に DROP POLICY IF EXISTS を置く (Wave 1/2 と同じ
-- 理由 — fresh DB / disable→再 enable / partial 失敗後の再適用のいずれでも安全に
-- 再実行できる。postgres-js .simple() は file 全体を 1 暗黙 tx で流すため途中の
-- 42710 が ENABLE 群ごと rollback するのを DROP で構造的に封じる)。ENABLE ROW LEVEL
-- SECURITY 自体は冪等 no-op。
--
-- 本 file は Phase A の 3 task にまたがっていたが、1 表は S-5 (単一 invocation
-- 経路への cutover・migration 0032) で表ごと drop したため 2 表になった。
SET lock_timeout = '5s';

-- upload_operations (②-4a Task 2・冪等 upload/OCR 操作の状態機械 ledger)
ALTER TABLE upload_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS upload_operations_tenant ON upload_operations;
CREATE POLICY upload_operations_tenant ON upload_operations FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

-- asset_derivations (②-4a Task 3・crop 由来の provenance メタ。PK は asset_id だが
-- tenant 述語は他表と同じ user_id = ... の common-form)
ALTER TABLE asset_derivations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_derivations_tenant ON asset_derivations;
CREATE POLICY asset_derivations_tenant ON asset_derivations FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));
