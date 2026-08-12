-- RLS Phase 3 Wave 1: 配線ゼロ 7 表の policy 有効化。owner (postgres) 実行前提。
-- app_current_user_id() は 0025 で定義済。FORCE RLS はしない (owner bypass で
-- seed/migrate/operator を素通し)。(SELECT public.app_current_user_id()) 包みで
-- initPlan 化 (per-row 評価回避)。
--
-- P2 (rls-p2-enable.sql) の「共通形 4 表」と完全同型: FOR ALL・USING=WITH CHECK=
-- user_id = (SELECT app_current_user_id())。7 表とも単純 tenant 表 (users のような
-- lifecycle 特殊コマンド別建ては不要)。ai_usage_users は PK 複合 (user_id, date) だが
-- policy 述語は user_id のみで足りる (Step 0 追補で read 経路が本表を読まないことを確認)。
--
-- policy は drizzle migration にしない (P2 §2.9 踏襲): versioned SQL として db/policies/ に
-- 置き、test:iso は global-setup が migrate + grants + p2-enable の直後に流す。prod は
-- operator 手動適用 (0025 functions → deploy → policies の順序保護)。
--
-- 冪等性: 各 CREATE POLICY の直前に DROP POLICY IF EXISTS を置く (P2 と同じ理由 —
-- fresh DB / disable→再 enable / partial 失敗後の再適用のいずれでも安全に再実行できる。
-- postgres-js .simple() は file 全体を 1 暗黙 tx で流すため途中の 42710 が ENABLE 群ごと
-- rollback するのを DROP で構造的に封じる)。ENABLE ROW LEVEL SECURITY 自体は冪等 no-op。
SET lock_timeout = '5s';

-- answer_events (復習の唯一の正本。event_id は PK = global UNIQUE ゆえ RLS 非適用で、
-- ON CONFLICT は全 tenant 横断で衝突判定する。他 tenant の event_id との衝突は行が
-- 見えないまま非新規になる = ingest 側が failed[] として扱う前提の挙動)
-- FSRS 整合 Sprint A の migration 0035 で表を DROP/CREATE するため、policy と grant は
-- 表と一緒に落ちる。migration → grants → 本 file を同一メンテ窓で連続実行すること
-- (無防備窓を作らない。grants は base の blanket `ON ALL TABLES` が新表を拾う)。
ALTER TABLE answer_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS answer_events_tenant ON answer_events;
CREATE POLICY answer_events_tenant ON answer_events FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

-- tag_categories
ALTER TABLE tag_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tag_categories_tenant ON tag_categories;
CREATE POLICY tag_categories_tenant ON tag_categories FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

-- tag_options
ALTER TABLE tag_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tag_options_tenant ON tag_options;
CREATE POLICY tag_options_tenant ON tag_options FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

-- card_tags (card ↔ tag_option junction・複合 PK)
ALTER TABLE card_tags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS card_tags_tenant ON card_tags;
CREATE POLICY card_tags_tenant ON card_tags FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

-- entity_mutations (mutation-driven push outbox + 冪等 log)
ALTER TABLE entity_mutations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entity_mutations_tenant ON entity_mutations;
CREATE POLICY entity_mutations_tenant ON entity_mutations FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

-- card_asset_refs (画像参照の正規化・複合 PK)
ALTER TABLE card_asset_refs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS card_asset_refs_tenant ON card_asset_refs;
CREATE POLICY card_asset_refs_tenant ON card_asset_refs FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

-- ai_usage_users (ユーザー別日次カウンタ・複合 PK (user_id, date)・述語は user_id のみ)
ALTER TABLE ai_usage_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_usage_users_tenant ON ai_usage_users;
CREATE POLICY ai_usage_users_tenant ON ai_usage_users FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));
