-- R0 (ReviewLog 持続化) Task 1 rollback: review_logs の RLS を DISABLE のみで
-- 無効化する (policy 定義は残置)。owner (postgres) 実行前提。DISABLE ROW LEVEL
-- SECURITY は policy を削除せず即時に無効化するため、再度 ENABLE すれば同じ
-- policy が復活する = 即時 rollback (再 enable は r0-review-logs-enable.sql が冪等
-- なので policy 衝突なく通る)。DISABLE も ACCESS EXCLUSIVE lock を取るため
-- enable.sql と対称に lock_timeout を張る。既存 disable file と完全対称。
SET lock_timeout = '5s';
ALTER TABLE review_logs DISABLE ROW LEVEL SECURITY;
