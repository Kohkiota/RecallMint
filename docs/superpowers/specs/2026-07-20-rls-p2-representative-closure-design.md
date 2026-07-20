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

- GUC = `app.user_id` 単一。設定は各 tx 冒頭で `SELECT set_config('app.user_id', <uuid>, true)`(tx-local、COMMIT/ROLLBACK で消滅 = pooler 越しでも漏れない)。
- `app_current_user_id() RETURNS uuid`(plpgsql, STABLE): `nullif(current_setting('app.user_id', true), '')` が NULL なら **RAISE EXCEPTION**(専用 SQLSTATE、例: `P0RLS` 相当のカスタム code — 値は plan で確定し test が pin)。非 NULL なら `::uuid`。silent の 2 形態(未設定 = NULL / SET LOCAL 後 revert = 空文字)を両方 loud に倒す。
- policy 内では `(SELECT app_current_user_id())` と包み initPlan 化(per-row 評価回避)。

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

**SECURITY DEFINER 3 本**(owner 定義・`SET search_path = public` 固定・`REVOKE ALL ... FROM PUBLIC` + `GRANT EXECUTE TO recallmint_app`。定義者関数ゆえ policy 非適用):
1. `app_bootstrap_user_from_clerk(p_clerk_id text)` — `SELECT * FROM users WHERE clerk_id = $1 LIMIT 1` の忠実移植。用途 = claim なし時の getCurrentUser bootstrap / contact の userId 解決 / handleUserDeleted の resolve。scrub 済み行は clerk_id=NULL ゆえ構造的に 0 行(現挙動どおり)。
2. `app_resolve_user_for_stripe(p_by text, p_value text)` — `whereFor` 4 arm の忠実移植で `(id, deleted_at, clerk_id, stripe_customer_id, …slice 最小列)` を返す。呼出側はこれで context を張り(set_config)、deleted_at 非 NULL なら **log + skip**(§2.5)。
3. `app_scrub_deleted_user(p_user_id uuid)` — 現行 scrub UPDATE(`deletedAt=now(), email=NULL, clerkId=NULL WHERE id=$1`)の**ロジックを正とした忠実移植**(NULL 化対象・順序を変えない。再設計禁止)。

### 2.4 認証配管(GPT 修正 1 採用形)

`getCurrentUser()` の新形 — **claim 有無で最初に分岐**:
- **claim あり**(`sessionClaims.dbUserId` 非 undefined): `set_config('app.user_id', dbUserId)` を張った tx で `SELECT … FROM users WHERE id = dbUserId`(WHERE は従来の clerk_id lookup から id lookup へ変わる — アプリ層 WHERE 併記 + policy の二重は維持)。0 行(ghost = 削除済み / 行消失)→ **null を返し既存 null 契約に合流。bootstrap へ fallback しない**。
- **claim なし**: `app_bootstrap_user_from_clerk(clerkId)` のみ(sign-up race / 旧 session)。0 行 → null(現挙動)。
- Clerk session なし → `UnauthenticatedError` throw(不変)。React `cache()` 維持。
- `getAuthContext()` は不変(claim 読みのみ・SELECT なし)。利用 4 RSC page は set_config のみで自 query を張る(users SELECT 不要のまま)。
- **invariant 明文化**: request 経路から users INSERT しない(lazy upsert 禁止 = webhook-only sync、FF §1.4 の R2 設計を規範化)。
- null 契約 7 分類(FF §2.2 の表)は**受け側無変更**。変わるのは lookup の内側のみ。

### 2.5 users lifecycle / Stripe 経路の配管

- **user.created**: **事前採番 INSERT** — app 側で UUID を生成 → `set_config('app.user_id', <新 uuid>)` → `INSERT (id, clerk_id, email)`(**RETURNING・onConflict 不使用**)。再配信 / 既存判定は INSERT 前に `app_bootstrap_user_from_clerk` で存在チェック(既存なら INSERT せず metadata sync も skip = 現行 conflict 分岐と同じ帰結)。存在チェック→INSERT の race は webhook dedupe(event 単位)+ clerk_id UNIQUE 制約が最終防衛(重複時は unique violation → outer catch 200 + 通知、現行の再送吸収と同水準)。
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

### 2.8 Perf-0 §6.6 correctness fix

`canRunOcr` / `getCurrentMonthOcrPages` / `getTodayAiUsageGlobal` に db/tx 引数を追加し、guard tx から tx を渡す(tx 保持中の別接続 read 2 本を解消)。advisory lock 下で quota 判定という現行セマンティクス不変(「外に出す」案は TOCTOU 窓が広がるため不採用)。upload-guard.ts:90 の旧コメント(「tx に属さなくてよい」)は訂正。

### 2.9 migration 形と適用順序

- **migration 2 本に分割**(rollout 順序の構造化):
  - **0025(functions)**: loud 関数 + SECURITY DEFINER 3 本 + EXECUTE grants。旧コードから未参照 = 先行適用しても無害。
  - **0026(policies)**: 5 表 `ENABLE ROW LEVEL SECURITY` + policy 群。
- 適用順序(stg): **① 0025 migrate(OT・ADMIN inline)→ ② 新コード deploy(関数を使うが RLS off = 挙動不変)→ ③ 0026 migrate(RLS on)→ ④ smoke + after 計測**。逆順(policy 先行)は旧コードが loud fail するため禁止と明記。
- rollback: 即時 = 5 表 `DISABLE ROW LEVEL SECURITY`(SQL Editor・policy/関数残置で無害)。恒久 = revert migration。zero-users ゆえ破壊的変更自由。
- test:iso は migration 自動適用で両方入る = **既存 85 本が RLS on で走る**。drizzle `pgPolicy`(schema 定義)採否は plan Step 0 評価(確定 8)— 不採用なら手書き SQL migration(0005/0007 の data-migration 前例と同機構)。

---

## 3. 検証設計

### 3.1 test:iso 追加(すべて実 PG・app role・新規 assertion = 保証増 → red 検証 + 簡易 review)

1. **既存 85 本 green(RLS on)** = 「動く」。既存 test の追随: 検証用 ground-truth read を owner 接続(`TEST_DATABASE_URL`)へ寄せ、app 関数直呼びは withTenantTx 包みへ(本番呼出形と同型化)。
2. **RLS 単独防御**(「WHERE を外しても RLS が止める」): test 内から app role で `eq(userId)` **なし**の直接 query を発行し、A context で B の行が read 不可視 / write 0 行 or 拒否(5 表 × read/write 代表)。app コード変異でなく test 内直接クエリで RLS 層を単独証明。
3. **context 漏れ / loud**: A/B 交互 tx を反復(COMMIT・ROLLBACK 両系)→ 前 tenant の残留なし。set_config なし tx / tx 外 query → RAISE を assert(未設定 NULL と revert 空文字の両形態)。
4. **ghost JWT(確定 4)**: scrub 済み user の UUID を set_config した状態で、**5 表すべて** read 0 行(users は SELECT policy の `deleted_at IS NULL` により 0 行)/ write 0 行 or 拒否。
5. **null 契約 pin(修正 1)**: getCurrentUser 新形の分岐 — claim あり + 行あり = row / claim あり + ghost = null(bootstrap へ fallback しないこと)/ claim なし + 未同期 = null / session なし = throw — を pin。受け側 7 分類は既存 test 資産で不変確認。
6. **lifecycle behavioral**: 再削除 no-op(通知文言含む)/ created 遅着 = 新規行 / 退会後 Stripe イベント log+skip / dedupe-first 順序 pin(変更不要の現状 pin)。
7. red 検証の型: policy DROP / DISABLE 状態で 2-4 が fail することを変異実測(commit message に「red 検証」記録)。

### 3.2 性能(stg・Perf-0b 同条件)

- Playwright MCP・warm 5 捨て 30 回・p50/p95 nearest-rank・同 seed(`[PERF-SEED] 300`)。対象 = dashboard / exams 一覧 / exam 詳細 / upload / pull full / pull delta(before = Perf-0b §3.2)。
- 合格 = 各経路 p95 悪化 ≤ max(+10%, +20ms)、pull full のみ p50/p95 とも +40ms 予算。超過 = 高度化(チャンク分割等)を別 task 起票し OT 判断(確定 2 の after 条項)。

### 3.3 stg 実機(pooler 越し)

- smoke: 通常操作一巡(upload→OCR→編集→復習→削除)+ `current_user` 確認 + error log に context-RAISE が出ないこと。
- **2nd Clerk test user を作成し A/B 交互 pull ×N**: 応答行の user_id 純度突合(Supavisor 実機での context 漏れ確認)。「漏れない」の正は test:iso、stg は実機補強。

---

## 4. OT 実行手順(骨子 — plan で全文確定)

1. stg: 0025 migrate(ADMIN inline)→ 2. OT push → stg deploy → 3. 0026 migrate → 4. CC が stg smoke + after 計測(§3.2-3.3)→ 5. 結果報告 → OT 判断。rollback = `DISABLE ROW LEVEL SECURITY` ×5(即時)。**prod へは出さない**(Phase 2 は stg 限定・短期間、prod 反映は Phase 3 完了後に一括)。

## 5. 非目標(YAGNI)

全表展開(Phase 3)/ tag 3 表・review-ingest 系の closure 化 / FORCE RLS / user tombstone / lifecycle への advisory lock / affected-rows 一括検査 / チャンク分割等の高度化(after 悪化時のみ)/ prod 反映 / raw getDb の lint 封じ(Phase 3)。

## 6. 未解決論点(spec review で OT 確認)

1. **RETURNING・upsert 禁止の適用範囲の解釈**: users の lifecycle write(user.created INSERT / scrub)に限定し、subscription 系 UPDATE の `.returning → matched` 分岐(saveProjection / applyDeletedReset)は既存挙動保全を優先して維持 — この読みで確定してよいか(全面禁止だと FF §3.1 の checked 群が壊れ、確定 9 と矛盾するため CC はこの読みを推奨)。
2. **notifyOps 文言**: 判別条件(deletedAt 行の存在で判別)は scrub 設計上**不成立**(§2.6)→ 中立文言のみ採用で確定してよいか。
3. **users UPDATE policy の `deleted_at IS NULL`**: 含める(CC 推奨・log+skip との二重遮断)か、`id = fn()` のみとするか。
4. **loud 関数の SQLSTATE 値**: カスタム code の具体値は plan で確定し test が pin する(ここは委任の確認のみ)。
