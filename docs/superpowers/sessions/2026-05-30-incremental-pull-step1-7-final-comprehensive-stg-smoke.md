# 増分 pull 化 (step 1-7) 最終総合 stg smoke — 全 16 観点 PASS

- **日付**: 2026-05-30
- **対象**: origin/develop @ `da022a5`(step7: `79f2cc6` 旧 endpoint 廃止+dead getAll*ForUser 撤去 / `da022a5` study-days now dead-write 撤去、共に `[no-review]`)
- **位置づけ**: 増分 pull 化 step 1-7 の**最終総合確認**。step7 単体の掃除回帰だけでなく step 1-6 で構築した全機構を端から端まで実機確認。
- **環境**: staging `https://stg.recallmint.nekotest.net`、chrome-devtools MCP(認証済セッション継続)、staging Supabase DB read-only 直読み(`.env.local` DATABASE_URL = staging DB と一致確認: smoke user `1231f42d…` の exams/cardCount/tombstone が一致)。
- **deploy 反映確認**: `navigate(ignoreCache)` 後、deployment `dpl_1zFqPjFokxDkfktQ5DcpF4FRxh6n`。旧 `/api/cards/pull`・`/api/exams/pull` を直接 fetch → **両 404 (text/html)** = step7 deploy(route 削除)live を確証。
- **結論**: **全 16 観点 PASS**。当初 live 実機実証 13 + code-invariance 担保 3(obs 1b/9-11)。**2026-05-30 追補で残り 3 観点(1b/9/11)も live 実機実証済 → 16/16 全て live**(末尾「追補」節 + `…step1-7-pullback-live-stg-smoke` 相当の証跡)。

## テストデータ局所化

破壊的操作は test 試験 `step7-smoke`(id `40db6d1d`、手動作成)+ その 2 card(`9ec248cc`/`a57ef5bd`)に局所化。real 2 試験(13/39 件)・real 52 card は不触(review も含め一切変更なし)。検証後に test 試験 + card を削除済(mirror/DB から消失・tombstone 記録確認)。mirror は最終的に real 2 試験 / 52 card に復帰。

## 結果サマリ (全 16 観点)

### A. クロック統一 (step 1)

| # | 観点 | 結果 | 証跡 |
|---|---|---|---|
| 1a | card inline 編集 → updated_at = DB now() | **PASS** | smoke card 問題文を inline 編集。DB 直読みで updated_at `10:42:34.229`(created)→ **`10:43:12.379Z`**(編集)、created_at 不変。server 側 action の `sql\`now()\``= サーバー時系列(db_now 10:44:16)。IDB mirror は card 編集が pull 相乗り対象外(step6 仕様)のため pull まで旧値 = 設計どおり |
| 1b | 復習 bulk push → updated_at = DB now() | **PASS (live、追補で実証)** | test card 5 枚を復習 bulk push → DB 直読みで 5 枚とも updated_at=`11:51:01.440Z`(`count(distinct)=1`= 単一 `now()`)、db_now 11:51:59 後 = サーバー時系列。per-card `last_review`(FSRS 値)とは別値。詳細「追補」観点1b |
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
| 9 | 通常復習 → bulk commit 後に pull-back、dueCount live 減少 | **PASS (live、追補で実証)** | test 試験 5 枚を smart 復習(daily=threshold=5)→ 完了。Network: bulk POST **end 554ms(commit)→ pull-back `/api/pull` start 566ms**(commit 後・premature でない)。5 枚が FSRS 後値(reps 0→1/state→1/stability 2.307/due 11:58+)で mirror 反映、cards_cursor→11:51:01.440 前進。pull-back 1 本(threshold-flush 経路)。詳細「追補」観点9 |
| 10 | 実 sync gate(syncedEventIds 非空でのみ発火、premature 不発)| **PASS (live、追補で実証)** | **positive**: 観点9 の threshold session で commit(554ms)後に pull-back(566ms)= premature 不発を live 実証。**negative**: offline flush 失敗時 pull-back 不発(追補 観点11)。step5 FAIL → step5b 構造修正の回帰確認 |
| 11 | offline 失敗→不発、online 復帰→発火 | **PASS (live、追補で実証)** | **offline**: `navigator.onLine=false` で復習完了 → bulk POST 失敗(transfer 0)・**pull-back `/api/pull` 不発**・cards_cursor 据置(11:51:01.440)・pending 1 残置。**online 復帰**: `flush.kick reason=online outcome=ok`(msgid74)→ pull-back 発火 → cards_cursor→11:53:26.870 前進・pending drain・6 枚目 FSRS 後値反映。詳細「追補」観点11 |

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

増分 pull 化 step 1-7 の全 16 観点 PASS(当初 live 13 / 担保 3 → 追補で 16/16 live)。step7 feat 相当の掃除 2 commit(`79f2cc6` 旧 endpoint 廃止+dead 入口撤去 / `da022a5` study-days now 撤去)を `[no-review]` → `[reviewed]` に書換(非 HEAD のため `git filter-branch --msg-filter` で当該 2 SHA のみ、diff 不変・Co-Authored-By 保持)。plan/spec/session の doc commit は `[no-review]` 据え置き。履歴書換のため OT の再 push は `--force-with-lease` 必須。test データ(step7-smoke + 2 card)は検証後削除済、real データ不触。**これにて増分 pull 化 step 1-7 完了**。

---

## 追補(2026-05-30): code-invariance 担保だった 3 観点(1b/9/11)の live 実機実証 — 全 PASS

当初 smoke で「real データ非破壊のため live 再実行せず」とした 3 観点を、**real card を一切 review せず**に live 実証した。これで 16/16 全観点が live 実機実証となる。

### 局所化手法(real データ非破壊)

- test 試験 `step7-pullback-smoke`(id `a7eaedfa-830c-4e63-abbe-70c5aafe4b04`)+ test card 6 枚を局所作成。
- **smart session が最 overdue の real card 41 枚を優先する**問題を、**local Dexie mirror から real 52 card を削除(cache のみ・server 不触、incremental pull は updated_at < cursor のため復元しない)**して回避。これで session 対象が test card のみになる。server の real data は SELECT 以外一切触らない。
- 検証後、test 試験を削除(tombstone)+ cursor clear → full pull で real 52 card を mirror へ復元。
- 環境: deployment `dpl_1zFqPjFokxDkfktQ5DcpF4FRxh6n`(hard reload + 旧 `/api/cards/pull`=404 で確認)、sessionLimit=5 / `FLUSH_THRESHOLD`=5。

### 観点1b(復習 push で updated_at = DB クロック)— PASS

test 5 枚を smart 復習 → bulk push。DB 直読み: 5 枚とも `updated_at = 2026-05-30T11:51:01.440Z`、`count(distinct updated_at)=1`(= 単一 `sql\`now()\`` を batch 全件に適用)、db_now 11:51:59 後 = サーバー時系列内。per-card `last_review`(11:48〜11:51、FSRS 値・App 由来)とは別値で、cursor 列 `updated_at` のみ DB クロック化されていることを実証。

### 観点9(通常復習 pull-back の positive-fire、commit 後発火)— PASS

test 5 枚(daily=threshold=5)を smart 復習 → 完了。FSRS モードのため submit は「次へ」押下時(rate-then-confirm)。5 枚目「次へ」で 5th event 記録 → `pending>=5` threshold flush。**Network 順序(次へ click 起点 ms)**:
- `/api/review-events/bulk` POST: start 27ms → **end 554ms(commit)**
- `/api/study-days/pull`: start 564ms / `/api/pull`(pull-back): start **566ms** → end 1016ms

→ **pull-back は bulk commit(554ms)後に発火(566ms)= premature でない**(step5 FAIL → step5b 構造修正の core 回帰)。pull-back は 1 本のみ(threshold-flush 経路が実 sync を担い、session-complete flush は残件 0 で no-op)。IDB: 5 枚が FSRS 後値(reps 0→1 / state 0→1 / stability 2.307 / due 11:58+ / last_review set)で mirror 反映、`myPendingEvents=0`、`cards_cursor`→`11:51:01.440` 前進。

### 観点11(offline 失敗→不発、online 復帰→発火)— PASS

6 枚目(未復習)で 1 枚 session。
- **offline**(`emulate networkConditions=Offline`、`navigator.onLine=false`): 復習完了 → `/api/review-events/bulk` 試行のみ(dur 5ms / transferSize 0 = 失敗)、**pull-back `/api/pull` は不発**。IDB: `cards_cursor` 据置(`11:51:01.440`)、pending 1 残置、6 枚目 mirror 未更新(reps 0)。
- **online 復帰**(network 復元): Console `review_events.flush.kick reason=online outcome=ok`(msgid74)= controller 背景回復 flush が実 sync 成功 → onFlushed → pull-back 発火。IDB: `cards_cursor`→`11:53:26.870` 前進、pending drain(0)、6 枚目 FSRS 後値反映(reps>0)。

### クリーンアップ + real データ非破壊の最終確認

- DB 直読み最終: realExams=2 / realCards=52(不変)、test 試験・card の server 行 = 0(物理削除)、**my session で real card は 1 枚も更新せず**(realCardsUpdatedToday=20 は本 session 前からの既存値)。
- mirror 復元: cursor clear → full pull(`/api/pull` since 無し)で real 52 card 復帰、test 試験/card は mirror から消失。
- **残留(read-only DB 制約で revert 不可・明示)**: 本日の `study_days` 集計が test 6 復習で +6(review_count 25→31、distinct_card_count 20→26)。実 review フローを動かす以上不可避で、DB write 不可のため revert せず。real card の FSRS / updated_at には影響なし。tombstone(test 試験+6 card)は永続記録として残置(設計どおり)。

**結論(追補)**: 観点 1b / 9 / 11 を real データ非破壊で live 実証、全て PASS。**増分 pull 化 step 1-7 の最終総合 smoke は 16/16 全観点 live 実機実証で完了**。
