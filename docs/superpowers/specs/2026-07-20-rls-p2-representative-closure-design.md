# RLS-P2: RLS 本体の実証(closure 5 表)— 設計 spec

- 日付: 2026-07-20 / branch: `develop`
- 目的: `set_config`(tx-local)+ transaction 包みで RLS を実際に動かし、「動く・漏れない・遅くならない」を stg で実証する。通れば Phase 3(全表展開)は本 sprint の型の反復。
- **scope**: spec → plan → codex-plan-review で停止。実装は scope 外。
- 前提 doc: Perf-0/0b(`docs/audit/2026-07-18-rls-performance-before-factfinding.md`)/ Iso-0(`…tenant-isolation-integration-test-factfinding.md`)/ RLS-P1 spec・session / **現場確認(`docs/audit/2026-07-20-rls-p2-lifecycle-null-affected-rows-factfinding.md`、以下 FF)**。
- 制約: Gemini prompt / `ocr-extract.ts` 不可触。sprint 完了 gate(lint / typecheck / build / test / test:iso)維持。**既存挙動の保全が最優先** — lifecycle handler・null 契約・冪等吸収の現挙動を変えるのは本 spec で明示した箇所のみ。

---

## 0. 確定事項(OT 決定・再議論しない)

1. **Phase 2 対象 = closure 5 表 {users, exams, cards, tombstones, study_days}**(FF §4.2 案 A)。「exam 削除 tx」+「dashboard stats」+「study-days pull」の closure が完全に閉じる(GPT 修正 4 採用)。partial 残余 = `/api/pull` の tag 3 表(tag_categories/tag_options/card_tags)と review-ingest 系(reviews/answer_events/study_sessions)。**残余が新失敗モードを作らない理由**: tag 3 表・review 系は RLS 無効のまま = 従来どおり `eq(userId)` のみで動作し、同一 tx 内に RLS 有効表と混在しても policy 評価は表単位で独立。context 設定(set_config)は全 tx に入るが、RLS 無効表には作用しない(先行 no-op)。tag 3 表 + review 系は Phase 3 第一波。
2. **tx 設計 = 素朴直列**: 経路単位で 1 tx、冒頭 set_config。高度化(チャンク分割等)は after 計測で悪化時のみ。**entity-mutations bulk は per-mutation tx 維持**(各 tx 冒頭 set_config、group 並列温存)。**OCR 3-tx 分離維持**(各 tx 冒頭 set_config、Gemini は tx 外)。**tx 内に外部 I/O を入れない**(Stripe / Clerk / R2 / Discord は tx 外)— 恒久不変条件として明文化。
3. **RLS 有効化後も `eq(userId)` は全経路で残す**(RLS は保険層)。
4. **loud 設計**: context 未設定 = 例外(plpgsql RAISE)。決定的根拠 = FF §3.2 — silent(0 行)だと RLS 起因 0 行が既存の**意図された冪等吸収**(outbox 再送 / webhook 再配信 / double-click)と識別不能になり、unchecked-silent 全箇所が漏れの隠蔽点化する。
5. **GPT 修正の採否**(理由込み):
   - **修正 1 採用**: 認証は claim 有無で最初に分岐(§2.4)。request 経路から users INSERT しない(webhook-only sync を invariant として明文化)。null 契約 7 分類(FF §2.2)を RLS が壊さないことを test で pin。
   - **修正 2 却下**(user tombstone 不採用): webhook は常時 200 + dedupe 先行で再送自動リカバリが構造的に不在、再削除は既に no-op(FF §1.2)。orphan 行(created 遅着 → 新規行、FF §1.3)は既知受容として記録。採用する低コスト分 = notifyOps 文言の中立化のみ(§2.6 — 判別自体は構造的に不可能)。
   - **修正 3 却下**(lifecycle handler への advisory lock 不採用): 変更は set_config 追加(+ scrub の関数化移植)のみに絞る。再検討トリガー = 同時着信の実観測 or Phase 3 の user.deleted closure 化。
   - **修正 4 採用**: closure 単位の有効化(上記 1)。**Phase 2 は stg 限定・短期間** — 部分 RLS 状態を prod に出さない(prod 反映は Phase 3 完了後)。
6. **users の特殊経路 = SECURITY DEFINER 3 本**(bootstrap / stripe resolver / scrub、§2.3)。**users lifecycle write では RETURNING・upsert を使わず事前採番 INSERT**(§2.5)。**dedupe-first は現状既にこの順**(FF §1.1)= 変更不要、test で pin。**退会後 Stripe イベントは log + skip**(§2.5)。
7. 性能合格基準: 各経路 p95 悪化 ≤ max(+10%, +20ms)、`/api/pull` full のみ +40ms 予算(p50/p95)。stg で 2nd Clerk test user による pooler 実機検証を行う。
8. **drizzle `pgPolicy` の採否は plan Step 0 で評価**(Context7 + registry 裏取り)。採否いずれでも適用される SQL 内容(§2.2-2.3)は同一。
9. affected rows の一括検査追加はしない(FF §3 の結論)。Phase 2 対象表に関わる unchecked-silent 少数の個別確認は §2.7。

---

## 1. Step 0 事実(現物確認済 — 設計の接地)

| 項目 | 事実 | 出所 |
|---|---|---|
| RLS-P1 稼働 | app runtime = `recallmint_app`(非所有者・NOBYPASSRLS)、owner = `DATABASE_URL_ADMIN` 分離済。test:iso は code-under-test を app role で実行 | RLS-P1 session |
| 5 表の user_id index | exams / cards は user_id 先頭 index 複数、study_days PK=(user_id, day)、tombstones は user_id 保持(index は plan で確認)、users は PK id + clerk_id / stripe_customer_id UNIQUE | schema.ts |
| users への query anchor | `whereFor()` 4 本(id / clerkId / stripeCustomerId / scheduleId)に集約。他は getCurrentUser(clerk_id)/ contact(clerk_id)/ clerk webhook(clerk_id) | FF §1, subscription-repository |
| `/api/me/deletion-status` | **T-A9(`f98d9ab`)で廃止済**。scrub 済み users 行を読む public 経路は現存しない。削除後 navigate は client 直行(delete-button → `/sign-out-deleted`) | 現物 + git log |
| scrub の帰結 | deletedAt 行は clerk_id lookup で不達(clerkId=NULL)。「claim あり + users 0 行」= ghost window の現挙動は空 render / SyncingPage(throw なし) | FF §2.1 |
| raw SQL | UPDATE/DELETE の raw 実行は 0 件。SELECT のみ(streak.ts ×2 = study_days) | FF §3.1 |
| tx 現況 | server tx 10 本・tx 内外部 I/O 0。`runUploadGuardTx` のみ tx 保持中に別接続 read 2 本(§2.8 で fix) | Perf-0 §2 |
| read helper 形状 | `getDeltaRows` / list.ts 4 関数 / streak / study-days-pull / get-session-cards は内部 `getDb()` 直取り = tx 参加には db 引数追加が要る(`processMutation(db,…)` / `apply(tx,…)` と同型化) | 現物 |
| 既存 iso test 呼び形 | app 関数直呼び + 検証 read も app role `getDb()` 直 = RLS on 後は検証 read が loud fail する → 検証 read の owner 接続化 + 直呼びの withTenantTx 包みが必要 | read/write-isolation.test.ts |

---

## 2. 設計

### 2.1 GUC と loud 関数

- GUC = `app.user_id` 単一。設定は各 tx 冒頭で `SELECT set_config('app.user_id', (<uuid>)::uuid::text, true)`(tx-local、COMMIT/ROLLBACK で消滅 = pooler 越しでも漏れない)。**cast を設定文に含める** = 不正形式(claim 改竄・破損)は設定時点で loud fail(対象表 query まで潜伏しない。Codex 指摘採用)。
- `app_current_user_id() RETURNS uuid`(plpgsql, STABLE): `nullif(current_setting('app.user_id', true), '')` が NULL なら **RAISE EXCEPTION `ERRCODE = 'P0RLS'`**(カスタム SQLSTATE。標準 28000 は認証系と混同するため不採用 — Codex 指摘採用。既存 42501 とも区別、test が pin)。非 NULL なら `::uuid`。silent の 2 形態(未設定 NULL / revert 空文字)を両方 loud に倒す。
- policy 内では `(SELECT app_current_user_id())` と包み initPlan 化(per-row 評価回避)。
- **loud の保証範囲(明文化)**: 隔離の保証主体は deny-by-default(context 不一致 = 0 行 / WITH CHECK 拒否)。loud RAISE は配管ミスの早期検出層で、executor が policy 式を評価しない縮退 plan(恒偽述語等)では RAISE せず 0 行になり得る — その場合も漏れない。空表・対象 0 行・コマンド別の RAISE 実挙動は test:iso で実測 pin(§3.1)。
- **脅威モデル(明文化)**: 本 RLS が防ぐのは配管ミス・WHERE 漏れ・pooler 残留。app role 自体の完全侵害(任意 SQL 実行 = 任意 set_config 可)は対象外。

### 2.2 policy — 共通形(exams / cards / tombstones / study_days)

各表 1 本、`FOR ALL TO recallmint_app`:
```sql
ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
CREATE POLICY exams_tenant ON exams FOR ALL TO recallmint_app
  USING (user_id = (SELECT app_current_user_id()))
  WITH CHECK (user_id = (SELECT app_current_user_id()));
```
- FORCE RLS はしない(owner = migration / operator / test-seed は素通り、P1 確定の非所有者方式)。FK cascade(exams→cards→…)は PG 内部処理で RLS 非適用 = 現挙動不変。

### 2.3 policy — users(コマンド別対称)+ SECURITY DEFINER 3 本

users は request 経路の通常 CRUD と lifecycle 特殊経路が交差するため、コマンド別 policy + 特殊経路の定義者関数で対称化する:

| コマンド | policy | 根拠 |
|---|---|---|
| SELECT | `USING (id = (SELECT app_current_user_id()) AND deleted_at IS NULL)` | ghost UUID(scrub 済み)context での read を 0 行に = null 契約へ合流(確定 5-修正 1・§3.3 ghost test) |
| INSERT | `WITH CHECK (id = (SELECT app_current_user_id()))` | user.created の事前採番 INSERT のみ(§2.5)。request 経路の users INSERT 不在は invariant |
| UPDATE | `USING (id = (SELECT app_current_user_id()) AND deleted_at IS NULL)` + `WITH CHECK (id = (SELECT app_current_user_id()))` | 退会後 write は log+skip 済(§2.5)ゆえ policy 層でも遮断(二重)。anchor 列(schedule_id 等)を clear する UPDATE も id 不変ゆえ WITH CHECK を通る |
| DELETE | **policy なし = deny** | app role が users を hard delete する経路は存在しない(構造的封鎖) |

**SECURITY DEFINER 3 本**(owner=postgres 定義・`SET search_path = public` 固定 + **本文内は完全修飾名**・`REVOKE ALL ... FROM PUBLIC` + `GRANT EXECUTE TO recallmint_app` を同一 migration 内で(再作成時の default EXECUTE 復活を防ぐ)。app role の `public` CREATE 不可は RLS-P1 で確認済。定義者関数ゆえ policy 非適用):
1. `app_bootstrap_user_from_clerk(p_clerk_id text) RETURNS SETOF users` — `SELECT * FROM users WHERE clerk_id = $1 LIMIT 1` の忠実移植。**全列返却の理由** = getCurrentUser の契約(`User | null`)が全列を要し、露出面は pre-RLS の app role 直 SELECT と等価(新規拡大なし)。呼出面は 3 箇所限定(getCurrentUser claim なし分岐 / contact / handleUserDeleted resolve)。scrub 済み行は clerk_id=NULL ゆえ構造的に 0 行(現挙動どおり)。
2. `app_resolve_user_for_stripe(p_by text, p_value text) RETURNS TABLE(id uuid, deleted_at timestamptz)` — `whereFor` 4 arm の忠実移植。**p_by は allowlist(4 値以外 RAISE)・返却列は最小 2 列**(Codex 指摘採用)。**退会済み行も返す**(呼出側の log + skip 判定に必要、§2.5)。呼出側はこれで context を張る(set_config)。
3. `app_scrub_deleted_user(p_user_id uuid) RETURNS void` — 現行 scrub UPDATE(`deletedAt=now(), email=NULL, clerkId=NULL WHERE id=$1`)の**ロジックを正とした忠実移植**(NULL 化対象・順序を変えない。再設計禁止)。**0 行 = no-op(void・不検査)は現行 unchecked-silent 挙動の維持**(再削除は resolve 段の 0 行 return で実質不達、FF §3.1。GPT の「1 行以外 RAISE」を覆す採用理由は §7 意図的変更)。**definer 自衛(OT 追加条件)**: 関数冒頭で `p_user_id = app_current_user_id()` を検査し不一致なら RAISE(`ERRCODE = 'P0RLS'`)。SECURITY DEFINER は RLS を迂回するため、呼出側が context と異なる任意 uuid を scrub する経路を関数内で構造的に封じる(context は handleUserDeleted の tx 冒頭で internalUserId に set 済ゆえ正常系は常に一致)。

### 2.4 認証配管(GPT 修正 1 採用形)

`getCurrentUser()` の新形 — **claim 有無で最初に分岐**:
- **claim あり**(`sessionClaims.dbUserId` 非 undefined): `set_config('app.user_id', dbUserId)` を張った tx で `SELECT … FROM users WHERE id = dbUserId`(WHERE は従来の clerk_id lookup から id lookup へ変わる — アプリ層 WHERE 併記 + policy の二重は維持)。0 行(ghost = 削除済み / 行消失)→ **null を返し既存 null 契約に合流。bootstrap へ fallback しない**。
- **claim なし**: `app_bootstrap_user_from_clerk(clerkId)` のみ(sign-up race / 旧 session)。0 行 → null(現挙動)。
- Clerk session なし → `UnauthenticatedError` throw(不変)。React `cache()` 維持。
- `getAuthContext()` は不変(claim 読みのみ・SELECT なし)。利用 4 RSC page は set_config のみで自 query を張る(users SELECT 不要のまま)。
- **invariant 明文化**: request 経路から users INSERT しない(lazy upsert 禁止 = webhook-only sync、FF §1.4 の R2 設計を規範化)。
- null 契約 7 分類(FF §2.2 の表)は**受け側無変更**。変わるのは lookup の内側のみ。

### 2.5 users lifecycle / Stripe 経路の配管

- **user.created**: **事前採番 INSERT** — app 側で UUID 生成 → **単一 withTenantTx(新 uuid)内で** 存在チェック(`app_bootstrap_user_from_clerk`・context 非依存)→ 既存なら INSERT せず metadata sync も skip(現行 conflict 分岐と同じ帰結)/ 不在なら `INSERT (id, clerk_id, email)`(**RETURNING・onConflict 不使用**、WITH CHECK id=context を通過)。チェック→INSERT の race は webhook dedupe(event 単位)+ clerk_id UNIQUE が最終防衛 — 重複時は unique violation → outer catch 200 + 通知。**現行の silent conflict-skip との差 = 通知が出る**(頻度は dedupe により実質ゼロ、運用ノイズ差として受容 — Codex 指摘の明文化)。
- **user.deleted**: resolve = `app_bootstrap_user_from_clerk`(0 行 → notifyOps + return、文言は §2.6)→ Stripe cancel ループ(tx 外・不変)→ tx: 冒頭 set_config(internalUserId)→ scrub は `app_scrub_deleted_user` 呼出、Group I 10 表 DELETE + assets UPDATE は現行文のまま(policy `user_id = fn()` を通る)。`runTransactionWithRetry` 不変。
- **Stripe webhook / upgrade actions**: 各経路の冒頭で `app_resolve_user_for_stripe` により id 解決 → **deleted_at 非 NULL なら log + skip**(新規の明示挙動: 現状は scrub 行にも silent write が通り得た)→ set_config(id)→ 既存 `whereFor` write 群は不変(WHERE 併記 + policy の二重)。`.returning → matched` の既存分岐(saveProjection / applyDeletedReset)は**現状維持**(既存挙動保全 — RETURNING 禁止は lifecycle write のみ、§6 論点 1)。
- **checkout Step 1**(users UPDATE by clerk_id、unchecked)/ 予約 clear 系(matched 破棄)/ `bumpExamCardCount`: **0 行 semantics は現状維持**。変更は context 供給のみ。RLS 起因の 0 行は loud 関数(context 未設定)と policy(別 tenant)が先に例外/遮断するため、既存の冪等吸収と混ざらない(§0.4)。

### 2.6 notifyOps 文言(修正 2 の採用分)

- 判別条件の検証結果: scrub が clerk_id を消すため「未同期」と「削除済み再配信」は **clerk_id からは構造的に判別不可能**(clerk_events は user 相関を持たない)。確定の条件節(「判別可能なら」)は**不成立**。
- 採用 = 文言の中立化のみ: `'user.deleted received but users row not found (not-synced or already-deleted)'` 相当へ変更(通知経路・payload 構造は不変)。

### 2.7 配管の適用サイト(5 表に触る全経路 — sweep 済み)

- **tx なし read → withTenantTx 包み + helper に db 引数追加**: `/api/pull`(6 stream を 1 tx 直列 — 素朴直列)/ `/api/study-days/pull` / `/api/dashboard/stats`(raw SQL 2 本)/ exam 系 read 4 関数(list.ts)/ `getSessionCards` / upload page の `getActiveExamsForUser`。
- **既存 tx → 冒頭 `setTenantContext(tx, userId)` 追加(全 10 本一律)**: guard tx / saveExtractedCards / completeUploadTx / markFailed / delete-exam / incrementAiUsage / processMutation(per-mutation)/ handleUserDeleted / processSession / reconcileStaleProcessing。
- **単文 write → withTenantTx 包み**: create-exam(exams INSERT は WITH CHECK 対象)。
- **users 特殊経路**: getCurrentUser / contact / clerk webhook / stripe webhook / upgrade actions(§2.4-2.5)。
- wrapper = `lib/db/tenant-tx.ts` の `withTenantTx(db, userId, fn)` + `setTenantContext(tx, userId)`(2 形態のみ・新レイヤー最小)。**raw `getDb()` の将来封じは Phase 3 で lint / export 制限**(本 sprint は方針明記のみ)。
- **5 表に触る helper の db 引数は必須(optional default にしない)**: 配線漏れを compile error に倒す(Codex 指摘採用。optional `= getDb()` は渡し忘れが型検査を素通りし、runtime の loud 検出まで潜伏する)。対象 = getDeltaRows + 6 delta module / list.ts 4 関数 / streak / study-days-pull / get-session-cards / §2.8 の 3 関数。
- **適用サイトの証跡**: 5 表 × 操作 × 経路 × context 供給元 × `eq(userId)` 有無の対応マトリクスを `tests/integration/pg/COVERAGE.md` に追記(レビュー可能な形で固定 — Codex 指摘採用)。

### 2.8 Perf-0 §6.6 correctness fix

`canRunOcr` / `getCurrentMonthOcrPages` / `getTodayAiUsageGlobal` に db/tx 引数を追加し、guard tx から tx を渡す(tx 保持中の別接続 read 2 本を解消)。advisory lock 下で quota 判定という現行セマンティクス不変(「外に出す」案は TOCTOU 窓が広がるため不採用)。upload-guard.ts:90 の旧コメント(「tx に属さなくてよい」)は訂正。

### 2.9 migration / policy の持ち方と適用順序

- **functions(0025)= 通常 drizzle migration**: loud 関数 + SECURITY DEFINER 3 本 + EXECUTE grants。旧コード未参照 = 先行適用無害。**RLS 状態を持たないため prod にも適用可**(将来 develop からの prod deploy とのコード互換を保つ。適用は OT 判断)。
- **policies = Phase 2 では migration にしない**: versioned SQL 2 file(`db/policies/rls-p2-enable.sql` = ENABLE RLS + policy 群 + `SET lock_timeout` / `rls-p2-disable.sql` = DISABLE ×5)。適用は (i) **test:iso global-setup が migrate 後に適用**(grants file の既存前例と同機構)(ii) **stg は OT が SQL Editor 実行**。**理由(Codex 指摘採用)**: 0025/0026 を両方 drizzle migration にすると `db:migrate` 1 run で両方適用され「functions → deploy → policies」の順序が構造的に壊れる + prod への policy 混入経路になる。**Phase 3 で policy を migration に昇格**(全表展開時)。
- 適用順序(stg): **① 0025 migrate(OT・ADMIN inline)→ ② 新コード deploy(関数を使うが RLS off = 挙動不変)→ ③ enable SQL 適用(RLS on)→ ④ smoke + after 計測**。逆順(policy 先行)は旧コードが loud fail するため禁止。
- rollback: 即時 = `rls-p2-disable.sql`(policy/関数残置で無害)。zero-users ゆえ破壊的変更自由。**rollback 演習を stg 手順に含める**(§4)。
- test:iso は migrate + enable SQL 適用で **既存 85 本が RLS on で走る**。drizzle `pgPolicy`(schema 定義)採否の plan Step 0 評価(確定 8)は「policy を schema 定義に持てるか」の Phase 3 向け評価として維持(Phase 2 の適用機構は上記で確定)。

---

## 3. 検証設計

### 3.1 test:iso 追加(すべて実 PG・app role・新規 assertion = 保証増 → red 検証 + 簡易 review)

1. **既存 85 本 green(RLS on)** = 「動く」。既存 test の追随: 検証用 ground-truth read を owner 接続(`TEST_DATABASE_URL`)へ寄せ、app 関数直呼びは withTenantTx 包みへ(本番呼出形と同型化)。
2. **RLS 単独防御**(「WHERE を外しても RLS が止める」): test 内から app role で `eq(userId)` **なし**の直接 query を発行し、A context で B の行が read 不可視 / write 不達(5 表 × read/write 代表)。app コード変異でなく test 内直接クエリで RLS 層を単独証明。
3. **per-command 検証**(Codex 指摘採用): cards 代表で INSERT WITH CHECK 拒否 / UPDATE USING(他 tenant 行不達)/ **UPDATE WITH CHECK(自行の user_id を他 tenant へ付替え拒否)** / DELETE 0 行 の 4 操作を個別 assert。users は 6 項目(scrub 済み行 SELECT 不可 / 同 UPDATE 不可 / INSERT id≠context 拒否 / UPDATE id 変更拒否 / DELETE 常時拒否 / definer scrub のみ成功)。
4. **context 漏れ / loud**: A/B 交互 tx 反復(COMMIT・ROLLBACK 両系)→ 残留なし。set_config なし tx / tx 外 query → SQLSTATE `P0RLS` を assert(未設定 NULL / revert 空文字の両形態)。**空表・対象 0 行でも各コマンドで RAISE または 0 行(漏れなし)となることを実測 pin**(loud 保証範囲 §2.1)。**wrapper 実 PG 検証**: tx 内 `current_setting` 可視 / ROLLBACK 後 GUC 消滅 / per-mutation tx(savepoint 構造)で context 維持。
5. **ghost JWT(確定 4)— 期待値を操作別に固定**(Codex 指摘採用): scrub 済み UUID context で、5 表 read = 0 行(users は `deleted_at IS NULL` により 0 行)/ 4 表 INSERT(ghost user_id)= WITH CHECK 拒否(SQLSTATE 実測 pin)/ UPDATE・DELETE = 0 行。**owner ground-truth で「削除 tx 後に当該 UUID の行が 4 表に残存しない」ことも確認**(削除漏れを RLS 不可視と混同しない)。
6. **FK cascade 実動作**(Codex 指摘採用): app role の deleteExam(A)で cascade が完走し B の decoy 行が不変・件数一致を owner ground-truth で確認(cascade = RLS 非適用の実証)。
7. **null 契約 pin(修正 1)**: getCurrentUser 新形の分岐 4 系 pin + **受け側 7 分類 × 担保 test の対応表を COVERAGE.md に記録**(「既存資産で担保」の根拠を監査可能に — Codex 指摘採用)。
8. **lifecycle behavioral**: 再削除 no-op(中立文言含む)/ created 遅着 = 新規行 / 退会後 Stripe log+skip(**外部副作用が skip より先に起きないことを含む**)/ dedupe-first 順序 pin。
9. **red 検証の粒度**(Codex 指摘採用): 表単位 DISABLE で当該表の leak test 群が fail + cards・users は USING / WITH CHECK **clause 単位の変異**(片方を恒真化)で該当 assert のみ fail を実測 → 復旧後 green 再確認(commit message に「red 検証」記録)。
10. **partial 残余の連鎖回帰**: 同一 request で RLS 表 + 非 RLS 表を跨ぐ代表 2 経路(bulk mutation の cards+tags / pull の mixed 6 stream)が挙動不変であることを pin。

### 3.2 性能(stg・Perf-0b 同条件)

- Playwright MCP・warm 5 捨て 30 回・p50/p95 nearest-rank・同 seed(`[PERF-SEED] 300`)。対象 = dashboard / exams 一覧 / exam 詳細 / upload / pull full / pull delta(before = Perf-0b §3.2)。
- 合格 = 各経路 p95 悪化 ≤ max(+10%, +20ms)、pull full のみ p50/p95 とも +40ms 予算。超過 = 高度化(チャンク分割等)を別 task 起票し OT 判断(確定 2 の after 条項)。

### 3.3 stg 実機(pooler 越し)

- smoke: 通常操作一巡(upload→OCR→編集→復習→削除)+ `current_user` 確認 + error log に `P0RLS` が出ないこと(= 全経路 context 供給済の実証)。
- **2nd Clerk test user で A/B pull**: 交互 ×30(残留検査)+ **並行同時 ×N(接続再利用・競合時の純度検査 — Codex 指摘採用)**。応答行の user_id 純度突合。「漏れない」の正は test:iso、stg は実機補強。
- **pool 指標の併記**(Codex 指摘採用): 計測時に Supabase dashboard の pool utilization / connection wait / 同時接続 peak を OT が記録(Perf-0 §7 の未取得項目と統合)。単発 latency では pool 圧悪化を検出しにくいことへの補完。フル負荷試験は Phase 3 prod rollout 側(YAGNI)。
- 監視形(明文化): loud 例外はアプリ層で `P0RLS` を専用 log event(経路・query 種別・**UUID/PII 非搭載**)に変換。alert 条件設計は Phase 3 申し送り。

---

## 4. OT 実行手順(骨子 — plan で全文確定)

1. stg: 0025 migrate(ADMIN inline)→ 2. OT push → stg deploy → 3. `rls-p2-enable.sql` を SQL Editor 適用 + **適用後確認 SQL**(`pg_policies` の 5 表 policy 存在 + `pg_class.relrowsecurity`)→ 4. **rollback 演習**: `rls-p2-disable.sql` → 簡易 smoke → 再 enable(戻せることの実証 — Codex 指摘採用)→ 5. CC が stg smoke + after 計測(§3.2-3.3)→ 6. 結果報告 → OT 判断。
- **sprint 完了の定義 = stg 実証(§3.2-3.3)合格まで**。code 完了 + test green は中間 checkpoint であり、stg 実証前に sprint を close しない(Codex 指摘採用 — Goal「stg で実証」に完了条件を一致させる)。
- **prod へは出さない**(Phase 2 は stg 限定・短期間)。policy は versioned SQL ゆえ migrate 経路から prod へ混入しない(§2.9)。**コード側の挙動変更(claim-first / log+skip / 定義者関数呼出)は通常の prod deploy に乗り得るため、Phase 2 期間中に prod deploy する場合は 0025 の prod 適用とセットで OT 判断**(関数不在の prod に新コードが出る組合せを禁止 — Codex 指摘採用)。

### 4.1 Phase 3 申し送り(spec レベル)

- **tx 境界の DDD 整理を Phase 3 Step 0 の正式項目とする**: use-case 入口で `withTenantTx` を張り、repository / apply 層は `TenantTx` のみを受け取る構造へ寄せ、raw `getDb()` を封じ込める(lint / export 制限)。Phase 2 の「5 表 helper の dbc 必須引数」はその第一歩の位置づけ。
- 標準反復部分(共通形 policy + set_config 配線)と特殊設計部分(users の definer 3 本 / lifecycle / Stripe / review-ingest の完全 closure)を成果物として切り分け、後者は Phase 3 で再設計対象と明示。
- loud 例外の alert 条件設計(§3.3 監視形)。

## 5. 非目標(YAGNI)

全表展開(Phase 3)/ tag 3 表・review-ingest 系の closure 化 / FORCE RLS / user tombstone / lifecycle への advisory lock / affected-rows 一括検査 / チャンク分割等の高度化(after 悪化時のみ)/ prod 反映 / raw getDb の lint 封じ(Phase 3)。

## 6. 論点の確定(OT 決定・2026-07-20)

1. **RETURNING・upsert 禁止 = users lifecycle write(user.created INSERT / scrub)限定**。subscription 系 UPDATE の `.returning → matched` 分岐(saveProjection / applyDeletedReset)は既存挙動保全で維持。
2. **notifyOps = 中立文言のみ**。「未同期 vs 削除済み再配信」の判別情報はデータ上不在(scrub が clerk_id を消す)= tombstone 却下の受容コストとして記録(§7)。
3. **users UPDATE policy に `deleted_at IS NULL` を含める**(log+skip との二重遮断)。将来の管理・復旧処理は definer / owner 経路へ明示分離する(Codex 条件・Phase 3 申し送り)。
4. **bootstrap 関数 = `SETOF users` 維持**。返却は呼出者自身の行で RLS 下の可読内容と同一、露出面は pre-RLS と等価・呼出 3 箇所限定。Codex の最小列化見解は記録し不採用。

(解消済み: SQLSTATE = `P0RLS`(§2.1)/ policy 適用機構 = versioned SQL(§2.9))

## 7. 意図的変更の記録(既存挙動から意図して変える点)

1. **scrub 0 行 = no-op を採用(GPT の「1 行以外 RAISE」を覆す)**。根拠 = webhook 常時 200 + 再送自動リカバリなしの設計では RAISE がノイズにしかならず、既存の値レベル冪等(NULL 上書き・DELETE 再実行安全、FF §1.4)と no-op が整合する。再削除は resolve 段の 0 行 return で実質不達ゆえ scrub まで 0 行が到達する経路自体が稀。definer 自衛の一致検査(§2.3)は「context と異なる uuid の scrub」を弾くもので「0 行の scrub」を弾くものではない(直交)。
2. **退会後 Stripe イベント = log + skip**(§2.5)。現状は scrub 済み行にも silent write が通り得たものを明示遮断へ。
3. **user.created の silent conflict-skip → 通知付き**(§2.5)。頻度は dedupe により実質ゼロ、運用ノイズ差として受容。
4. **notifyOps 文言中立化**(§2.6・上記 6-2)。
