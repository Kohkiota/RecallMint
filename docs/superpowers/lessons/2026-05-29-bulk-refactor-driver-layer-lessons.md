# bulk SQL refactor の driver 層・実 DB integration learnings

**作成日**: 2026-05-29
**抽出元 sprint**: 問題 3 bulk refactor (`/api/review-events/bulk` を per-event tx × N → 単一 tx + in-memory FSRS replay + bulk SQL)
**関連 session**: `docs/superpowers/sessions/2026-05-29-problem3-bulk-refactor-closure.md` / `...-problem3-after-measurement.md` §0〜§0-final
**関連 spec / plan**: `docs/superpowers/sessions/2026-05-28-problem3-bulk-refactor-spec.md` / `docs/superpowers/plans/2026-05-28-problem3-bulk-refactor.md`

---

## TL;DR

887 unit test green + build OK で stg deploy したが、 cards bulk VALUES UPDATE が**実 Postgres で tx rollback**し全 event が `failed[]` に積まれた。 root cause は SQL でなく **driver 層**: Drizzle の `sql` template に JS Date を embed すると postgres-js の timestamptz serializer (OID 1184) が bypass され、 `Buffer.byteLength(Date)` で TypeError (Drizzle #5789 既知挙動)。 mock test は driver を再現せず、 toSQL() rendering も valid に見えるため検出不能だった。 → driver 層の値 encode は pre-investigation・smoke の必須対象。

---

## L1. pre-investigation の depth — driver 層の値 encode は公式 issue 検索込みで確認

**背景**: pre-investigation で「Drizzle 0.45.2 で `update().from(sql\`(VALUES ...)\`)` は capability OK」と書いたが、 これは `toSQL()` rendering の目視のみで確定したもの。 SQL **文字列**は valid でも、 driver が**値を encode できる**保証は別問題で未検証。 結果 stg で初めて driver 層エラーに当たり、 原因究明に複数仮説の往復を要した。

**教訓**: query builder の chainable + `sql` template を使う変更では、 SQL 生成 (toSQL) だけでなく **driver 層の値 encode 経路 (型 serializer / OID hint)** を pre-investigation 対象に含める。 特に Date / jsonb / array / bigint 等の非自明型を `sql` template に embed する場合、 `<driver 名> + <値型> + <エラーパターン>` で公式 issue 検索 (Drizzle / postgres-js / pg) を pre-investigation step に明示的に組み込む。

## L2. unit test の mock は driver / pooler 層を再現できない — 実 DB smoke を完了条件に

**背景**: `route.test.ts` は `getDb` / `tx` を mock し実 SQL を Postgres に投げない。 SQL 文字列が valid でも postgres-js が Date を encode 中に throw する経路は mock では出ず、 887 test green で deploy → 実 DB で初めて発覚。

**教訓**: bulk SQL refactor のような **driver 層挙動に依存する変更**は、 unit test green を完了条件にしない。 **stg / preview deploy + 実 DB smoke を plan の必須段階**として組み込む (plan の「完了条件」に「stg smoke で実 DB 反映確認」を明記)。 観測強化 (L3) を**最初の deploy 時点で同梱**しておくと初回 smoke で原因が即特定できる。

## L3. 原因不明時は「観測 → 仮説 → 対策」を時間で分離する

**背景**: stg rollback 発覚時、 最初に「raw 化 (chainable をやめて `tx.execute`)」を疑い fix prompt を出しかけた。 OT 判断で「先に error log 強化のみを 1 commit」に分離した結果、 根本原因 (Date encode) が客観確定し、 当初仮説 (Drizzle chainable サポート外) が**外れ**だったことも判明。 raw 化していたら「直ったが何が効いたか不明」になっていた。

**教訓**: 原因不明の rollback / throw には、 **観測強化 (error serializer + native error 全展開) を単独 commit で先に投入**する。 「観測と対策を 1 commit に同梱」は deploy 1 回の節約と引き換えに「直った理由不明 / 直らない時の手がかり薄」のリスク。 診断と対策を時間分離するのが工学的に正しい。

## L4. driver 層エラーは Postgres logs に出ない — エラー種別で層を切り分ける

**背景**: rollback 時 Supabase Postgres logs を時刻窓 + severity で全件確認したが ERROR は 1 件も無く、 これが「Postgres まで届く前で reject」の証拠になった。 原因は postgres-js の Node.js TypeError で、 Postgres は SQL を一切受け取っていなかった。

**教訓**: 「SQL が落ちた」と思った時、 **Postgres logs に該当 ERROR が無ければ driver / pooler 層を疑う**。 error の `code` で切り分け: SQLSTATE 5 桁 → Postgres 層 / `ERR_INVALID_ARG_TYPE` 等 Node.js error → driver の値 encode 層 / PgBouncer・Supavisor 由来 message → pooler 層。 そのためには catch した error の **native field 全展開** (logger が Error を {name,message,stack} に潰さない plain object 化) が前提 (L3 の観測強化)。

## L5. dead code は refactor 前に grep で確定 → 撤去して DRY 達成

**背景**: spec 段階で `submitReviewTx` 据え置きを判断したが、 着手前の grep 確認で旧 `submitReview` action は完全 dead、 `submitReviewTx` も bulk route 専用と確定 → refactor 内で撤去でき、 `replayCard` が FSRS compute の単一 source となり「二重 guard で重複担保」の妥協を回避。

**教訓**: spec が「据え置き」と判断した dead code 候補でも、 refactor 着手前に **grep で caller を網羅確認し dead/alive を確定**する。 dead と確定すれば撤去を refactor の一部に組み込むことで DRY が達成され、 妥協 (重複維持 / 二重 guard) を避けられる。 (関連既存 lesson: 据え置き判断を鵜呑みにしない。)

## L6. 診断 log の生 params は env flag で gate して本番 PII 漏洩を防ぐ

**背景**: 観測強化 (L3) で bind params 全体を log したくなるが、 params には card_id / user_id (UUID) や FSRS 値が含まれる。 `serializeDbError` は **デフォルトで params を要約のみ** (count / 型分布 / anomaly flag / card_id 抽出) とし、 full params は `BULK_FULL_PARAMS_LOG=1` (Preview 限定) のときだけ出す設計にした。 既存 `OCR_DEBUG_LOG` と同パターン。

**教訓**: 診断 log に生データを出す機能は **env flag で gate** し、 production には設定しない (`VERCEL_ENV` 判定 or 専用 flag)。 要約 (型分布 / anomaly flag) だけでも root cause の多くは特定でき、 生データは Preview/stg の一時 flag で十分。 env var は同 commit で `.env.example` に追記 (本番非設定の注記込み)。

## L7. bulk UPDATE には RETURNING + 件数照合の安全網を default で付ける

**背景**: `UPDATE ... FROM (VALUES ...)` は WHERE が 1 件も match しなくても **エラーにならず 0 rows update で silent に成功**する。 本 refactor では `.returning({ id })` で更新件数を取り、 `finalStates.size` と不一致なら throw (tx rollback → log に missingCardIds) する安全網を入れた。

**教訓**: bulk UPDATE (特に VALUES join / owner-scope WHERE 付き) は **RETURNING で更新件数を取り、 期待件数と照合して mismatch を throw** するのを default pattern にする。 owner mismatch / 並行削除 / WHERE 条件ミスによる「黙って 0 件更新」を検知できる。 PK 1:1 join なら件数照合は false-positive しない。

---

## 関連参照

- closure: `docs/superpowers/sessions/2026-05-29-problem3-bulk-refactor-closure.md`
- smoke 経緯: `docs/superpowers/sessions/2026-05-28-problem3-after-measurement.md` §0 (CRITICAL) / §0-bis / §0-final
- Drizzle #5789 (sql template + Date → postgres-js encode TypeError)
- driver init: `lib/db/index.ts` (postgres-js / `prepare: false` / Supabase PgBouncer transaction mode)
- 観測 util: `lib/db/serialize-db-error.ts` / fix: `app/api/review-events/bulk/route.ts` Phase 2e (`toPgTimestamptz`)
