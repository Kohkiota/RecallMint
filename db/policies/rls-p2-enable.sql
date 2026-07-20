-- RLS-P2: 5 表の policy 有効化。owner (postgres) 実行前提。app_current_user_id() は
-- 0025 で定義済。FORCE RLS はしない (owner bypass で seed/migrate/operator を素通し)。
-- (SELECT public.app_current_user_id()) 包みで initPlan 化 (per-row 評価回避)。
--
-- policy は drizzle migration にしない (spec §2.9): versioned SQL として
-- db/policies/ に置き、test:iso は global-setup が migrate + grants の直後に流す。
-- prod は operator 手動適用 (0025 functions → deploy → policies の順序を守るため)。
--
-- 冪等性: 各 CREATE POLICY の直前に DROP POLICY IF EXISTS を置く。これで fresh DB
-- (DROP は no-op)・disable.sql 後の再 enable (rollback 演習 spec §4.4 の disable→
-- 再 enable は policy 定義を残置するため CREATE が 42710 で衝突する)・partial 失敗後の
-- 再適用のいずれでも安全に再実行できる。postgres-js .simple() は file 全体を 1 暗黙
-- transaction で流すため、途中の 42710 は ALTER ... ENABLE 群ごと rollback し RLS を
-- silent に OFF のまま残す — これを DROP で構造的に封じる。ENABLE ROW LEVEL SECURITY 自体は
-- 冪等 (有効表の再 enable は無害な no-op) のため据え置く。
SET lock_timeout = '5s';

-- 共通形 4 表 (FOR ALL・USING=WITH CHECK 同式)
ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS exams_tenant ON exams;
CREATE POLICY exams_tenant ON exams FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cards_tenant ON cards;
CREATE POLICY cards_tenant ON cards FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

ALTER TABLE tombstones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tombstones_tenant ON tombstones;
CREATE POLICY tombstones_tenant ON tombstones FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

ALTER TABLE study_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS study_days_tenant ON study_days;
CREATE POLICY study_days_tenant ON study_days FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

-- users: コマンド別・DELETE policy なし (= app-role の users hard delete を構造的 deny)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_select ON users;
CREATE POLICY users_select ON users FOR SELECT TO recallmint_app
  USING (id = (SELECT public.app_current_user_id()) AND deleted_at IS NULL);
DROP POLICY IF EXISTS users_insert ON users;
CREATE POLICY users_insert ON users FOR INSERT TO recallmint_app
  WITH CHECK (id = (SELECT public.app_current_user_id()));
DROP POLICY IF EXISTS users_update ON users;
CREATE POLICY users_update ON users FOR UPDATE TO recallmint_app
  USING (id = (SELECT public.app_current_user_id()) AND deleted_at IS NULL)
  WITH CHECK (id = (SELECT public.app_current_user_id()));
