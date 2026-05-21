# S2.0 事前調査 — スマート復習 (FSRS due-based)

- 日付: 2026-05-21
- 種別: 事前調査 (trace + 設計選択肢列挙のみ、 実装変更 0、 doc 1 file)
- branch: `develop` (S1.9.5 closure 済の `0b61a69` から開始)
- **本 doc は修正方針を提示しない**。 各設計選択肢は trade-off 込みで列挙、 採用案 selection は claude.ai + OT が後段で決定する。

## 背景

S1.9.x シリーズ (削除フロー / 並列 guard / cascade dormant) 完了、 launch 阻害要因は解消。
次は MVP コア機能の「演習」 を 2 sprint で実装:

- **S2.0** (本 sprint): FSRS スマート復習モード — due-based 自動出題
- **S2.1** (次 sprint): カスタム演習モード — フィルタ UI + 出題

S2.0 完了で「OCR → 問題作成 → スマート復習で解ける」 という MVP 最低限ループが完成。

確定済の設計判断 (OT 合意済、 本 doc の前提):

- **UI 方式**: 1 問ずつ表示 → 解答 → 即フィードバック (正解/不正解 + 解説) → 次へ
- **FSRS rating**: 二値 (正解/不正解 button のみ)、 内部で `isCorrect ? 3 : 1` (integer) に変換
- 4 段階 (again/hard/good/easy) は v1.x、 MVP 二値で確定

---

## 0. エグゼクティブサマリ (期待発見ポイントへの回答)

| # | 確認事項 | 結論 |
|---|---|---|
| 1 | FSRS scheduler は実装済か | **実装済**。 ただし path は `lib/fsrs.ts` (spec §4 想定の `lib/fsrs/scheduler.ts` ではない)。 `ts-fsrs` v5.3.2 ライブラリ依存、 FSRS-6 アルゴリズム。 |
| 2 | Server Action 群は実装済か | **全未着手**。 `getNextSmartReviewBatch` / `submitReview` / `resetCardStatus` / `getPracticeBatch` いずれも存在しない。 `lib/cards/review.ts` (spec §4 想定の transaction module) も不在。 |
| 3 | UI route は存在するか | **未着手**。 `/study` 系 route なし。 `app/(app)/app/quiz/page.tsx` が placeholder (「Phase 2 で実装予定」)。 `components/study/` ディレクトリ・`SmartReviewSession.tsx` 不在。 |
| 4 | plan00 流用 (FSRS) は成立しているか | **plan00 自前実装の流用ではなく `ts-fsrs` ライブラリ採用**。 spec §8 の `fsrs.calculate()` という API は実コードに存在しない。 spec の擬似コードと実 API に乖離あり (§3 参照)。 |
| 5 | OCR cards の FSRS 初期値は正しいか | **正しい**。 `processUpload` は FSRS 列を明示 set せず schema default に委譲。 default が `due=now()` / `state=0` / `stability=0` 等で、 新規 card は即 `due <= now()` となりスマート復習 query に乗る。 |
| 6 | study_days への write 経路 | **皆無 (write-dead table)**。 現状 study_days は clerk webhook の DELETE 以外で一切 touch されない。 dashboard streak は `reviews` から算出。 `submitReview` が study_days の初の writer になる。 |

主要発見ポイント:

- **D1**: spec §4 のモジュール path (`lib/fsrs/scheduler.ts` / `lib/cards/review.ts`) と実コード (`lib/fsrs.ts`) が不一致。 spec §8 Logic 6 の `fsrs.calculate(card, rating)` は実 API では `rate(card, rating)` で、 戻り値構造も異なる。
- **D2**: spec §8 Logic 3 のスマート復習 query は `WHERE user_id=? AND due<=now()` (全 exam 横断)、 spec §2.9 の例は `AND exam_id=$2` 付き (exam 単位)。 **spec 内部で矛盾**。 `getNextSmartReviewBatch(limit)` のシグネチャは exam_id を取らず全 exam 横断を示唆。
- **D3**: study_days は誰も書いていない死テーブル。 streak / 今日の学習数は既に `reviews` から算出済 (`getReviewStatsForUser`)。 study_days と reviews の役割重複をどう整理するか要判断 (選択肢 §6-C)。
- **D4**: kickoff 調査項目 6 の前提「`cards.deleted_at` は schema 上存在する」 は**誤り**。 `cards` に `deleted_at` 列は存在しない (soft delete 列を持つのは `users` のみ)。 cards は完全 hard delete 運用で、 スマート復習 query に soft-delete 除外条件は不要。

判断必要: yes (設計選択肢 §6、 採用は claude.ai + OT)

---

## 1. tech-spec 関連記述の整理

### §3 Server Actions (学習セッション、 spec 684-707 行)

| Action | spec シグネチャ | 備考 |
|---|---|---|
| `getNextSmartReviewBatch(limit)` | `→ Result<Card[]>` | `due <= now()` を `due ASC`。 exam_id 引数なし。 |
| `getPracticeBatch(filter)` | `→ Result<Card[]>` | S2.1 用。 filter は custom_props 値指定可。 |
| `submitReview(cardId, isCorrect: boolean)` | `→ Result<{nextDue: Date}>` | 内部 `rating = isCorrect ? 3 : 1`。 reviews insert + cards 統計/FSRS + study_days upsert を 1 transaction。 |
| `resetCardStatus(cardId)` | `→ Result<void>` | answered / last_correct / current_streak / FSRS 状態をリセット (reviews 履歴は残す)。 |

実コードの `ActionResult` 型 (`lib/actions/result.ts`): `{ok:true; data?:T} | {ok:false; error:string}`。 spec の `Result<T>` 表記はこの `ActionResult<T>` を指す。

### §3 Authenticated Routes (spec 670-683 行)

spec 想定: `/study` (入口 2 ボタン) / `/study/smart` / `/study/practice`。
**実コードの route prefix は `/app/`** (route group `(app)/app/`)。 spec の `/study` は実装上 `/app/study` 等になる。 現状の placeholder は `/app/quiz` 単一 (§4 参照)。

### §8 Logic 3 — FSRS 6 スケジューリング (spec 1007-1029 行)

- 入力: card_id, isCorrect (boolean)
- 内部変換: `rating = isCorrect ? 3 : 1` (3=good / 1=again)
- 出力: 次回 due / stability / difficulty / state
- 保存 (1 transaction): reviews 履歴 + cards FSRS 列デノーマ + cards 学習統計 (answered/last_correct/current_streak) + study_days upsert
- スマート復習 query: `SELECT * FROM cards WHERE user_id=? AND due<=now() ORDER BY due ASC LIMIT 100`

### §8 Logic 6 — カード学習統計の同期更新 (spec 1049-1104 行)

transaction 構造 (擬似コード) は spec に明記。 ただし擬似コードの `fsrs.calculate(card, rating)` は実 API と不一致 (§3 D1)。 study_days upsert は `onConflictDoUpdate` で `review_count + 1` / `correct_count + (isCorrect?1:0)`。

### §2.5.2 cards — FSRS state 列 (schema 確認済)

`lib/db/schema.ts` の `cards` 定義と spec §2.5.2 は一致。 FSRS 列と default:

| 列 | 型 | default | ts-fsrs `createEmptyCard()` の対応値 |
|---|---|---|---|
| `due` | timestamptz | `defaultNow()` | now() ✓ |
| `state` | integer 0/1/2/3 | `0` | New=0 ✓ |
| `stability` | real | `0` | 0 ✓ |
| `difficulty` | real | `0` | 0 ✓ |
| `elapsed_days` | integer | `0` | 0 ✓ |
| `scheduled_days` | integer | `0` | 0 ✓ |
| `reps` | integer | `0` | 0 ✓ |
| `lapses` | integer | `0` | 0 ✓ |
| `learning_steps` | integer | `0` | 0 ✓ |
| `last_review` | timestamptz nullable | (なし=NULL) | undefined ✓ |
| `answered` | boolean | `false` | (FSRS 外、 app 統計) |
| `last_correct` | boolean nullable | (なし=NULL) | (FSRS 外) |
| `current_streak` | integer | `0` | (FSRS 外) |

schema default が `ts-fsrs` の new card と完全一致する。 cards_due_idx `(user_id, due)` がスマート復習 query を支える。

### §2.3.4 reviews + rating mapping

`rating` integer `$type<1|2|3|4>()`。 1=again / 2=hard / 3=good / 4=easy。 MVP 二値は 1 / 3 のみ書込。 index: `reviews_user_reviewed_idx (user_id, reviewed_at)` / `reviews_card_idx (card_id, reviewed_at)`。 FK `card_id → cards.id ON DELETE CASCADE`。

### §2.5.4 study_days — upsert 構造

複合 PK `(user_id, day)`。 `day` は JST 日付文字列。 `review_count` / `correct_count`。 spec の upsert 例は `onConflictDoUpdate` で各 count を SQL 加算。

---

## 2. FSRS scheduler 現状実装 trace

### `lib/fsrs.ts` (全 32 行)

- ライブラリ依存: `ts-fsrs` v5.3.2 (`package.json` dependencies)。 plan00 自前実装ではなく外部ライブラリ採用。
- export:
  - `scheduler` — `fsrs()` シングルトン (default パラメータ。 per-user 最適化は YAGNI で対象外)
  - `RatingInt` 型 — `1 | 2 | 3 | 4`
  - `newCard(): Card` — `createEmptyCard()` ラッパ
  - `rate(card: Card, rating: RatingInt)` — `RATING_MAP` で app の 1..4 を `Rating` enum に変換 → `scheduler.next(card, new Date(), enumVal)` を返す。 不正 rating は throw。
- 戻り値: `scheduler.next()` は `RecordLogItem = { card: Card; log: ReviewLog }`。 新 FSRS 状態は `.card`、 履歴は `.log`。

### `ts-fsrs` の `Card` 型 (lib が受け渡す形)

```
interface Card {
  due: Date; stability: number; difficulty: number;
  elapsed_days: number; scheduled_days: number; learning_steps: number;
  reps: number; lapses: number; state: State; last_review?: Date;
}
```

DB `cards` 行 (snake_case 列) ↔ ts-fsrs `Card` (snake_case プロパティ) はほぼ 1:1。 差分は `last_review` の NULL ↔ undefined のみ。

### spec との乖離 (D1 詳細)

| 項目 | spec §4 / §8 | 実コード |
|---|---|---|
| scheduler の path | `lib/fsrs/scheduler.ts` | `lib/fsrs.ts` |
| transaction module | `lib/cards/review.ts` | 不在 |
| FSRS 計算 API | `fsrs.calculate(card, rating)` → flat object | `rate(card, rating)` → `{card, log}` (nested) |
| 出力の読み方 | `newFsrs.due` 等を直接参照 | `result.card.due` / `result.card.stability` 等 |

`submitReview` 実装時は spec §8 Logic 6 擬似コードをそのまま写経できない。 実 API (`rate()` → `.card`) に合わせた mapping が要る。

### `lib/fsrs.test.ts` (4 ケース)

`newCard()` が state 0、 `rate(_,1)` の due < `rate(_,4)` の due、 `rate(_,0)` / `rate(_,5)` が throw。 `lib/fsrs/scheduler.test.ts` は不在 (path 自体が無いため)。

---

## 3. Server Action / API の状況

| 対象 | 状態 | trace 結果 |
|---|---|---|
| `getNextSmartReviewBatch(limit)` | **未着手** | grep ヒット 0。 due-based query は dashboard の **COUNT のみ** 部分存在 (`app/(app)/app/page.tsx`: `count()` + `lte(cards.due, new Date())`、 行取得ではない)。 |
| `submitReview(cardId, isCorrect)` | **未着手** | grep ヒット 0。 reviews への INSERT 経路はコード全体で皆無。 |
| `resetCardStatus(cardId)` | **未着手** | grep ヒット 0。 |
| `getPracticeBatch(filter)` (S2.1) | **未着手** | grep ヒット 0。 filter 型 `{examIds, customPropFilters, accuracyMax, limit, timeLimitSec}` は spec §8 Logic 4 に定義あり。 |
| `lib/cards/review.ts` (transaction module) | **不在** | spec §4 が想定するファイルが存在しない。 |

既存 Server Action のパターン (`deleteExam` 等で確認):

- `'use server'` ヘッダ、 `getCurrentUser()` で auth gate → `{ok:false, error:'認証が必要です'}`
- owner-scoped クエリ (`WHERE user_id = ?` 必須、 CLAUDE.md テナント分離ルール)
- 副作用後に `revalidatePath()`

---

## 4. UI 既存状況

| route / component | spec 想定 | 実態 |
|---|---|---|
| `/study` 入口 (2 ボタン) | あり | **なし** |
| `/study/smart` | あり | **なし** |
| `app/(app)/app/quiz/page.tsx` | — | placeholder (「Phase 2 で実装予定」、 14 行) |
| `components/study/SmartReviewSession.tsx` | あり (spec §4) | **なし** (`components/study/` 自体なし) |
| dashboard 「スマート復習（N件）」 button | — | `/app/quiz` placeholder へ暫定リンク (`dashboard-actions.tsx`、 コメントに「`/study/smart` 実装後に切替予定」) |
| app-header 「演習」 nav | — | `/app/quiz` へリンク |

route 関連の制約:

- `revalidateAppPath()` の `AppPath` 型 literal は `/app` `/app/settings` `/app/quiz` `/app/upload` `/app/exams` のみ。 新規 study route を `<Link onClick>` で revalidate したい場合、 `AppPath` 型へ項目追加が必要。
- dashboard の due 件数は既に算出済 (`dueCount`) で、 button 文言「スマート復習（{dueCount}件）」 は機能している。 リンク先のみ placeholder。

---

## 5. FSRS state 初期値の確認 (OCR 経路)

`app/(app)/app/upload/_actions/process.ts` の cards bulk INSERT (466-486 行):

- `cardRows` はコンテンツ列 (title / questionText / options / ... / tags) のみ構築。
- **FSRS 列・学習統計列は一切指定せず schema default に委譲** (コードコメント: 「学習初期値 (FSRS) は default に任せる」)。
- 結果、 §1 の default 表どおり `due=now()` / `state=0` / `stability=0` 等で INSERT される。

スマート復習 query (`due <= now()`) から見た整合性:

- 新規 card は INSERT 時刻 = `due` なので、 作成直後から `due <= now()` を満たす → スマート復習に必ず乗る。 ✓
- `state=0` (New) なので、 初回 `submitReview` 時に DB 行をそのまま ts-fsrs `Card` にマップして `scheduler.next()` に渡せば、 ts-fsrs は New state として初期 stability/difficulty を grade から算出する (格納済 `stability=0` は New では無視される)。 → 「DB 行をそのまま渡す」 と 「`newCard()` を使う」 のどちらでも初回挙動は等価 (選択肢 §6-F)。
- `answered=false` / `last_correct=NULL` / `current_streak=0` も default で正しく入る。

---

## 6. cards に対する FSRS state の整合性

- **削除済 user の cards**: S1.9.5 で物理削除済 → スマート復習 query に残存しない。 問題なし。
- **archived exam の cards** (`exams.archived_at NOT NULL`): cards は exam archive で消えず、 due 列も保持される。 spec §8 Logic 3 の query (`WHERE user_id=? AND due<=now()`) も dashboard の dueCount query も **archived 除外条件を持たない**。 → archived exam の card がスマート復習に混ざるか否かは未定義 (選択肢 §6-E)。
- **soft-deleted cards**: **存在しない**。 `cards` テーブルに `deleted_at` 列は無い (schema 確認済、 soft delete 列を持つのは `users` のみ)。 cards は完全 hard delete 運用。 スマート復習 query に soft-delete 除外条件は不要。 ※ kickoff 調査項目 6 の「`cards.deleted_at` は schema 上存在する」 は事実誤認 (D4)。

---

## 7. 既存 test / 関連 file

- `lib/fsrs.test.ts` — 4 ケース (§2)。 `lib/fsrs/scheduler.test.ts` は不在。
- **cards への write 経路**: `process.ts` の OCR INSERT のみ。 review による cards UPDATE 経路は皆無 → `submitReview` が cards の初の UPDATE writer になる。
- **study_days への write 経路**: **皆無**。 grep で INSERT/upsert ヒット 0。 唯一の参照は clerk webhook `handleUserDeleted` の `DELETE`。 study_days は現状「定義のみ・データ 0 行」 の死テーブル。
- **streak / 今日の学習数**: `lib/db/streak.ts` の `getReviewStatsForUser` が **`reviews` テーブルから直接** 算出 (`COUNT(DISTINCT card_id)` + 直近 60 日の JST 日付集合 → `computeStreak`)。 study_days は使っていない。 → `submitReview` が reviews を書けば dashboard の「今日の学習問題数」「連続日数」 は study_days を待たず自動で動き始める。

---

## 8. 設計選択肢の列挙 (修正方針は提示しない)

### 8.1 解答後の遷移 UX (kickoff 7.1)

- **(a) submit → server response → 即 自動遷移**: タップ数最小。 ただし正誤・解説を読む間がない。 二値 + 解説表示と両立しにくい。
- **(b) submit → response → 「次へ」 button 明示**: 解説を読んでから能動的に次へ。 タップ 1 回増。 確定済方針「即フィードバック → 次へ」 と素直に整合。
- (c) その他 (例: 一定秒数後 auto + skip button)。

### 8.2 解説表示のタイミング (kickoff 7.2)

- **(a) 解答後 即表示**: 正誤と同時に解説が出る。 画面情報量が多い。
- **(b) 解答後 button で展開**: 既定は正誤のみ、 必要時のみ解説。 タップ増。
- **(c) 解答後表示 + 「次へ」 を同 page 共存**: 解説 + 次へを 1 画面に。 (a)+8.1(b) の組合せ。 MCQ 学習アプリの標準形に近い。
- 補足: `cards.explanation_text` (card 全体) と `options[].explanation` (選択肢別) の 2 系統がある。 どちらをどう出すかも論点。

### 8.3 batch fetch 戦略 (kickoff 7.3)

- **(a) 大きめ batch (~100 件)**: spec の `LIMIT 100` 準拠。 round trip 最小。 client memory 保持。 batch 内の card は fetch 時 snapshot で固定 (§8.4 と関連)。
- **(b) 1 問ずつ fetch**: 毎回 due 再評価で常に最新。 round trip 多。 PWA / モバイル回線で体感遅延。
- **(c) 中間 (10-20 件 batch、 消化後に次 batch)**: round trip と鮮度の折衷。 実装やや複雑。

### 8.4 batch 取得後に due が変わるケース (kickoff 7.4)

- スマート復習 batch fetch 後、 1 問目を間違える → その card の `due` は伸びる (FSRS) が batch 配列内にはまだ残っている。
- **(a) fetch 時 snapshot 固定**: batch 内の順序・件数を変えない。 同 session で 1 度間違えた card を再出題しない (シンプル、 spec の batch 前提と素直)。
- **(b) 毎回 due 再評価**: submit のたびに残りを再 query。 間違えた card を同 session で再出題 (FSRS の Learning ステップに忠実) も可能だが round trip 増・実装複雑。
- 関連論点: 「間違えた card を同 session で再出題するか / 次 session 送りか」 (FSRS の learning_steps と UX の兼ね合い)。

### 8.5 session 終了条件 (kickoff 7.5)

- **(a) due card が尽きるまで自動継続**: 「全部復習しきる」 体験。 due が多いと長時間。
- **(b) limit 件数で打ち切り → 結果表示**: 1 session の上限が明確。 残 due は次回。
- **(c) user の「終了」 button で任意終了**: いつでも中断可。 (a)/(b) と併用前提。
- 補足: batch=100 fetch で「100 件解いたら一旦結果」 は (b) と (a) の自然な合流点になる。

### 8.6 結果表示の内容 (kickoff 7.6)

- session 終了時の候補指標: 出題数 / 正解数 / 正答率 / 所要時間 / 残り due 件数 / 連続日数 (streak)。
- streak / 今日の学習数は `getReviewStatsForUser` で既に算出可能 (§7) → 結果画面で再利用するか、 dashboard 帰還で見せるかは論点。

### 8.7 (追加 A) スマート復習のスコープ — 全 exam 横断 vs exam 単位

- spec 内部矛盾 (D2)。 `getNextSmartReviewBatch(limit)` のシグネチャ・dashboard button (全 exam の dueCount) は **全 exam 横断** を示唆。 spec §2.9 の例 query のみ exam 単位。
- **(a) 全 exam 横断**: dashboard 「スマート復習（N件）」 と一貫。 「今日やるべき復習」 を 1 ボタンで。
- **(b) exam 選択 → その exam のみ**: 試験ごとに分けて復習。 入口で exam 選択 UI が要る。
- MVP は (a) が現状 UI と素直。 (b) は S2.1 カスタム演習側の責務とも重なる。

### 8.8 (追加 B) route 命名

- 現 placeholder は `/app/quiz`、 dashboard / header / `AppPath` 型がすべてこれを指す。 spec は `/study` `/study/smart`。
- **(a) `/app/quiz` placeholder を実装で置換**: 既存リンク・`AppPath` 型を変えずに済む。 ただし spec の route 名と不一致のまま。
- **(b) spec 準拠で `/app/study` `/app/study/smart` を新設**: spec 整合。 dashboard / header / `AppPath` 型 / `revalidate.ts` コメントの更新が要る。 `/app/quiz` は S2.1 演習用に転用 or 撤去。
- いずれも spec §3 と実 route prefix (`/app/`) の差は残る。

### 8.9 (追加 C) study_days と reviews の役割整理

- study_days は現状 死テーブル、 streak は `reviews` から算出 (§7、 D3)。
- spec §8 Logic 6 は `submitReview` transaction で study_days を upsert する設計。
- **(a) spec どおり study_days も upsert**: transaction が 3 write (reviews / cards / study_days)。 ただし streak の読み手は今も reviews。 study_days は「書くだけで読まれない」 状態が続く。
- **(b) study_days upsert を実装し、 dashboard 集計を study_days 起点に移す**: reviews 全走査より集計が軽い。 streak ロジック (`getReviewStatsForUser`) の書き換えを伴う。
- **(c) MVP は study_days を書かず reviews 一本化、 study_days は v1.x**: transaction 簡素化。 spec §8 Logic 6 から逸脱 (spec 改訂が要る)。
- 論点の本質: streak / 月次統計の真実 source を reviews に寄せるか study_days に寄せるか。

### 8.10 (追加 D) FSRS Card ↔ DB 行の mapping

- `submitReview` は DB `cards` 行 → ts-fsrs `Card` に変換 → `rate()` → `.card` を DB 列に書き戻す、 という双方向 mapping が要る。
- 論点: mapping ヘルパをどこに置くか (`lib/fsrs.ts` 拡張 / `lib/cards/review.ts` 新設 / inline)。
- 論点: `rate()` は内部で `new Date()` を review 時刻に使うため、 caller から共有 `now` を注入できない。 `reviews.reviewed_at` / `cards.last_review` / `study_days.day` / `card.due` を厳密に同一時刻で揃えたい場合、 `rate()` に `now` 引数を足すか否かが論点 (現 `rate()` シグネチャ変更の要否)。

### 8.11 (追加 E) archived exam の card をスマート復習に含めるか (kickoff 6)

- **(a) 含める**: query は `due` のみで素直。 ただしダウングレードで自動 archive された exam の card まで復習対象に出る。
- **(b) 除外**: `JOIN exams ON ... WHERE exams.archived_at IS NULL` が要る。 dashboard の dueCount query も同条件に揃える必要 (両者の件数齟齬を防ぐ)。
- 現状はどちらの query も archived を除外していない → (a) が現状の暗黙挙動。

### 8.12 (追加 F) 新規 card (state=0) を scheduler に渡す方法

- **(a) DB 行をそのまま ts-fsrs `Card` にマップして `rate()`**: 経路が 1 本。 state=0 のとき格納 `stability=0` は ts-fsrs が無視するため初回も正しい (§5)。
- **(b) `state===0` のとき `newCard()` を使い、 以降は DB 行**: 分岐が要る。 (a) と初回挙動は等価なので実利は薄い。
- §5 のとおり OCR default が `createEmptyCard()` と一致するため (a) で問題ない見込み。 plan 段階で 1 ケース実証推奨。

---

## 9. plan 着手時に確認すべき点 (申し送り)

- spec §4 / §8 の path・API 名と実コードの乖離 (D1): plan は実 API (`lib/fsrs.ts` の `rate()` → `{card, log}`) を前提に書く。 spec 擬似コードの写経は不可。
- spec の route 名 (`/study/smart`) と実 prefix (`/app/`) の差、 placeholder `/app/quiz` の扱い (§8.8) を先に決める。
- `AppPath` 型・dashboard-actions・app-header の暫定リンク更新が UI 実装に付随する。
- study_days を書くか否か (§8.9) で `submitReview` transaction の write 数が変わる。
- spec §3 Server Action 群・§4 モジュール path が実装と乖離しているため、 S2.0 実装後に **spec §3 / §4 / §8 の追補が要る** (役割境界ルール: 実装中に spec を勝手に書き換えず、 sprint closure で別途反映)。

---

## 10. アウトプット / 次の一手

- 本 doc = 事前調査の単一成果物。 実装変更 0。
- 設計選択肢 (§8.1〜8.12) の採用は claude.ai + OT が後段で決定。
- 決定後、 writing-plans skill で S2.0 plan を drafting (Sprint 境界停止ルールに従い、 plan は別 sprint タスク)。
