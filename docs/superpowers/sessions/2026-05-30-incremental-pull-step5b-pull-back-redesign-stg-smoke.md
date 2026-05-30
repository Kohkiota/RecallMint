# 増分 pull Step 5b「pull-back 再設計(実送信成功 gate)」 UI 経由 stg smoke — 全 5 観点 PASS

- **日付**: 2026-05-30
- **対象**: origin/develop @ `ab9a2af`（Step5b feat: `101f4b1` classify 再定義 / `151657b` threshold hook + 既存 step5 4 commit、doc: plan/spec/investigation、全 `[no-review]`）
- **plan**: `docs/superpowers/plans/2026-05-30-incremental-pull-step5b-pull-back-redesign.md` の UI 経由 5 観点
- **環境**: staging `https://stg.recallmint.nekotest.net/app`、chrome-devtools MCP。FSRS モード、daily session=5 問 = `FLUSH_THRESHOLD`(5)。
- **結論**: **全 5 観点 PASS**。前回 FAIL（pull-back が bulk commit と race し stale）が解消。

## ⚠ 重要な前提（デプロイ cache の落とし穴）

初回試行で観点1 が前回同様 FAIL に見えた。調査の結果、**MCP ブラウザが前回 smoke の旧 step5 JS を cache しており、soft navigation で旧コードを実行**していた（サーバーは新 deploy、client が旧コード）。判定: デプロイ済み JS 16 chunk を grep → 新リテラル `'threshold-flush'`（step5b 固有）の有無で確認。**soft load では `threshold-flush` 不在（旧コード）、`reload(ignoreCache)` 後に存在**（`page-fab74b81...js`、`dpl_DzbcRjmLwFX1jw4Wie8HAb4eeMgF`）。hard reload で新 bundle をロードしてから再実行 → 全観点 PASS。**今後の smoke は hard reload で deploy 反映を確認すること**。

## 結果サマリ (全 5 観点 PASS)

| 観点 | 結果 | 証跡 |
|---|---|---|
| 1 通常フロー pull-back (主・前回 FAIL 箇所) | **PASS** | daily=5=threshold を踏んで 5 問回答 → 完了。Network: `POST /api/review-events/bulk`(reqid 417, `{ok:true,failed:[]}`) **commit 後**に `GET /api/study-days/pull`(418)+ `GET /api/pull?since_cards=07:38:46.972Z`(419)。IDB: **`cards_cursor` 前進 `07:38:46.972Z`→`07:43:31.628Z`**(= 今 session の bulk commit 時刻、前回 FAIL では据え置きだった)、回答 5 枚が `updated_at=07:43:31.628Z`・due `2026-06-01`・stability 2.3065・reps 2 で mirror 反映（再 mount 不要 live）。dashboard「スマート復習（41件）」= mirror dueCount と一致（useLiveQuery）。**pull-back が commit 後に走り fresh 取得 = race 解消** |
| 2 二重 pull 防止 | **PASS** | 完了時 `/api/pull` は **1 本のみ**(419)。session 完了 flush は threshold が events を in-flight 確保中 → skip → `classifyFlushResults`='no-pending'(再定義) → **不発**。threshold-flush が単独発火。Console に `pull.inflight_skip` 無し = 二重 kick 自体が起きていない（in-flight guard は backstop、step4 で実証済）。study_days は別途 1 本(418) |
| 3 skip では不発 (任意) | **PASS(暗黙)** | 観点1 で session 完了 flush の skip が `'no-pending'` で正しく不発（二重 pull 無し）。観点4 の失敗 flush も不発。再設計の核心が実機で成立 |
| 4 失敗時不発 + 復帰時発火 | **PASS** | 4 問 online 回答(pending=4)→ **offline** で 5 問目+完了 → bulk 失敗(`bulkAttempts:1` 失敗)→ **pull-back 不発**(`cards_cursor` 据え置き `07:43:31.628Z`、新規 `/api/pull` 無し、pending=5 未 sync)。→ **online 復帰** → controller online flush が `outcome='ok'`(Console msgid=47 `reason=online,outcome=ok`)→ onFlushed → **pull-back 発火**(`cards_cursor`→`07:48:25.960Z` 前進、pending 5→**0**)。失敗で不発・復帰の実 sync で発火（controller safety-net 経路） |
| 5 回帰 | **PASS** | /app ロードで `GET /api/pull?since_cards=07:43:31.628Z`(incremental、前進 cursor 読込)1 本 + `GET /api/study-days/pull` 並走 = step3/4 挙動不変。mount/visibility/online トリガーも不変 |

## 根本是正の実機確認

- 前回 FAIL 機序: 5件閾値 flush(実 sync)と session 完了 flush(skip)が race、`classifyFlushResults` が skip(`attempted:0`)を `'ok'` 誤分類 → bulk commit 前に premature pull-back → stale。
- 今回の挙動: threshold flush が実 sync(`syncedEventIds` 非空 → 'ok')→ pull-back を **自分の bulk commit 後**に発火 / session 完了 flush は skip(synced 空 → 'no-pending')→ 不発。`syncedEventIds` は `await client.post` の 200(= tx commit 後）後にのみ set されるため、**pull-back は構造的に必ず commit 後**。実機で cursor が今 session の bulk commit 時刻(`07:43:31.628Z`)に前進 = fresh 取得を確認。
- reason `'threshold-flush'` は runGuardedPull が成功時に log しない(skip/lock-busy のみ log)ため Console 直接観測不可だが、(a) デプロイ bundle に `'threshold-flush'` リテラル存在、(b) pull-back が commit 後に fresh を取る挙動、で synced-gated 経路の発火を確認。

## テストデータ
復習回答は通常操作（FSRS 状態の正規進行、削除対象の「テストデータ」ではない）。本 smoke で計 3 session（旧コード 5 枚 + 新コード同 5 枚 + 観点4 別 5 枚）の reps/due を進めたが、いずれも test 用アカウントの正規 review。巻き戻しなし、破壊的操作なし。

## 結論
全 5 観点 PASS。step5 全 feat commit（既存 4: `f178f47`/`a1adbf9`/`e2b7004`/`df1b3e4` + 本 plan fix 2: `101f4b1`/`151657b` = 計 6）を `[no-review]` → `[reviewed]` に書換（非 HEAD のため `git filter-branch --msg-filter` で当該 6 SHA のみ、diff 不変・Co-Authored-By 保持）。spec/plan/session の doc commit は `[no-review]` 据え置き。履歴書換のため OT の再 push は `--force-with-lease` 必須。
