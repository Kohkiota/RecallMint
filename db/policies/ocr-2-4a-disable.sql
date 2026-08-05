-- ②-4a (OCR image-figure-crop) Phase A rollback: 新設 tenant 表の RLS を DISABLE
-- のみで無効化する (policy 定義は残置)。owner (postgres) 実行前提。DISABLE ROW
-- LEVEL SECURITY は policy を削除せず即時に無効化するため、再度 ENABLE すれば同じ
-- policy が復活する = 即時 rollback (再 enable は ocr-2-4a-enable.sql が冪等なので
-- policy 衝突なく通る)。DISABLE も ACCESS EXCLUSIVE lock を取るため enable.sql と
-- 対称に lock_timeout を張る。P2 / Wave 1 / Wave 2 disable と完全対称。
SET lock_timeout = '5s';
ALTER TABLE upload_operations DISABLE ROW LEVEL SECURITY;
ALTER TABLE asset_derivations DISABLE ROW LEVEL SECURITY;
