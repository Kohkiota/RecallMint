# LocalSync MVP (local 完全移行) pre-investigation — 問題 2/3 + 東京移行後の最新状態

- 日時: 2026-05-29
- 種別: investigation / session log (**実装変更・commit なし**、 成果物は本 doc のみ)
- 対象 branch: `develop` (問題 2 `5e86839` / 問題 3 `0e78ef0` / 東京移行 `f87cf6e`・`dd1ddff` 反映後)
- 目的: cache-fix roadmap §5 LocalSync MVP の着手前に、 (1) push/pull 経路の全棚卸し (2) card_mutations 現状 (3) 5/27 確定スコープ (roadmap §5.1) の現状コードでの成立検証 (4) 問題 2/3 patterns の適用先 (5) Small Fix 完了確認 (6) 5/26 doc 乖離照合 (7) scope 拡張候補のコスト評価 (8) 東京移行後 latency 基準線、 を実コード行根拠で確定する
- 手段: grep + 実コード read。 6 軸を並列 subagent で fact-find → 高 stakes 訂正は本人 spot-check (`update-card-field.ts` の実パス / `SyncStatus` 値数 / `sync_meta` key / `inFlightEventIds` / `toPgTimestamptz`)
- 関連: `docs/cache-fix-roadmap.md` §3-5、 `docs/superpowers/specs/2026-05-26-s-local-1-design.md`、 `docs/superpowers/sessions/2026-05-27-localsync-pre-investigation.md` (前回 pre-inv、 5/27)、 `docs/superpowers/sessions/2026-05-29-tokyo-region-after-measurement.md` (基準線)

---

## 0. 全体結論サマリ

| 軸 | 結論 (1 行) |
| --- | --- |
| A push/pull | pull は **PullTrigger (layout mount 1 回) のみ**・3 endpoint GET。 push は **answer_events のみ**・2 trigger (5 件閾値 / session 完了)。 `card_mutations` flush・online/visibilitychange/pagehide listener は **全て未配線** |
| B card_mutations | 両端 schema 済 (Dexie 4-value `SyncStatus` / server migration `0012`)、 **producer すら無い** (inline 編集は server action 直 UPDATE)。 **delete を表す列が無い** (patch jsonb のみ、 type 列なし) |
| C 5/27 spec | 大半成立。 **要変更 4 点**: ① mutation_id 形式 (spec `clientId:uuid` ↔ server `uuid`) ② 3 状態 (Dexie は 4 値) ③ delete 表現 (schema 未定義) ④ Δ pull (現 helper は clear+bulkPut 全置換、 `?since` 未対応) |
| D patterns | 5 patterns 全て適用可。 **最高 re-bite リスク = card UPDATE の raw VALUES に timestamptz(`updated_at`) と jsonb(`custom_props`) を embed** → #5789 (Date) + jsonb は `JSON.stringify()::jsonb` 必須。 INSERT は chainable builder に逃がせば回避 |
| E Small Fix | ④-1〜④-4 **全て ✅済** (実コード再 verify、 roadmap 「done」 claim と乖離なし) |
| F 5/26 doc 乖離 | audit doc は **~50% stale** (mirror read 済・JWT 化済・PullTrigger 移動を反映せず)、 inventory doc も中〜重 stale。 ただし **LocalSync に効く 3 claim (card_mutations 未配線 / user_settings 未配線 / getSyncMeta test-only) は今も accurate** |
| G scope 拡張 | 3 候補とも **同 sprint に折込むべきでない**。 user_settings のみ S コストだが payoff 薄 (mirror pull で outbox 機構を共有しない)。 exam_mutations は新 table+新 UI で L、 source_documents は quota 改ざん risk で要 display-only |
| H 基準線 | 東京移行後: bulk flush **769ms** / DB pull **sub-400ms** / 演習→dashboard 遷移 **656ms**。 LocalSync の効果軸は **inline 編集 ~2.5s→~50ms** (体感終端とは別軸、 bulk/pull は既に co-location で軽い) |

**着手 blocker: なし。** schema は両端 scaffold 済。 LocalSync MVP は ① sync helper (`lib/sync/card-mutations.ts`) ② bulk route ③ orchestrator ④ inline 編集の producer 化 ⑤ Δ pull 化、 の新規実装。 spec 起草時に下記 §9 の 4 要変更点 + 5 決定事項を確定する。

---

## 軸A. push/pull タイミング全棚卸し (問題 2/3 適用後)

### A-1. pull 経路 (server → client mirror)

| trigger (file:line) | 発火 | 取得 |
| --- | --- | --- |
| `app/(app)/app/_components/pull-trigger.tsx:22-35` (useEffect deps `[]`) | **layout mount 1 回**のみ (deep link / reload / 外部遷移 / BFCache reload)。 内部 nav では再 mount せず再発火しない | `pullAllCards()` + `pullAllExams()` + `pullAllStudyDays()` を fire-and-forget (`.catch()` silent) |
| `app/(app)/app/layout.tsx:51` `<PullTrigger />` | 唯一の mount site (`(app)` segment layout、 `<BFCacheGuard/>` + `<AppHeader/>` 隣) | 上記を mount |
| `lib/sync/cards.ts:52` `pullAllCards()` → GET `/api/cards/pull` (`route.ts:18`) | PullTrigger | Dexie `cards` を **atomic clear()+bulkPut()** で全置換 + `sync_meta.lastCardPullAt` 書込 (`cards.ts:70-76`) |
| `lib/sync/exams.ts:25` `pullAllExams()` → GET `/api/exams/pull` (`route.ts:13`) | 同上 | Dexie `exams` 全置換 |
| `lib/sync/study-days.ts:37` `pullAllStudyDays()` → GET `/api/study-days/pull` (`route.ts:18`) | 同上 | Dexie `study_days` 全置換 (dashboard streak/todayCount 元、 S-perf-3) |

→ pull は **mount-only、 event/poll 駆動なし**。 push 後に server で再計算された FSRS 値を client mirror に戻す pull counterpart は無い (次の full reload まで mirror は古いまま)。

### A-2. push 経路 (client → server)

| trigger (file:line) | 種別 | 発火条件 | 内容 |
| --- | --- | --- | --- |
| `session-runner.tsx:284-287` | **経路1** (演習中) | `recordAnswerEvent` 後 `countPendingAnswerEvents(sessionId) >= FLUSH_THRESHOLD` (=5、 `:72`) | 当該 session の pending answer_events (≥5) を POST |
| `session-runner.tsx:300-310` | **経路2** (session 完了) | useEffect `[phase, sessionId]`、 `phase==='finished'` | `completeStudySession()` → `flushAllPendingEvents()` で**全 session** の pending を sweep |
| `lib/sync/review-events.ts:245` `flushPendingEvents()` → POST `/api/review-events/bulk` (`BULK_ENDPOINT :177`) | 経路1・2 共通 | — | `{session, events[]}` POST、 synced を `synced` 化、 failed は `pending` 残置 |
| `lib/sync/review-events.ts:227` `flushAllPendingEvents()` | 経路2 のみ | — | pending を session_id 別に group → `Promise.allSettled` 並列 flush |
| `app/api/review-events/bulk/route.ts:433` POST | server | POST のみ (GET なし=pull でない) | bulk upsert (SQL は軸D) |

### A-3. in-flight guard (問題 2) — 実装位置

- `lib/sync/review-events.ts:182` `export const inFlightEventIds = new Set<string>()` (module-scope、 **IDB 非永続**、 export は test 隔離用のみ)
- `:265` `targets = pendingAll.filter((e) => !inFlightEventIds.has(e.event_id))` — in-flight 除外
- `:266-274` pending>0 かつ targets=0 (全件 in-flight) なら no-op return で POST skip
- `:278` POST 前に `event_id` 追加 / `:344` `finally` で削除 (成否問わず解放)
- **dedup 対象**: 経路1↔経路2 の**並走**重複 (同 event_id を 2 回 POST しない)。 逐次の別 invoke 間は server 冪等 (event_id UNIQUE + ON CONFLICT) 任せ

### A-4. 未配線 / 欠落 (LocalSync MVP で新設要)

- **`card_mutations` の flush trigger・endpoint・producer が全て無い** (schema/store 定義のみ、 §軸B)
- **`online`/`offline` listener が repo 全体で 0 件** (`navigator.onLine` 参照は非 test で無し)。 spec の trigger ④ (online push→pull) は未実装
- **sync 駆動の `visibilitychange`/`pagehide`/`beforeunload` 無し**。 唯一の `visibilitychange` (`exam-status-live.tsx:101-123`) は OCR status polling 用、 `beforeunload`/`popstate` (`upload-form.tsx:193-194`) は upload 中の離脱 guard。 spec trigger ②③⑤ は未実装
- **abandon flush 無し**: `abandonStudySession` (`review-events.ts:79`) は app/components から呼出 0 件、 abandoned session の pending は次 session の経路2 sweep 任せ

---

## 軸B. card_mutations 現状実装 (全 layer、 現行行番号で再 verify)

| layer | 現状 | 根拠 (file:line) |
| --- | --- | --- |
| Dexie `SyncStatus` 型 | **4 値** `'pending'｜'syncing'｜'synced'｜'failed'` | `lib/client-db.ts:30` |
| Dexie `ClientCardMutation` 型 | `local_id?` / `mutation_id` / `card_id` / `patch:Record<string,unknown>` / `edited_at` / `sync_status` / `last_attempted_at?` | `lib/client-db.ts:144-152` (patch 圧縮ロジックは「別所で実装」 と comment `:142-143`) |
| Dexie store | `card_mutations: '++local_id, mutation_id, card_id, sync_status'` (v1、 `edited_at` index 無し) | `lib/client-db.ts:181`(table) / `:196`(store) |
| `lib/sync/card-mutations.ts` | **不在** (sync 配下は cards/exams/review-events/study-days/sync-meta のみ) | `ls lib/sync/` |
| `app/api/card-mutations/` | **不在** | `ls app/api/` |
| server schema `cardMutations` | `id uuid PK` / `mutation_id uuid **UNIQUE**` / `card_id uuid FK cascade` / `user_id uuid FK cascade` / `patch jsonb NOT NULL` / `edited_at timestamptz NOT NULL` / `applied_at timestamptz null` / `created_at timestamptz defaultNow`。 index `(card_id, edited_at)` / `(user_id, edited_at)` | `lib/db/schema.ts:601-623` |
| migration | `drizzle/migrations/0012_handy_ink.sql` (CREATE TABLE + UNIQUE + FK + index、 schema と一致) | 確認済 |
| inline 編集 producer | **server action 直 Drizzle `.update(cards).set(...).where(eq id, eq userId).returning()`、 Dexie/card_mutations 書込ゼロ** | `app/(app)/app/exams/[id]/_actions/update-card-field.ts:142-146`。 呼出元 `inline-text-field.tsx:137` / `inline-option-row.tsx:218` |

### B-重要訂正 (roadmap との乖離)

- ⚠️ roadmap §5.2/§5.3 は inline 編集を **`update-card-field.ts:143/:156`** (= `lib/cards/` 想定) と記すが、 実体は **`app/(app)/app/exams/[id]/_actions/update-card-field.ts:142-146`**。 `lib/cards/update-card-field.ts` は**不在**、 roadmap §5.3 が挙げる `update-card.ts` も**不在** (card 個別 page 廃止 ④-3 で server action に統合済)
- ⚠️ **delete 表現の gap**: server schema は **patch jsonb のみで type/op 列・soft-delete flag 無し**。 delete を first-class mutation で表せない。 patch 内 sentinel で密輸する手はあるが、 規約はどこにも未定義。 schema comment (`:597-599`) も patch を「部分更新 payload」 と明記 → **delete 実装には `type` 列追加 (migration) か patch sentinel 規約のいずれかを spec で決定要** (roadmap §5.2 末尾の「要設計」 と整合、 本調査で再確認)

---

## 軸C. 5/27 確定スコープ (roadmap §5.1) の現状コードでの成立検証

| §5.1 論点 | 現状コードで成立するか | 根拠 / 要変更 |
| --- | --- | --- |
| card update を IDB 即時 + card_mutations 追加 (同 Dexie tx) | ⚠️ **未成立 (要新規)** | 現 producer は server action 直 UPDATE (`update-card-field.ts:142-146`)、 Dexie 書込ゼロ。 producer 全面差替要 |
| card **delete** を mutation 化 | ❌ **schema 未定義** | patch-only、 type 列なし (軸B)。 表現方法を spec 決定要 |
| bulk push `/api/card-mutations/bulk` を review-events pattern 踏襲 | ✅ 方針成立 (新規) | template は `review-events/bulk/route.ts` で確立 (軸D) |
| 冪等性 `mutation_id` UNIQUE + ON CONFLICT DO NOTHING | ⚠️ **形式不一致** | server `mutation_id` は **uuid 型** (`schema.ts:605`)、 spec 案は `${clientId}:${uuid}`。 server を text 化 or client を UUID v4 のみに統一要 |
| 状態 3 値 (pending/synced/failed、 syncing 持たない) | ⚠️ **Dexie は 4 値** | `SyncStatus` (`client-db.ts:30`) に `syncing` 在り。 spec で「使わない」 明文化 or 型 narrow (型変更なら Dexie version migration 要否確認) |
| trigger ①debounce 2s ②mount TTL60s ③visibilitychange ④online ⑤pagehide | ⚠️ **全て未配線** | online/visibilitychange/pagehide listener 0 件 (軸A-4)。 orchestrator 新規 |
| 編集画面/演習中の pull 抑制 | ⚠️ 判定ロジック未実装 | 現 pull は mount-only で抑制機構なし。 演習中 snapshot は React state で別途成立 (5/27 pre-inv 軸2)、 抑制は性能目的で妥当 |
| Δ pull (`cards.updated_at` ベース `?since=`、 削除は full replace で消去) | ❌ **未対応** | 現 `/api/cards/pull` は full snapshot、 helper は `clear()+bulkPut()` 全置換 (`cards.ts:70-76`)。 `?since` 追加 + helper を増分 upsert 化要 |
| dirty 上書き防止 (`sync_status='pending'` は pull で上書きしない) | ⚠️ 未実装 | 現 helper は全 clear するので pending も消える。 増分 upsert + pending skip 要 |
| 競合 last-write-wins (server 到達時刻) | ⚠️ 未実装 | server に `server_received_at` 打刻列なし (created_at で代用可否は spec 判断) |
| retry (5xx 有限+backoff / 4xx 即 failed / 409 synced) | ⚠️ 未実装 | review-events は backoff 未実装 (次 trigger 任せ)。 LocalSync で backoff 新規 |
| 24h 超 pending silent drop | ⚠️ 未実装 | orchestrator 新規 |
| user 切替分離 (`sync_meta.dbUserId` 照合 → 不一致で全 clear) | ❌ **key 不在** | `SYNC_META_KEYS` (`sync-meta.ts:12`) は pull cursor 3 種のみ、 `dbUserId`/`currentDbUserId` 0 件。 新 key + 照合ロジック要 |
| 多重 flush 防止 (Web Locks `localsync-flush`) | ❌ **未使用** | repo 全体で `navigator.locks` 0 件。 初導入、 key 命名規則 spec 策定要 |

**5/27 pre-inv が挙げた 5 決定事項は今も未解決** (schema 変化なしのため): ① mutation_id 形式統一 ② 3 値 narrow ③ `currentDbUserId` の値 (推奨=内部 dbUserId、 `getAuthContext().dbUserId`) ④ Web Locks 命名 + iOS Safari 16.4 未満 fallback ⑤ 演習開始時の pending mutations local apply 要否。

---

## 軸D. 問題 2/3 patterns の LocalSync 適用評価

future path = `POST /api/card-mutations/bulk` (card_mutations bulk INSERT + cards bulk UPDATE)。

| pattern (file:line) | 内容 | card_mutations への適用 |
| --- | --- | --- |
| **(i) in-flight guard** `review-events.ts:182,265,278,344` | module Set で event_id 単位並走除外、 finally 解放 | **別 Set `inFlightMutationIds` を `mutation_id` 単位**で。 「全 in-flight→skip」 最適化も移植可 |
| **(ii) 単一 tx + bulk VALUES SQL** `bulk/route.ts:132-408` | 1 tx 内で SELECT→INSERT(onConflictDoNothing)→in-mem replay→bulk UPDATE。 cards UPDATE は `UPDATE…FROM (VALUES …) AS v` を `sql` template tuple で構築 (`:309-341`) | **INSERT は Drizzle chainable `.values().onConflictDoNothing()` に逃がす (安全)**。 cards UPDATE は raw VALUES template が必要 (Drizzle に multi-row UPDATE builder 無し) |
| **(iii) serializeDbError** `lib/db/serialize-db-error.ts:59-142` | pg error の code/detail/constraint + bind params の型分布・`hasInvalidDate` 異常 flag 抽出、 never throw | **as-is 再利用**。 seed を `{cardIds, mutationIds}` に。 jsonb bind ミスは `paramsTypeDistribution` に `object`、 timestamptz ミスは `hasInvalidDate` で顕在化 = #5789-class 回帰の検出器 |
| **(iv) RETURNING 件数照合** `bulk/route.ts:341-355` | UPDATE `.returning(id)` を意図件数と比較、 不一致で throw→rollback | **cards UPDATE 側のみ適用**。 ⚠️ **INSERT 側に適用するな** — onConflictDoNothing で再送時 < input は冪等の正常動作 (`:219-234` と同じ扱い) |
| **(v) timestamptz ISO bind** `bulk/route.ts:104-106,309,333` | `toPgTimestamptz(d)=d.toISOString()`。 `sql` template に生 Date を embed すると postgres-js timestamptz serializer を bypass → `TypeError` (#5789)。 `$onUpdate` の Date も `:333` で手動上書き | **raw `sql` template 内の全 timestamptz に `toPgTimestamptz` 必須** |

### D-リスク (新規 bulk 経路の再 bite)

1. **#5789 再 bite (最有力)**: cards bulk UPDATE は raw VALUES template になる → `updated_at` (timestamptz) を生 Date で入れると即発火。 `$onUpdate` (`schema.ts:313`) は bulk UPDATE で bypass されるので頼れない (`:333` が手動 rebind する理由)。 → `toPgTimestamptz` を踏襲。
2. **jsonb の raw VALUES (前例なし)**: `patch` / `cards.custom_props` は jsonb。 現 route の VALUES tuple は scalar のみ = jsonb 前例ゼロ。 raw に入れるなら **`${JSON.stringify(x)}::jsonb`** 必須 (生 object は `[object Object]` 等で壊れる)。 → INSERT を chainable に逃がせば patch jsonb + edited_at timestamptz とも正規 serializer 経由で安全。
3. **同一 card_id 複数 mutation**: 1 payload 内に同 card_id が複数あると cards UPDATE の VALUES に重複 id → `cards.id=v.id` join が曖昧 (Postgres 任意選択)。 → review path の `finalStates` fold (`:245,264`) 同様、 **card 単位で patch を先 merge** してから 1 tuple/card に。
4. **owner-scope + FK cascade**: cards UPDATE は `eq(cards.userId, user.id)` 維持 (CLAUDE.md Clerk #4)。 cascade 削除済 card 参照は 0-row UPDATE → (iv) 照合で rollback→failed[] (望ましい挙動、 ただし照合 wiring が前提)。

---

## 軸E. Sprint Small Fix 完了確認 (実コード再 verify)

| 項目 | verdict | 根拠 |
| --- | --- | --- |
| ④-1 PullTrigger 全ページ配備 | ✅済 | `<PullTrigger />` は `layout.tsx:51` のみ (import `:5`)。 `page.tsx:15` は comment のみで JSX 無し。 mount=`(app)` 全ページ |
| ④-2 `<Link prefetch={false}>` 漏れ | ✅済 | `(app)` 配下の全 `<Link>` に付与: app-header 5 link / page.tsx:36 / exams/page.tsx:53,80 / exams/[id]/page.tsx:41,66 / settings 法的 4 link (130-145) / dashboard-actions.tsx:72 / upload/page.tsx:78 / study-session-host.tsx:118。 未付与は marketing/auth のみ (scope 外・設計通り) |
| ④-3 `/app/cards/[id]` 廃止 | ✅済 | `app/(app)/app/cards/` 不在。 live link/router.push ゼロ (残るは comment と「旧 Link 不在」 を assert する test `inline-card-list.test.tsx:65`) |
| ④-4 notifyOps 404 silent skip | ✅済 | `clerk-metadata.ts:54-59` で 404 は `console.debug` + `return {ok:true}`、 `:60-67` で真の失敗のみ `notifyOps` |

→ **4 件とも roadmap 「done」 claim と乖離なし**。 行番号も現行で一致。

---

## 軸F. 5/26 audit / inventory doc の現状コード乖離

### F-1. `2026-05-26-cache-auth-idb-wiring-audit.md` — **~50% stale**

主要乖離 (LocalSync 関連):
- ❌ `update-card.ts:59`/`delete-card.ts:56`/`update-card-field.ts:159` revalidate 系 → 該当 file/dir **削除済** (cards 個別 page 廃止)、 revalidatePath も S-cache-2a で撤去 (`update-card-field.ts:151-155`)
- ❌ `DashboardStats` が `/api/dashboard/stats` fetch → 現 `dashboard-stats.tsx` は `useLiveQuery`+`getStreakStatsFromDexie` (Dexie study_days)。 stats route は fallback のみ
- ❌ getCurrentUser を全 page で → exams/exams[id]/upload は `getAuthContext()` (JWT) に切替 (`ensure-user.ts:69-82`)、 cards/[id] page 削除
- ❌ 「dueCount は server SSR」「IDB read 画面は smart のみ」 → dueCount は `DashboardActions` の Dexie projection、 read は dashboard/smart 両方
- ❌ PullTrigger は dashboard page.tsx → **layout.tsx:51 へ移動**、 pull 2→**3 本** (study_days 追加)
- ✅ なお保つ: inline 編集 → card_mutations 未配線 (§3.3)

### F-2. `2026-05-26-localdb-inventory.md` — **中〜重 stale**

- ❌ 「cards/exams mirror は read 元未配線」 → dashboard/smart で **read 済**
- ❌ 「smart session は Drizzle、 Dexie untouched」 → `study-session-host` は Dexie 優先 hybrid (S-local-3)
- ❌ 「dashboard todayCount/streak は server authoritative」 → Dexie study_days mirror (新 table + pull + helper)
- 🔄 「Dexie 7 table」 → **8 table** (study_days を v2 追加)、 `SYNC_META_KEYS` に `lastStudyDayPullAt` 追加
- ✅ **今も load-bearing で accurate な 3 claim**: `card_mutations` schema-only で write/read ゼロ・bulk push 未実装 / `user_settings` Dexie 未配線 / `getSyncMeta` は test-only。 = LocalSync write-path MVP の真の open gap はこの 3 点

→ **教訓**: roadmap §5 は基本正確だが、 5/26 audit/inventory は「未完」 と記す多くが既に完了。 LocalSync spec 起草時は 5/26 doc の cost model / 改善候補表を rebaseline せず引かないこと。

---

## 軸G. scope 拡張候補の事実ベース評価

baseline: MVP は `card_mutations` のみ (それ自体 greenfield = sync helper + bulk route + producer 化が未実装)。 write-back template = `review-events/bulk/route.ts` (549 行)。

| 候補 | 現状 (file:line) | 新規要 | server gate 依存 | risk | cost | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| **1. exam_mutations** | exam 編集 UI **存在せず** (`exams/[id]/page.tsx:51` は read-only `<h1>`)。 作成は OCR upload 副産物 (`process.ts:333`)、 delete は server action 直 (`delete-exam.ts:44-46`) | **新 table+migration** (exam_mutations 不在) + Dexie store + sync helper + bulk route + **新 edit UI** | なし | 低 | **L** | **別 (v2)**。 最高コスト・編集頻度低 (roadmap:153,165)、 既に defer 済 |
| **2. source_documents / upload_records mirror** | OCR 進捗= `/api/exams/status` 5s polling (`exam-status-poll.ts`)、 quota SSR= `getCurrentMonthOcrPages` (`upload/page.tsx:88`) が **upload_records** SUM (`ai-usage-mcq.ts:51-64`)。 Dexie table 無し | 新 Dexie store + sync helper + pull endpoint + polling 改修 | ⚠️ **quota gate は server authoritative 必須** (`process.ts:289 canRunOcr`)。 IDB を信じると改ざんで paid 上限 bypass → **mirror は display-only 厳守** | 中〜高 | **M** | **別 (sprint ⑥)**。 data 形が逆 (server 駆動 async)、 abuse 面、 outbox 機構非共有 |
| **3. user_settings mirror** | save= server action 直 upsert (`save-fsrs-mode.ts:23` / `save-session-limit.ts:20`、 range は server 検証)。 read= SSR (`settings/page.tsx:26` + `study/smart/page.tsx:27-28`)。 Dexie store は**定義済だが dormant** (`client-db.ts:102,193`、 read/write ゼロ) | `/api/user-settings/pull` + `lib/sync/user-settings.ts` + save action に Dexie 書込追加 (schema slot は既存) | 設定のみ、 abuse 面なし | 低 | **S** | **折込むなら最安だが payoff 弱**。 mirror pull タスクで `_mutations` outbox 機構を共有しない。 slack 次第 |

**総括**: 3 候補とも outbox 機構 (MVP の核) を共有しない (1 は新 table+UI、 2 は server 駆動 mirror、 3 は read mirror)。 roadmap §5.1「割り切り」 の defer 判断を実コードで追認。 同 sprint 折込みは非推奨。

---

## 軸H. 東京移行後 latency 基準線 (LocalSync 効果測定の起点)

(`docs/superpowers/sessions/2026-05-29-tokyo-region-after-measurement.md` より、 function hnd1 + DB ap-northeast-1)

| 経路 | 値 (after 東京) | LocalSync MVP の効果軸 |
| --- | --- | --- |
| review-events bulk POST | **769ms** (16.7s→4.8s→0.77s、 per-event/US→単一tx/US→単一tx/東京) | LocalSync は **触らない** (review-events は配線済、 §5.1 割り切り)。 既に co-location で軽い |
| `/api/cards/pull` | 106〜168ms | Δ pull 化で更に削減余地 (full snapshot→増分) だが既に sub-200ms |
| `/api/exams/pull` / `/api/study-days/pull` | 108〜361ms | 同上、 sub-400ms |
| 演習→dashboard 遷移 | **656ms** (navigation duration、 pull 3 本並走) | 体感即時 |
| **inline 編集 cell (現状)** | server action 直 UPDATE = round-trip (東京で短縮済だが依然 server 往復) | **★ LocalSync の主目的: ~2.5s → ~50ms (Dexie write のみ)** |

**所見**: 東京移行で bulk/pull/遷移は既に sub-1s に収束済 = **page-load 体感終端の軸は概ね解決**。 LocalSync MVP が効くのは **inline 編集の即時性** (server 往復を Dexie write に置換) という**別軸**。 効果測定は「inline 編集 cell の確定→反映 latency」 を before(server action 往復) / after(Dexie write + background push) で計測すべき (bulk/pull の 769ms/sub-400ms は LocalSync では基本不変)。

---

## 9. 5/27 spec とのギャップ一覧 (最終まとめ)

### 9-1. ✅ そのまま成立 (現状コードと矛盾なし)

- bulk push を review-events pattern 踏襲 (template 確立済、 軸D)
- 演習中 snapshot は React state で成立済 → 「演習中 pull 抑制」 は性能目的で妥当 (5/27 pre-inv 軸2)
- study_sessions 独立 flush 不要 (review-events/bulk で完結、 5/27 pre-inv 軸1)
- schema 両端 scaffold 済 (Dexie + server migration 0012) → server migration **不要**
- §5.1「割り切り」 の scope 限定 (exam/source_documents/user_settings 除外) を実コードで追認 (軸G)

### 9-2. ⚠️ 変更/新規実装が要る (spec で確定すべき)

| # | 論点 | 現状 | 要対応 |
| --- | --- | --- | --- |
| 1 | **mutation_id 形式** | server `uuid` 型 (`schema.ts:605`)、 spec 案 `clientId:uuid` | server を text 化 or client UUID v4 統一 (**要決定**) |
| 2 | **状態 3 値** | Dexie `SyncStatus` は 4 値 (`syncing` 在り、 `client-db.ts:30`) | 「syncing 不使用」 明文化 or 型 narrow (型変更なら version migration 要否) |
| 3 | **delete 表現** | schema patch-only、 type 列なし (`schema.ts:601-623`) | `type`列追加(migration) or patch sentinel 規約 (**要決定**) |
| 4 | **Δ pull** | `/api/cards/pull` full snapshot、 helper は clear+bulkPut 全置換 (`cards.ts:70-76`) | `?since=` 追加 + helper を増分 upsert + pending skip 化 |
| 5 | dirty 保護 | 全 clear で pending も消える | 増分 upsert で `sync_status='pending'` skip |
| 6 | user 切替分離 | `sync_meta` に dbUserId key 無し (`sync-meta.ts:12`) | `currentDbUserId` key 追加 + 照合 (推奨値=内部 dbUserId) |
| 7 | Web Locks 排他 | repo 全体 0 件 | 初導入、 key 命名 + iOS Safari<16.4 fallback |
| 8 | 5 trigger | online/visibilitychange/pagehide listener 全て無し | orchestrator 新規 (debounce / TTL / 抑制判定 / 24h drop / retry+backoff) |
| 9 | producer 化 | inline 編集は server action 直 UPDATE (`exams/[id]/_actions/update-card-field.ts:142-146`) | Dexie 書込 + card_mutations enqueue + optimistic UI に差替 |

### 9-3. scope 拡張候補の判定 (軸G)

- exam_mutations → **別 sprint (v2)**: 新 table + 新 UI、 L コスト、 編集頻度低
- source_documents/upload_records → **別 sprint (⑥)**: quota 改ざん risk で display-only 厳守、 M コスト、 outbox 非共有
- user_settings → **折込むなら最安 (S) だが payoff 弱**: mirror pull で outbox 機構非共有。 slack 次第で study-smart cold-start 微改善のみ

### 9-4. 新規実装物 (実装 sprint で作る)

1. `lib/sync/card-mutations.ts` — enqueue / patch 圧縮(§14.6) / pending push / sync_meta cursor (review-events.ts pattern)
2. `app/api/card-mutations/bulk/route.ts` — 単一 tx + INSERT(chainable, onConflictDoNothing) + cards bulk UPDATE(raw VALUES, `toPgTimestamptz`+`JSON.stringify::jsonb`) + RETURNING 照合(UPDATE のみ) + serializeDbError
3. `lib/sync/local-sync.ts` (orchestrator) — 5 trigger + Web Locks + pull 抑制 + 24h drop
4. `/api/cards/pull` の `?since=` Δ pull 対応 + helper 増分化
5. inline 編集 producer 化 (`exams/[id]/_actions/update-card-field.ts`)
6. `sync_meta.currentDbUserId` + user 切替全 clear

**着手 blocker なし。** 上記 §9-2 の 9 点 (特に 1/2/3 の決定 3 点) を spec 起草冒頭で確定すること。
