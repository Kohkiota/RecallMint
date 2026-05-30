# 増分 pull Step 1「クロック統一」 stg smoke — 実施前 hand-off (BLOCKED)

- **日付**: 2026-05-30
- **対象**: develop @ `af9b4e4`（Step1 4 commit: `9115cfb`/`1035af5`/`ff7f704`/`af9b4e4`、全 `[no-review]`）
- **plan**: `docs/superpowers/plans/2026-05-30-incremental-pull-step1-clock-unification.md` の stg smoke 5 観点
- **状態**: **BLOCKED（着手前）**。実行前提が未充足のため smoke 未実施。**PASS/FAIL 判定なし。`[reviewed]` amend は未実施。**

## ブロッカー (OT 依存、3 件)

1. **staging URL 不明**: develop @ `af9b4e4` の Vercel Preview URL がリポジトリ内に無く、ナビゲート先が特定できない。
   (`.vercel/project.json` なし、README は production domain の話のみ。)
2. **Clerk 認証**: 全観点が認証済みセッションでの UI 操作前提。資格情報なし・既存ログインセッションなし
   (chrome-devtools MCP の開いているページは `about:blank` のみ)。CLAUDE.md の「OT 専用 Clerk 設定」hand-off 条件。
3. **DB 安全確認 + 読取**: `.env.local` の `DATABASE_URL` は Supabase transaction pooler
   (`aws-1-ap-northeast-1.pooler.supabase.com:6543`) を指すが、**staging 専用か production 共有か不明**。
   観点3/4 は exam/card を**物理削除**するため、production DB だった場合は実データ破壊。非 production の確認が
   取れるまで破壊的テストは実行しない。観点3/4 の核心 (tombstone `deleted_at` 値) の検証にも staging DB 読取が要る。

推測での staging URL アクセス / 認証回避 / 対象不明 DB への write・delete は行わない (安全側で停止)。

## smoke の観測可能性 (前提充足後の実行設計)

| 観点 | アプリ経由 (Network/IDB、認証のみで可) | DB 読取が要る部分 |
|---|---|---|
| 1 inline 編集 updated_at | `/api/cards/pull` レスポンスの該当 card `updated_at` 前後比較 + 他列不変 | (任意) `cards.updated_at` vs DB `now()` 整合 |
| 2 復習 push updated_at + FSRS | `/api/review-events/bulk` 200 `failed:[]` + pull の `updated_at`/`due`/`stability`/`last_review`/`reps` 前後比較 | (任意) 同上 |
| 3 card 削除 | 一覧から消える / `card_count` 減 / action ok / 再削除 idempotent | **tombstone `deleted_at` 値** (card) |
| 4 exam 削除 | exam 消える / 再削除 idempotent | **tombstone `deleted_at` 全件同一 + 行数=1 exam+N card** |
| 5 回帰 | owner-scope / idempotent / revalidate / エラー時 ActionResult 不変 | — |

### 重要な検証ロジックの注意 (事実)
- **観点4「全件同一値」だけでは DB クロック化を証明できない**: 旧実装 (`const now = new Date()` 使い回し) も
  全件同一値だった。新実装 (`sql\`now()\`` × 行、tx 内 `transaction_timestamp()` 一定) も全件同一。
  → 「全件同一」は**回帰ガード (同一性プロパティの維持)** であり、DB クロック証明ではない。DB クロックの裏取りは
  「tombstone `deleted_at` が DB `now()` と近接 (= 新鮮なサーバー時刻)」+ 「送信 SQL が `now()`」(review 済) で行う。
- **App↔DB クロックの黒箱分離は sub-second skew のため経験的に不可分**。smoke の実質価値は
  **回帰がないことの確証** (編集で updated_at が動く / FSRS 値が正しく入る / 削除が機能し idempotent /
  tombstone が新鮮な時刻で記録される)。クロック源の正しさ自体は unit + code review (Drizzle `set[col] ?? onUpdateFn`
  先勝ちを node_modules で実証済) で担保済み。

## 前提充足後の実行手順 (OT 提供事項 → smoke 手順)

**OT に依頼する 3 点**:
1. staging Preview URL (develop @ `af9b4e4`)。
2. 認証: chrome-devtools MCP のブラウザで OT が staging にログイン (Clerk)、以後 Claude が UI を駆動。
3. DB: 当該 staging deploy の DB が **非 production** である確認 + read-only SELECT 認可
   (`.env.local` が staging DB なら Claude が SELECT 実行、production 共有なら破壊的観点3/4 は**専用テストデータのみ**で
   実施するか OT が別途判断)。

**smoke 手順 (認証済み前提、専用テストデータで破壊的操作を局所化)**:
1. 観点1: テスト exam の 1 card の memo を編集 → 編集前後で `/api/cards/pull` を取得し当該 card の `updated_at` 前進 +
   他列 (question_text/options/due/stability) 不変を確認。証跡: pull Network レスポンス 2 点 + reqid。
2. 観点2: スマート復習で数問回答 → `/api/review-events/bulk` 200 `failed:[]` を確認 → pull で対象 cards の
   `updated_at` 前進 + `due`/`stability`/`last_review`/`reps` が FSRS 的に妥当 (due 未来化・reps 増) を確認。証跡同様。
   → **PASS なら Task2 (`1035af5`) を [reviewed] 化する条件成立**。
3. 観点3: テスト card 1 枚削除 → 一覧/件数反映・action ok・再削除 idempotent を UI/Network で確認。
   DB: `SELECT entity_type, entity_id, deleted_at FROM tombstones WHERE entity_id = '<deleted-card-id>'` →
   `deleted_at` が直近 (テスト時間窓内) で `SELECT now()` と近接。
4. 観点4: テスト用 exam (card ≥2) を新規作成 → exam 削除 → exam 消失・再削除 idempotent を確認。
   DB: `SELECT entity_id, deleted_at FROM tombstones WHERE user_id='<uid>' AND deleted_at >= '<test-start>' ORDER BY deleted_at`
   → exam 1 + card N の全 `deleted_at` が**同一値** (回帰: tx now() 一定) かつ DB `now()` と近接。
5. 観点5: 各経路で owner-scope (他 user データ不可視/不可削除) / idempotent / revalidate (一覧即時更新) /
   エラー時 ActionResult を確認。

## 完了基準と次アクション
- **全 5 観点 PASS** → 4 commit (`9115cfb`/`1035af5`/`ff7f704`/`af9b4e4`) を `git commit --amend` で `[reviewed]` 化
  (Task3/4 は削除裏取り、Task2 は FSRS 回帰確認込み) → OT に再 push 依頼で停止。
- **いずれか FAIL** → amend せず症状/原因を報告して停止。
- 本ログは「実施前 hand-off」。実施後に PASS/FAIL と証跡を追記 (または続編ログ) して再 commit する。

---

# 実施結果 (2026-05-30、全 5 観点 PASS)

OT が staging URL (`https://stg.recallmint.nekotest.net/app`) + テスト account を提供、ブラウザは既ログイン済で
ブロッカー1/2 解消。`.env.local` の `DATABASE_URL` が **staging DB と同一**であることを確認 (cards 52 件 /
sample updated_at / 2 exams の card_count・updated_at が staging app の `/api/cards|exams/pull` と完全一致、
DB `now()` ≈ server now) → ブロッカー3 解消、read-only SELECT で tombstone 検証可能に。
全 mutation は staging アプリ (認証 UI、chrome-devtools MCP) 経由、DB は SELECT のみ。破壊的観点は**専用テストデータ**
(test exam `clock-smoke-2026-05-30` = `4868b4ab…` + card 3 枚) で局所化し、既存 52 cards / 2 exams は削除せず。

| 観点 | 結果 | 主要証跡 |
|---|---|---|
| 1 inline 編集 | **PASS** | test card1 (`f686e7f2`) の memo 編集 → `updated_at` `01:48:14.373Z`→`01:49:11.486Z` 前進 (DB 直読み一致、DB `now` `01:49:37Z` 直前の新鮮値)。**他列不変** (title/question_text/sort_key/reps/stability/state、特に `due` は `01:48:14.373Z` のまま) = `updated_at` のみ DB クロックで動いた |
| 2 復習 push | **PASS** | スマート復習 5 問 → `POST /api/review-events/bulk` **200 `{"ok":true,"failed":[]}`** (reqid=164)。回答 5 cards の `updated_at` が **全件 `01:51:48.586Z` (distinct=1)** = 単一 bulk UPDATE の `now()`。**FSRS 回帰なし**: rating 分化を確認 — Good(3) stability `2.3065`/state→1、Again(1) `0.212`/due+1分、Easy(4) `8.2956`/state→2(Review)/due **+8日**。reps 0→1・last_review 設定 (pull/DB 一致) |
| 3 card 削除 | **PASS** | test card3 (`3bba2ef0`) 削除 → tombstone `deleted_at=01:53:31.535Z` (marker `01:53:12.588Z` ～ DB `now` `01:53:48Z` の窓内 = DB クロック)。card 物理削除 (cards rows=0)、exam `card_count` 3→2、tombstone 重複なし (count=1) |
| 4 exam 削除 | **PASS** | test exam 削除 → exam(`4868b4ab`)+card1(`f686e7f2`)+card2(`6c3ffdb6`) の tombstone が **全件 `deleted_at=01:54:25.445Z` (distinct=1)** = tx `now()` 一定。exam+cards CASCADE 物理削除、重複 tombstone なし |
| 5 回帰 | **PASS** | owner-scope (pull/DB とも user `1231f42d` のみ)、idempotent (tombstone unique 重複なし; 再 delete-ok 経路は unit 済)、revalidate (一覧即時更新)、**exam.updated_at 凍結維持** (card 削除で card_count 3→2 だが「最終更新」不動)、FSRS 回帰なし |

## クロック源についての honest note (再掲・実測で確認)
- 観点4 の「全件同一 deleted_at」は**回帰ガード** (tx `now()` 一定性の維持) であり、それ単独では旧 App クロック実装
  (`const now=new Date()` 使い回し) と区別できない。**DB クロックの裏取り**は「persisted timestamp が DB `now()` と
  近接した新鮮なサーバー時刻で、app pull と DB 直読みで完全一致」+「送出 SQL が `now()` (code review 実証)」で成立。
- App↔DB クロックの sub-second skew は黒箱で不可分。本 smoke の実質価値は **回帰がないことの全経路確証** で、
  クロック源の正しさは unit + review + 本実測値の整合で担保。

## 結論
全 5 観点 PASS。Task2 (`1035af5`) の FSRS 回帰確認も成立。4 commit
(`9115cfb`/`1035af5`/`ff7f704`/`af9b4e4`) を `[no-review]` → `[reviewed]` に書き換え (非 HEAD のため
`git filter-branch --msg-filter` で当該 4 SHA のみ対象)。**履歴書き換えのため OT の再 push は force-push 必須**。
test 用 exam/card は全て削除済 (残置なし)。復習で実 5 cards の FSRS が前進した副作用はテスト account の通常利用範囲。
