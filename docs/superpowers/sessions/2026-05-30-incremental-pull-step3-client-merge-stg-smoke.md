# 増分 pull Step 3「client 切替 (増分 merge)」 UI 経由 stg smoke — 全 6 観点 PASS

- **日付**: 2026-05-30
- **対象**: develop @ `ed5319a`（Step3 3 commit: `13badb1`/`8b6f5ca`/`ed5319a`、全 `[no-review]`）
- **plan**: `docs/superpowers/plans/2026-05-30-incremental-pull-step3-client-incremental-merge.md` の UI 経由 6 観点
- **手法**: 認証済 staging ブラウザ (step 1/2 と同じ) で UI 操作 + DevTools (Network `/api/pull` reqid・IndexedDB `cards`/`exams`/`sync_meta`) + `.env.local`＝staging DB 直読み (read-only) 交差確認。**新 cursor key 名** (`cards_cursor`/`exams_cursor`/`tombstone_cursor`) で sync_meta を確認。
- **前提状態**: reload 前の IDB は step-1 smoke 当時の **stale mirror** (cards 54 / exams 3、削除済みテスト exam `4868b4ab`+card 2 枚を含む)、sync_meta は旧 key のみ。= step 3 client 未稼働。これが観点2 の自然テストになった。

## 結果サマリ (全 6 観点 PASS)

user = `1231f42d-...`。server: cards 52 / exams 2 / tombstones 11。

| 観点 | 結果 | 証跡 |
|---|---|---|
| 1 増分 pull で mirror 更新 | **PASS** | テスト card (`34498752`) の memo を inline 編集 (server updated_at `04:50:21`→`04:50:52.146Z`) → reload → IDB cards 52→53、当該 card が memo `step3-incremental-merge-edit`・updated_at `04:50:52.146Z` で mirror に反映 (bulkPut upsert)。`cards_cursor` `01:51:48.586Z`→`04:50:52.146Z` 前進 |
| 2 tombstone 経由の削除反映 (§8-4・最重要) | **PASS (2 経路で実証)** | (a) **自然 reconciliation**: stale mirror (54/3) → 初回 full pullDelta → IDB cards 54→**52**・exams 3→**2**、削除済テスト exam `4868b4ab`+card `f686e7f2`/`6c3ffdb6` が**消失**。clear() 撤去後、これらは tombstone bulkDelete でのみ除去される (clear なら全消去だが、増分では tombstone がなければ残留する) → tombstone 反映成立。(b) **fresh delete**: テスト exam `step3-smoke` を削除 → reload → IDB cards 53→52・exams 3→2、テスト card/exam が消失、`tombstone_cursor` `01:54:25.445Z`→`04:51:52.879Z` 前進。DB で test exam/card 物理削除 + tombstone (both `04:51:52.879Z`) 確認 |
| 3 dashboard dueCount live 反映 | **PASS** | dashboard「スマート復習（46件）」= IDB cards の `due <= now` 件数 **46** と一致 (useLiveQuery が増分 merge 後 mirror に live binding)。「今日 5 / 連続 2 日」も study_days mirror から表示 |
| 4 2 回目以降 pull が差分のみ (最重要) | **PASS** | 1 回目 reload: `GET /api/pull` (`?since` **無し** = full、reqid=553)。2 回目 reload: `GET /api/pull?since_cards=2026-05-30T01:51:48.586Z&since_exams=..&since_tombstone=..` (reqid=595) でレスポンスは **cards 5 / exams 1 / tombstones 3** (全件 52/2/9 ではなく差分=inclusive 境界行のみ)。全件 pull → 増分 pull 成立 |
| 5 study_days 旧経路で従来どおり | **PASS** | 毎 mount で `GET /api/study-days/pull` (reqid=550/591) が並走、`{studyDays, now}` count 2 を返す。旧 `/api/cards/pull`・`/api/exams/pull` は**呼ばれない** (client 切替成立)。streak/todayCount 機能 |
| 6 cursor 前進 + 取りこぼさない | **PASS** | 初回 full pull で `sync_meta` に `cards_cursor`/`exams_cursor`/`tombstone_cursor` が DB-clock max で書込。2 回目 `?since` が前回 cursor に一致、レスポンスは境界行 (updated_at/deleted_at == cursor) を **inclusive (`>=`) で再取得** = 取りこぼしなし (bulkPut/bulkDelete 冪等)。編集/削除で cursor が各 max に前進 |

## 特記
- **観点2 の自然 reconciliation が最強の証跡**: stale mirror に「server で削除済だが clear() なら消える / 増分では tombstone がなければ残る」エンティティ (テスト exam+card) が含まれており、それが消えた = tombstone bulkDelete が暗黙削除を正しく代替した (§8-4 の核心)。
- **旧 sync_meta key は orphan 残置**: `last_card_pull_at`/`last_exam_pull_at`/`last_study_day_pull_at` の旧 row が IDB に残るが、新 pullDelta は読まない dead row (無害)。`last_study_day_pull_at` は study-days helper が引き続き更新。掃除は任意 (波及なし)。
- **cursor が surviving max より先行**: テスト card/exam 削除後、`cards_cursor`(`04:50:52`)/`exams_cursor`(`04:50:13`) は生存行の max(updated_at)(`01:51:48`/`04:49:46`) より先 (削除済 row の時刻を反映)。inclusive cursor のため次 delta は 0 件で無害 (新更新が cursor を超えるまで返らない)。
- 旧 endpoint (`/api/cards/pull`・`/api/exams/pull`) は step 7 廃止まで server に残置 (client 不使用)。
- テストデータ (`step3-smoke` exam + card) は検証後に削除済、物理削除を DB で確認 (残置なし)。

## 結論
全 6 観点 PASS。3 commit (`13badb1`/`8b6f5ca`/`ed5319a`) を `[no-review]` → `[reviewed]` に書換
(非 HEAD のため `git filter-branch --msg-filter` で当該 3 SHA のみ、diff 不変・Co-Authored-By 保持)。
履歴書換のため OT の再 push は `--force-with-lease` 必須。staging データは検証用作成→削除のみで既存データ不触。
