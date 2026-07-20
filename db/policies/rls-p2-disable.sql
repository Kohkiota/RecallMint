-- RLS-P2 rollback: 5 表の RLS を DISABLE のみで無効化する (policy 定義は残置)。
-- owner (postgres) 実行前提。DISABLE ROW LEVEL SECURITY は policy を削除せず
-- 即時に無効化するため、再度 ENABLE すれば同じ policy が復活する = 即時 rollback
-- (再 enable は rls-p2-enable.sql が冪等なので policy 衝突なく通る)。
-- DISABLE も ACCESS EXCLUSIVE lock を取るため enable.sql と対称に lock_timeout を張る。
SET lock_timeout = '5s';
ALTER TABLE exams DISABLE ROW LEVEL SECURITY;
ALTER TABLE cards DISABLE ROW LEVEL SECURITY;
ALTER TABLE tombstones DISABLE ROW LEVEL SECURITY;
ALTER TABLE study_days DISABLE ROW LEVEL SECURITY;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
