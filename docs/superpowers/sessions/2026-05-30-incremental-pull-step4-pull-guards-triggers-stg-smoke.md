# 増分 pull Step 4「pull ガード + トリガー拡張」 UI 経由 stg smoke — 全 5 観点 PASS

- **日付**: 2026-05-30
- **対象**: origin/develop @ `2a38098`（Step4 2 commit: `74dde44` runGuardedPull / `2a38098` pull-trigger 拡張、両 `[no-review]`）
- **plan**: `docs/superpowers/plans/2026-05-30-incremental-pull-step4-pull-guards-triggers.md` の UI 経由 5 観点
- **環境**: staging `https://stg.recallmint.nekotest.net/app`、chrome-devtools MCP 制御ブラウザ（OT が email+code 認証 hand-off）。user = `1231f42d-...`、plan=standard。
- **手法**: UI/イベント操作 + DevTools（Network `/api/pull`・Console `pull.*` ログ・IndexedDB `recallmint` の `sync_meta`/`cards`）+ `navigator.locks.query()` でロック状態直読み。
- **前提状態**: MCP は新規ブラウザプロファイルのため初回ロードは IDB 空 → `/api/pull`（`?since` 無し = full）で cursor 初期化。以降の cursor: `cards_cursor=2026-05-30T01:51:48.586Z` / `exams_cursor=2026-05-29T04:49:46.605Z` / `tombstone_cursor=2026-05-30T04:51:52.879Z`（step3 終値と一致）。

## 結果サマリ (全 5 観点 PASS)

| 観点 | 結果 | 証跡 |
|---|---|---|
| 1 多タブ Web Locks (最重要) | **PASS** | 2 タブ（page1/page2、同 origin・同 IDB）。page1 が実ロック名 `recallmint:pull` を保持中、page2 から `navigator.locks.request(ifAvailable)` プローブ → **`BUSY (held by another tab)`**、`navigator.locks.query().held` = `[{name:'recallmint:pull', clientId:'261A85CA...'}]`（page1 client）。同保持中に page2 の**デプロイ済みアプリ** pull（visibilitychange 経由 runGuardedPull）を起動 → Console **`{"event":"pull.lock_busy","lockName":"recallmint:pull","reason":"visibilitychange"}`**（msgid=8 @06:06:04.465Z）、`/api/pull` 未発火（ifAvailable skip）。両タブ `sync_meta` cursor **完全一致**（cards/exams/tombstone 同値）・cards 52/52・dueCount 46 で**破損/巻き戻りなし** |
| 2 visibilitychange | **PASS** | (a) 実タブ切替（page2 前面化→page1 前面化）で `GET /api/pull?since_cards=..&since_exams=..&since_tombstone=..`（reqid=145）発火。(b) 決定的再現: page1 visible 状態で `document.dispatchEvent(new Event('visibilitychange'))` → **`/api/pull` + `/api/study-days/pull` 両方**が新規発火（U3 study_days 相乗り確認、handler 配線がデプロイ済み）|
| 3 online | **PASS** | DevTools emulate で Offline（`navigator.onLine=false` 確認）→ 復帰 → online イベントで `/api/pull`（pullCount 3→4、incremental `?since`）+ `/api/study-days/pull`（2→3）発火 |
| 4 二重 mount / in-flight coalesce | **PASS** | `visibilitychange` を同期 6 連打 → **新規 `/api/pull` は 1 本のみ**、Console に **`pull.inflight_skip`（reason=visibilitychange）× 5**（msgid 16/17×2/19×2、6 中 1 run+5 skip）。study_days は unguarded で 6 本（U3 通り、guard 対象外）|
| 5 回帰 | **PASS** | 通常 reload → `GET /api/pull?since_cards=2026-05-30T01:51:48.586Z&since_exams=..&since_tombstone=..`（reqid=126、incremental）**1 本** + `GET /api/study-days/pull`（reqid=125）並走。delta = cards 5 / exams 1 / tombstones 2（inclusive 境界行のみ、full でない）。旧 `/api/cards/pull`・`/api/exams/pull` は呼ばれない（step3 挙動不変）|

## 特記 (手法の透明性)

- **観点1 の lock-busy は決定的手法で実証**: plan は「2 タブほぼ同時 reload で一方 lock-busy」を想定。実アプリの pull はロック保持時間（fetch 1 回 ≈ 数百 ms）が **MCP 逐次呼出のオーバヘッド（1 呼出 ≈ 3-5s）より短く**、自然な 2 タブ同時 reload の重なりを再現できなかった（Slow 3G 投入でも僅差で失敗）。そこで page1 で**実ロック名 `recallmint:pull` を 35s 保持**（leader の in-flight pull を模擬）し、その最中に page2 の**実アプリ runGuardedPull**（visibilitychange 経由・デプロイ済みコード）を走らせて `pull.lock_busy` を捕捉。follower 側は実コード、ロック機構は実 Web Locks（`navigator.locks.query` で cross-tab 占有を直接確認）であり、「多タブで一方が走り他方が ifAvailable skip」を忠実に再現している。
- **runGuardedPull / トリガー拡張がデプロイ済みの裏付け**: `pull.inflight_skip`（観点4）・`pull.lock_busy`（観点1）の両ログ出力 + visibilitychange/online での `/api/pull` 発火（mount 限定だった step3 以前には無い挙動）= Task 1+2 が staging に反映済み。
- **`review_events.flush.kick` ログ並走**: 各 visibilitychange/online で review-flush-trigger も発火（イベントが実際に dispatch された裏付け）。pull 側は skip 型（inflight_skip）、review 側は coalesce 型（coalesced rerun）で**両者の設計差（U1: pull は rerun しない）が同一画面で観測**できた。
- **cursor 整合**: 一連の多タブ操作後も両タブ cursor は baseline と同値・相互一致。新規サーバ更新が無いため前進せず（inclusive cursor の正常挙動）、破損なし。
- **テストデータ非作成**: 観点1-5 とも読み取り側のみ（card 解答等のミューテーションなし）。残置・削除対象なし。manual ロックは 35s で自動解放（`lockReleased:true` 確認）。

## 結論
全 5 観点 PASS。2 commit（`74dde44`/`2a38098`）を `[no-review]` → `[reviewed]` に書換（非 HEAD のため `git filter-branch --msg-filter` で当該 2 SHA のみ、diff 不変・Co-Authored-By 保持）。履歴書換のため OT の再 push は `--force-with-lease` 必須。
