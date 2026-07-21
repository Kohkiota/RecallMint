-- RLS Phase 3 Wave 1 rollback: 8 表の RLS を DISABLE のみで無効化する (policy 定義は
-- 残置)。owner (postgres) 実行前提。DISABLE ROW LEVEL SECURITY は policy を削除せず
-- 即時に無効化するため、再度 ENABLE すれば同じ policy が復活する = 即時 rollback
-- (再 enable は rls-p3-wave1-enable.sql が冪等なので policy 衝突なく通る)。
-- DISABLE も ACCESS EXCLUSIVE lock を取るため enable.sql と対称に lock_timeout を張る。
-- P2 (rls-p2-disable.sql) と完全対称。
SET lock_timeout = '5s';
ALTER TABLE reviews DISABLE ROW LEVEL SECURITY;
ALTER TABLE answer_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE tag_categories DISABLE ROW LEVEL SECURITY;
ALTER TABLE tag_options DISABLE ROW LEVEL SECURITY;
ALTER TABLE card_tags DISABLE ROW LEVEL SECURITY;
ALTER TABLE entity_mutations DISABLE ROW LEVEL SECURITY;
ALTER TABLE card_asset_refs DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_users DISABLE ROW LEVEL SECURITY;
