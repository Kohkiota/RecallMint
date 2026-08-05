-- ②-4a S-5(単一 invocation 経路への cutover): 旧 prepare→publish 経路の撤去に伴う
-- **不可逆**な schema 縮小。適用後は旧経路へ戻せない(source_assets の行は復元不能)。
-- 適用前に R2 の `users/*/src/` 一掃(scripts/gc-src-prefix.ts)を済ませること —
-- 表を消すと object_key の台帳が失われ、残った source object を辿る手段が無くなる。
-- 手順: docs/ops/ocr-2-4a-stg-migration-runbook.md §5。

-- 0. lock 待ちの上限(値は db/policies/*.sql の先行例と同じ 5s)。下の 4/5/6 は
--    現役 table `upload_operations` に ACCESS EXCLUSIVE を取るため、長い先行 query が
--    居ると migration が無期限に待ち、その後ろに全 query が lock queue で詰む。
--    **`SET LOCAL` を使う理由**: 先行例(db/policies/*.sql)は素の `SET` だが、あちらは
--    専用の短命 owner 接続で 1 file を流して閉じる運用。こちらは drizzle-kit が file 全体を
--    BEGIN/COMMIT で包んだうえで接続を使い回すため、素の `SET` は commit 後も接続に残る。
--    tx を抜けたら戻る `SET LOCAL` が等価な形。
--    timeout で abort しても **file 全体が単一 tx** なので中途半端な適用にはならない
--    (全文 rollback → 再実行するだけ)。
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- 1. 旧 status の非終端 operation を終端化する(**列 drop より前・同一 migration tx 内**)。
--    S-5 で status の TS union から 'awaiting_sources' / 'claimed' が消えたため、この行が
--    残ったまま drop すると **どの gate / sweep / reconciler からも到達不能な dead row**
--    になる(live-op gate も gc-abandoned-operations も非終端集合 ['prepared','processing']
--    しか見ない)。運用手順に頼らず migration で構造的に閉じる。
--    値の入れ方は app 側の abandon 不変条件(`_lib/terminalize-abandoned-operation.ts`)と
--    同じ形: terminal_failed + prepared_payload/lease を NULL 化 + 理由を残す。
--    `next_retry_at` は下の 3 で列ごと drop するため、ここでは NULL 化しない。
--    対になる source_documents をここで failed 化しないのは、`reconcileStaleProcessing` が
--    15 分超の processing doc を(live op を持たない行として)回収するため — doc 側は
--    到達不能にならず、二重の掃除を migration に持ち込む必要がない。
UPDATE "upload_operations"
SET "status" = 'terminal_failed',
    "prepared_payload" = NULL,
    "lease_expires_at" = NULL,
    "last_error_code" = 'legacy_path_removed',
    "result_summary" = jsonb_build_object('reason', 'legacy_path_removed')
WHERE "status" IN ('awaiting_sources', 'claimed');--> statement-breakpoint
-- 2. asset_derivations の source 参照列を先に落とす(source_assets への FK 本体)。
--    列 drop が FK 制約ごと落とすため、次の DROP TABLE に CASCADE が要らない
--    (= 想定外の依存が残っていれば loud に失敗する)。
ALTER TABLE "asset_derivations" DROP COLUMN "source_asset_id";--> statement-breakpoint
-- 3. source_assets 本体(RLS policy / grant は表と共に消える)。
DROP TABLE "source_assets";--> statement-breakpoint
-- 4. 新経路が書かない列とその index(retryable 再開が無くなり next_retry_at が dead)。
--    attempt_count / last_error_code は新経路も書くため残す。
DROP INDEX "upload_operations_next_retry_idx";--> statement-breakpoint
ALTER TABLE "upload_operations" DROP COLUMN "next_retry_at";--> statement-breakpoint
-- 5. status の DB default。TS union から 'awaiting_sources' が消えるため、列 default に
--    頼る INSERT が union に存在しない値を書かないよう 'processing' へ移す。
ALTER TABLE "upload_operations" ALTER COLUMN "status" SET DEFAULT 'processing';
