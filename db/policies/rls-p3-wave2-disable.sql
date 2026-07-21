-- RLS Phase 3 Wave 2 rollback: 5 表の RLS を DISABLE のみで無効化する (policy 定義は
-- 残置)。owner (postgres) 実行前提。DISABLE ROW LEVEL SECURITY は policy を削除せず
-- 即時に無効化するため、再度 ENABLE すれば同じ policy が復活する = 即時 rollback
-- (再 enable は rls-p3-wave2-enable.sql が冪等なので policy 衝突なく通る。再 enable の
-- DROP+CREATE が定義を再適用するため disable 中に定義 drift しても復活時に是正される)。
-- DISABLE も ACCESS EXCLUSIVE lock を取るため enable.sql と対称に lock_timeout を張る。
-- P2 / Wave 1 disable と完全対称。
SET lock_timeout = '5s';
ALTER TABLE study_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE assets DISABLE ROW LEVEL SECURITY;
ALTER TABLE source_documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE upload_records DISABLE ROW LEVEL SECURITY;
