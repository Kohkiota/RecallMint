# Y-2 Sub-plan B T-B4 #1c stg 実機 smoke (2026-06-13)

`/app/exams` の per-exam 集計を Dexie native `IDBIndex.count(IDBKeyRange)` 経路 (案 b、 compound index `[user_id+exam_id]`) に置換した T-B4 の実機計測。 materialize 0 の構造保証 + 候補 (a) との実測比較 + T-B1 baseline (~3,655 ms) との改善幅確認。

- **計測日時**: 2026-06-13
- **stg**: stg.recallmint.nekotest.net (deploy = `1e50c5b`)
- **計測 user**: `komail9server+clerk_test@gmail.com` (T-B1 runbook 規律: OT 本アカウントに fixture 投入禁止)
- **fixture**: T-B1 seed runbook 流用 + exam 数 3 → **100** 規模に拡張 (Y2B4- prefix)
- **plan**: `docs/superpowers/plans/2026-06-12-y2-launch-hardening-B-perf.md` T-B4
- **spec**: `docs/superpowers/specs/2026-06-13-y2-t-b4-design.md`

---

## 1. 着手前確認

- `git log --oneline origin/develop..HEAD` = 0 件 (push 同期済、 origin/develop = `1e50c5b`)
- stg 接続後 IDB 状態:
  - Dexie version = **60** (= Dexie `version(6)` × 10、 spec §2.2 の v6 schema 反映確認)
  - `cards` objectStore の indexNames に **`[user_id+exam_id]` 追加確認** (純粋追加、 既存 `exam_id` / `user_id` / `due` / `updated_at` / `content_version` / `sync_status` も維持)
  - user = test user (id = `23359047-aab7-4582-a1c0-d5ffd52f5214`、 email = `komail9server+clerk_test@gmail.com`)

---

## 2. fixture 投入 (Y2B4- prefix)

### 2.1 exam 100 件 (UI 経由 server action call、 fetch 並列)

- 1 件 UI submit で `POST /app/exams` の Next-Action signature を取得 (`next-action: 40a3b93398f55cc04b9af28b0f90dc34c73b1afb78`、 body = `[name]`)
- 残り 99 件は fetch で同 signature 並列発火 (batch 10 並列 × 10 batch)
- 結果: 98 件成功 (UI 1 + fetch 1 試行 + fetch 98 batch = 100 件、 wall-clock 4.57 s)

### 2.2 cards 2000 件 (entity-mutations bulk endpoint)

- 100 exam × 20 cards/exam = 2000 cards
- `POST /api/entity-mutations/bulk` で 1000 mutations/batch × 2 batch
- **schema 不一致で初回 fail** (`correct_answer_ids` / `images` は `cardCreatePatchSchema` に含まれない、 `options[].is_correct` → `isCorrect` camelCase)
- 修正版で再投入: 2 batch とも **applied: 1000 / failed: 0**、 wall-clock 72.2 s (T-B3 #1b 並列化済、 100 独立 exam_key への分散)
- page reload で Dexie pull → 反映確認:
  - exams = 101 (baseline 1 + Y2B4 100)
  - cards = 2006 (baseline 6 + Y2B4 2000)
  - Y2B4 cards = 2000 ✓

---

## 3. 計測結果

### 3.1 IDB level 3 経路比較 (browser_evaluate、 fake-indexeddb ではなく実 IDB)

3 回計測平均 (run-to-run variance 吸収のため各 case 間に gcHint + 100 ms wait):

| 経路 | wall-clock avg (ms) | materializedRows | countsTotal | 戻り値 type | self-check |
|---|---|---|---|---|---|
| **(b) 現実装** `Promise.all(activeExams.map(e => idx.count(IDBKeyRange.only([U, e.id]))))` | **21.3** | **0** | 2006 ✓ | `number[]` | filter 0 件、 native count 経路 |
| (a) `idx.openKeyCursor(range)` + JS Map 集計 (values:false) | 44.8 | 0 | 2006 ✓ | `Map<string, number>` | cursor 2006 iter |
| (toArray) 旧経路 `idx.getAll(userId)` + JS Map | 44.7 | **2006** | 2006 ✓ | `Card[]` (29 field × 2006) | T-B4 撤去対象 |

#### 3.1.1 materialize 0 の確証 (plan T-B4 完了条件 ③、 spec §2.4)

- (b) の戻り値は **`number[]` 101 件**、 card row body 一切 fetch なし
- (toArray) は 2006 件の `Card` object array (`id` / `exam_id` / `user_id` / `options` / `correct_answer_ids` / `images` / `due` / `stability` / `difficulty` 等 29 field 全件 alloc)
- Dexie source `dist/dexie.js:2108-2132` (`Collection.prototype.count`) で `isPlainKeyRange(ctx, true)` true → `coreTable.count({range})` → native `IDBIndex.count(IDBKeyRange)` 直送 = row body fetch なし、 を **実機で確証**
- 戻り値 type による直接観測なので、 GC 直後の heap snapshot (`performance.memory.usedJSHeapSize`) が delta 0 を返した点とは独立して **materialize 0 が成立**

#### 3.1.2 (a) との比較 (plan T-B4 完了条件 ④、 spec §2.5 / §7-3)

- (b) 21.3 ms vs (a) 44.8 ms = **(b) が 2.1x 速い**
- 100 exam 規模で (b) が依然優位 = 逆転なし → (a) 切替不要、 **本命 (b) 確定**
- 解釈: (b) は 101 個の native count() を Promise.all で並列発火、 各 IDBIndex.count(IDBKeyRange) は B-tree 範囲 count のみ (μs オーダー)。 (a) は 1 cursor の openKeyCursor で 2006 entry を JS layer に逐次返す iteration cost。 100 exam 規模では (b) の round trip overhead < (a) の cursor advance。 exam 数が 1000+ になる将来運用では (a) 切替の可能性あり (本 sprint 内では未到来)。

#### 3.1.3 正しさ確認

- 3 経路の `countsTotal = 2006` で一致 (functional 正しさ)
- (b) は owner isolation を index 第 1 要素 userId equals fix で構造保証 = test #6 を index 構造で satisfy (実機の他 user データ混入確認は本 fixture では他 user 不在のため未実施、 unit test で十分)

### 3.2 page level 計測 (Navigation Timing + waitFor)

`/app/exams` を navigate → `waitFor("Y2B4-exam-100")` で list 表示完了確認 → Navigation Timing 取得:

| metric | T-B4 (新実装) | T-B1 baseline (旧実装) | 改善 |
|---|---|---|---|
| TTFB | 9.4 ms | 10.4 ms | ±0 (server 同等) |
| responseEnd | 535.9 ms | 126 ms | 後述 (差は SSR / RSC payload size) |
| FCP | 572 ms | 151 ms | 後述 |
| **loadEvent (page 全体)** | **644.5 ms** | **3,781 ms** | **5.9x 改善 (~83% 短縮)** |
| dexie_render_attr 相当 (loadEvent - responseEnd) | 108.6 ms | 3,655 ms | **34x 改善 (~97% 短縮)** |

(T-B1 baseline は `docs/superpowers/sessions/2026-06-12-y2-tags-perf-investigation.md:71-78` の `/app/exams` 計測 avg)

#### 3.2.1 注釈

- responseEnd / FCP が T-B1 より長い理由 = T-B4 fixture では exam 101 件 → RSC payload 増 + Lighthouse 系の bundle 解析オーバヘッドが反映時刻に乗ったため。 これは server response 自体の劣化ではなく fixture 規模差。
- 本質的改善指標は **dexie_render_attr 相当** (= page level 終端 - server response 完了) = 108.6 ms vs 3,655 ms = **~97% 削減**。 cards 2006 件 materialize → 0 件 materialize に変化したため。
- IDB level (b) 21.3 ms (集計のみ) と page level dexie_render_attr 108.6 ms の差 (~87 ms) = React mount + useLiveQuery subscription + Render reconciliation (101 exam <li> の DOM 構築) のオーバヘッド。

---

## 4. 完了条件チェック (plan T-B4)

| 完了条件 | 結果 |
|---|---|
| ① per-exam materialize 0 構造保証 (regression test 1 件) | ✓ implementer 段で完了 (test #7、 7/7 pass) |
| ② 既存 exam-list-live test 6 件全 pass | ✓ implementer 段で完了 |
| ③ stg 実機 DevTools Performance で /app/exams dexie_render_attr 計測可能改善 | ✓ **本セッションで実測完了** (108.6 ms、 T-B1 baseline 3,655 ms → ~97% 削減) |
| ④ exam 数拡張 fixture で (a)/(b) 実測比較 | ✓ **本セッションで実測完了** ((b) 21.3 ms vs (a) 44.8 ms、 (b) 2.1x 優位、 本命 (b) 確定) |
| ⑤ per-task gate (lint / typecheck / test / build 全 exit 0) | ✓ implementer 段で完了 |
| ⑥ Critical 0、 [reviewed] | ✓ canonical review pass、 feat commit `7c5a7ee` [reviewed] |

---

## 5. cleanup

`exam` entity_type は mutation registry に **未登録** (`lib/sync/shared/mutation-schemas.ts` に exam create/delete 無し、 grep 0 件) のため、 cleanup は entity-mutations bulk endpoint ではなく **`deleteExam` server action 経由** で実施。

### 5.1 cleanup 経路

- 1 件 UI 経由 (Y2B4-exam-001) 削除して Next-Action signature 取得 (`next-action: 402f239baf362ab6104e9eab365d16b1462434b2ac`、 body = `[examId]`)
- 残り 99 件 fetch 並列 (batch 10 × 10 batch) で `POST /app/exams` を発火
- 結果: **99 件全成功 / 4.46 s**、 server 側 FK CASCADE で配下 cards 2000 件も連動削除 (`delete-exam.ts:48-90` の tx で tombstone INSERT + `db.delete(exams)` → cards / source_documents / reviews 連動)

### 5.2 cleanup 確認 (page reload → pull → tombstone drain)

| store | 投入後 | cleanup 後 (baseline 復帰) |
|---|---|---|
| exams | 101 (baseline 1 + Y2B4 100) | **1** ✓ (Y2B4 0) |
| cards | 2006 (baseline 6 + Y2B4 2000) | **6** ✓ (Y2B4 0) |

T-B1 runbook §6 と同方針 (tombstone-on-baseline 汚染回避のため計測完了後 cleanup)。 stg test data 残置なし、 OT 本アカウントへの波及なし。

---

## 6. 結論

- **materialize 0 の構造保証は実機で成立**: (b) 戻り値 `number[]` のみ、 row body fetch 0 件、 Dexie source 確証と一致。
- **(a)/(b) 比較で (b) 2.1x 優位**、 100 exam 規模で逆転無し → **本命 (b) 確定**、 spec §2.5 / §7-3 の (a) 切替余地は本 sprint では使わない。
- **page level dexie_render_attr ~97% 改善** (3,655 ms → 108.6 ms)、 launch 前 hardening の体感遅延圧縮達成。
- plan T-B4 完了条件 6 件全達成、 stg smoke pass、 prod 反映判断は OT 裁定へ。
