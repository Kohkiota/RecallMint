-- RLS Phase 3 Wave 2: 軽配線 5 表の policy 有効化。owner (postgres) 実行前提。
-- app_current_user_id() は 0025 で定義済。FORCE RLS はしない (owner bypass で
-- seed/migrate/operator を素通し)。(SELECT public.app_current_user_id()) 包みで
-- initPlan 化 (per-row 評価回避)。
--
-- Wave 1 (rls-p3-wave1-enable.sql) / P2 と完全同型: FOR ALL・USING=WITH CHECK=
-- user_id = (SELECT app_current_user_id())。5 表とも単純 tenant 表 (user_settings は
-- PK=user_id 単独だが述語は user_id のみで同一・コマンド別分割不要)。各表の残存 raw
-- getDb 経路を withTenantTx で context 下に入れた後に本 policy を張る (配線 → flip は
-- per-table 不可分・Step 0 §5.3)。
--
-- policy は drizzle migration にしない (P2 §2.9 踏襲): versioned SQL として db/policies/ に
-- 置き、test:iso は global-setup が migrate + grants + p2/wave1-enable の直後に流す。prod は
-- operator 手動適用 (0025 functions → deploy → policies の順序保護)。
--
-- 冪等性: 各 CREATE POLICY の直前に DROP POLICY IF EXISTS を置く (Wave 1 と同じ理由 —
-- fresh DB / disable→再 enable / partial 失敗後の再適用のいずれでも安全に再実行できる。
-- postgres-js .simple() は file 全体を 1 暗黙 tx で流すため途中の 42710 が ENABLE 群ごと
-- rollback するのを DROP で構造的に封じる)。ENABLE ROW LEVEL SECURITY 自体は冪等 no-op。
SET lock_timeout = '5s';

-- study_sessions (学習セッション・review ingest Phase 0 upsert)
ALTER TABLE study_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS study_sessions_tenant ON study_sessions;
CREATE POLICY study_sessions_tenant ON study_sessions FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

-- user_settings (学習設定・PK=user_id 単独)
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_settings_tenant ON user_settings;
CREATE POLICY user_settings_tenant ON user_settings FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

-- assets (画像 asset・reserved→ready saga)
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assets_tenant ON assets;
CREATE POLICY assets_tenant ON assets FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

-- source_documents (OCR 元資料)
ALTER TABLE source_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS source_documents_tenant ON source_documents;
CREATE POLICY source_documents_tenant ON source_documents FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

-- upload_records (OCR ページ消費台帳)
ALTER TABLE upload_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS upload_records_tenant ON upload_records;
CREATE POLICY upload_records_tenant ON upload_records FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));
