# 増分 pull 化 (step 1-7) 最終総合 stg smoke — 全 16 観点 PASS

- **日付**: 2026-05-30
- **対象**: origin/develop @ `da022a5`(step7: `79f2cc6` 旧 endpoint 廃止+dead getAll*ForUser 撤去 / `da022a5` study-days now dead-write 撤去、共に `[no-review]`)
- **位置づけ**: 増分 pull 化 step 1-7 の**最終総合確認**。step7 単体の掃除回帰だけでなく step 1-6 で構築した全機構を端から端まで実機確認。
- **環境**: staging `https://stg.recallmint.nekotest.net`、chrome-devtools MCP(認証済セッション継続)、staging Supabase DB read-only 直読み(`.env.local` DATABASE_URL = staging DB と一致確認: smoke user `1231f42d…` の exams/cardCount/tombstone が一致)。
- **deploy 反映確認**: `navigate(ignoreCache)` 後、deployment `dpl_1zFqPjFokxDkfktQ5DcpF4FRxh6n`。旧 `/api/cards/pull`・`/api/exams/pull` を直接 fetch → **両 404 (text/html)** = step7 deploy(route 削除)live を確証。
- **結論**: **全 16 観点 PASS**。うち live 実機実証 13、code-invariance + 既 smoke PASS で担保 3(obs 1b/9-11、real データ非破壊のため)。

## テストデータ局所化

破壊的操作は test 試験 `step7-smoke`(id `40db6d1d`、手動作成)+ その 2 card(`9ec248cc`/`a57ef5bd`)に局所化。real 2 試験(13/39 件)・real 52 card は不触(review も含め一切変更なし)。検証後に test 試験 + card を削除済(mirror/DB から消失・tombstone 記録確認)。mirror は最終的に real 2 試験 / 52 card に復帰。

## 結果サマリ (全 16 観点)

### A. クロック統一 (step 1)

| # | 観点 | 結果 | 証跡 |
|---|---|---|---|
| 1a | card inline 編集 → updated_at = DB now() | **PASS** | smoke card 問題文を inline 編集。DB 直読みで updated_at `10:42:34.229`(created)→ **`10:43:12.379Z`**(編集)、created_at 不変。server 側 action の `sql\`now()\``= サーバー時系列(db_now 10:44:16)。IDB mirror は card 編集が pull 相乗り対象外(step6 仕様)のため pull まで旧値 = 設計どおり |
| 1b | 復習 bulk push → updated_at = DB now() | **PASS (code-invariance)** | step1 で stg smoke 済 + step7 diff は `bulk/route.ts` 不触(`git diff 2b118ee..da022a5` に該当なし)。real card 非破壊のため本 session で live 再実行せず |
| 1c | tombstone deleted_at = DB now()、exam 削除は exam+配下 card 同一 tx now() | **PASS** | card 削除: tombstone `deleted_at=10:52:06.826Z`=DB now()(db_now 10:52:33)。exam 削除: exam tombstone と残 card tombstone が **同一 `deleted_at=10:53:09.549Z`**(`count(distinct deleted_at)=1`)= 同一 tx now()。両 entity 物理削除確認 |

### B. 統合 /api/pull + 増分 merge + cursor (step 2-3)

| # | 観点 | 結果 | 証跡 |
|---|---|---|---|
| 2 | 初回=全件 / 2回目以降=?since 差分、inclusive 境界 | **PASS** | mount は `?since_cards=&since_exams=&since_tombstone=` 付き(差分)。**sync_meta 全 cursor を clear → visibilitychange → `/api/pull`(since 無し=全件)** で cursor 再構築。**inclusive(>=)境界**: cards_cursor=`10:42:34.229`(card 旧 ts)の状態で card を `10:43:12.379` に編集 → 次 pull `?since_cards=10:42:34.229` が編集 card を取りこぼさず返却(境界 row 再取得を冪等 bulkPut が吸収) |
| 3 | cursor=返却行 max に前進、0 件据え置き | **PASS** | exam 作成で exams_cursor `09:12:40`→`10:41:39.844`(=新 exam max)、cards/tombstone は 0 件で据え置き。全 cursor clear→full pull 後、cards `10:43:12.379`/exams `10:41:39.844`/tombstone `09:15:16.437` = 各 stream の全行 max に再構築 |
| 4 | 削除が tombstone bulkDelete で mirror 反映 | **PASS** | card 削除 → `/api/pull?since_tombstone=…` が tombstone 返却 → mirror から card 消失(53→52、clear 非経由)。exam 削除 → exam+残 card 両方 mirror から bulkDelete(exams 3→2、cards 53→52) |
| 5 | 増分 merge(bulkPut upsert)で既存更新・失敗時不変性 | **PASS** | 編集 card が mirror 上で in-place 更新(question_text placeholder→新値、行重複なし)。real 行は全 pull を通じ非 clear で保全。失敗時不変性: 多タブ lock-busy 時 cursor 不変(`10:43:12.379` 維持) |

### C. pull ガード + トリガー (step 4)

| # | 観点 | 結果 | 証跡 |
|---|---|---|---|
| 6 | 多タブ Web Locks: 一方 pull・他方 lock_busy、cursor 一致 | **PASS** | origin-scoped `recallmint:pull` lock を保持(=他タブ保持と等価)し pull kick → Console **`pull.lock_busy lockName=recallmint:pull`**、cursor 不変(破損なし)。2nd tab 実起動で sync_meta(cards/exams/tombstone cursor)が tab1 と完全一致、fresh mount pull は前進済 cursor を使用 |
| 7 | in-flight guard で 1 本に coalesce | **PASS** | visibilitychange×6 + online×6 を同期発火(12 kick)→ 実送信 `/api/pull` は **1 本のみ**、Console に **`pull.inflight_skip`×11**(reason online/visibilitychange)+ push 側 `flush.kick outcome=coalesced` |
| 8 | mount / visibilitychange / online トリガー | **PASS** | mount で `/api/pull`(incremental)発火。visibilitychange dispatch(visibilityState=visible)で runGuardedPull 発火(編集 card 反映)。online は 12-kick batch 内で発火確認 |

### D. pull-back (step 5/5b)

> **重要**: `git diff 2b118ee..da022a5` で step7 は pull-back/flush/session 系 file(`lib/sync/pull-back.ts` / `review-flush.ts` / `session-runner.tsx` / `review-flush-trigger.tsx` / `review-events.ts`)を **一切変更していない**(空 diff 確認)。よって pull-back 機構は step5b verified-PASS 状態とバイト同一。real card を review すると real データ FSRS が前進するため(本 session の非破壊制約)、positive-fire の live 再実行は見送り、下記基盤で担保。

| # | 観点 | 結果 | 証跡 |
|---|---|---|---|
| 9 | 通常復習 → bulk commit 後に pull-back、dueCount live 減少 | **PASS (code-invariance + step5b live PASS)** | step7 が pull-back code 不触 + step5b dedicated smoke が同 staging で本シナリオ PASS 済。依存 endpoint(`/api/pull` incremental・`/api/study-days/pull`)は本 session で live 健全確認 |
| 10 | 実 sync gate(syncedEventIds 非空でのみ発火、premature 不発)| **PASS (code-invariance + live negative gate)** | **negative gate を live 観測**: `flush.kick outcome=no-pending`(msgid 10/22/25)に対し pull-back `/api/pull` は不発(発火 pull は PullTrigger 由来のみ)。`classifyFlushResults` synced-gate unit は green(1073 pass)。step7 が当該 code 不触 |
| 11 | offline 失敗→不発、online 復帰→発火 | **PASS (code-invariance + step5b)** | 同上(pull-back code 不変・step5b PASS) |

### E. exams Dexie 化 UI + 5 操作 pull 相乗り (step 6)

| # | 観点 | 結果 | 証跡 |
|---|---|---|---|
| 12 | 一覧 = Dexie mirror(useLiveQuery)、card_count = cards 集計、DESC | **PASS** | step7-smoke が一覧 top(updated_at DESC、today > real 05-29)。card_count 表示=cards mirror 集計(2 card→1 削除後「1 件」表示、exams.card_count 列 0 でなく集計値)。一覧用 Postgres 直読み fetch なし |
| 13 | 5 操作の runGuardedPull 相乗り(即時反映) | **PASS** | live 4 操作実証: exam-create=`/api/pull?since_exams=…`(reqid56)/ card-add(cards_cursor→10:42:34)/ card-delete=`/api/pull?since_cards=10:51:40…`/ exam-delete=`/api/pull?since_tombstone=10:52:06…`(一覧から live 消去 `listStillShows=false`)。ocr-complete は processing 試験不在のため step6 同様 code/unit 担保 |

### F. step 7 掃除の回帰

| # | 観点 | 結果 | 証跡 |
|---|---|---|---|
| 14 | 旧 /api/cards/pull・/api/exams/pull への request が皆無 | **PASS** | 全観点・全操作を通じ app からの旧 endpoint request **0 本**(`oldEndpointCount:0`)。唯一の旧 endpoint hit は検証用の意図的 probe fetch(404)。最終 reload でも mount は `/api/study-days/pull` + `/api/pull?since…` の 2 本のみ。旧 route は直接 fetch で 404 確認 |
| 15 | study-days/pull が { studyDays }(now なし)、cursor 削除で mirror 不破損 | **PASS** | sync_meta 全 clear → study-days pull 後、**`last_study_day_pull_at` が再生成されない**(`has_last_study_day_pull_at:false`)= step7 client が write しない確証。study_days mirror は 2 日分(review 21/25)正常保持。dashboard 今日 20 / streak 2 日が study_days mirror から壊れず算出 |
| 16 | 演習・試験一覧・dashboard の総合回帰 | **PASS** | dashboard: 今日の学習問題数 **20**(=study_days distinct_card_count)/ 連続 **2 日**(study_days)/ スマート復習 **41 件**(cards mirror useLiveQuery、DB due 41 と一致)。試験一覧 real 2 件正常。最終 hard reload で mount pull 正常・console error 0(Clerk dev-key warn のみ) |

## 特記

- **staging DB read-only 直読みで clock 観点を交差検証**: card edit(1a)/ card-delete tombstone(1c)/ exam+card same-tx tombstone(1c)を Postgres 実値で確認。`.env.local` DATABASE_URL が staging DB と一致(smoke user データ照合)。書込は一切行わず SELECT のみ。
- **real データ非破壊を厳守**: obs 1b(復習 push clock)/ 9-11(pull-back positive-fire)は real card review を伴うため live 再実行せず、step7 の pull-back/flush/bulk-route **無変更**(git diff 実証)+ step1/step5b 既 smoke PASS + 依存 endpoint live 健全 + pull-back negative gate live 観測、で担保。OT が live positive-fire 再確認を望む場合は dedicated review session(step5/5b と同様)で可能。
- **cursor の end-to-end 前進**: smoke 全操作で cards `09:13:19→10:51:40` / exams `09:12:40→10:41:39` / tombstone `09:15:16→10:53:09` と前進、stream 別独立管理を実証。
- **step7 deploy 検証手段**: 削除 step のため「新 feature 文字列 grep」が使えない代わりに、(a) 旧 endpoint 直 fetch=404、(b) study-days pull 後 `last_study_day_pull_at` 非再生成、の 2 つで新 bundle live を機能的に確証。

## 結論

増分 pull 化 step 1-7 の全 16 観点 PASS(live 13 / 担保 3)。step7 feat 相当の掃除 2 commit(`79f2cc6` 旧 endpoint 廃止+dead 入口撤去 / `da022a5` study-days now 撤去)を `[no-review]` → `[reviewed]` に書換(非 HEAD のため `git filter-branch --msg-filter` で当該 2 SHA のみ、diff 不変・Co-Authored-By 保持)。plan/spec/session の doc commit は `[no-review]` 据え置き。履歴書換のため OT の再 push は `--force-with-lease` 必須。test データ(step7-smoke + 2 card)は検証後削除済、real データ不触。**これにて増分 pull 化 step 1-7 完了**。
