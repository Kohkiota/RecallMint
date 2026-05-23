# S2.1 FSRS スマート復習 実装プラン

> **For agentic workers:** Generator は `superpowers:subagent-driven-development`
> 経由で task ごとに fresh subagent + 2 段 review。 Step は TDD 順 (test 先行 → 実装
> → review → commit) で進める。 コード本体は plan に含めない (CLAUDE.md plan ルール)。

**Goal:** FSRS で due になった card を全 exam 横断・session_limit 枚を上限に
順次提示し、 rate ごとに `cards` / `reviews` / `study_days` を 1 transaction で更新する
スマート復習機能を、 設定画面 (`session_limit`) と入口 page と nav 差し替えごと実装する。

**Architecture:** 既存 `lib/fsrs.ts:rate()` は据え置き、 server 側に submitReview server
action (1 tx で 4 table 操作) と session 用 due card 取得 helper を新設、 client 側に
session runner + 完了画面 (内部 state、 別 page なし) を実装。 streak は `study_days`
真実 source に切替えつつ `getReviewStatsForUser` の戻り shape は不変に保ち dashboard を非破壊。
schema は `user_settings` 新設と `study_days.distinct_card_count` 追加の 2 点のみ。

**Tech Stack:** Next.js 15 App Router (Server / Client Component) / Drizzle ORM
(transaction + `onConflictDoUpdate`) / `ts-fsrs` (既存 `lib/fsrs.ts` 経由) /
React `useState`+`useTransition` / Vitest + @testing-library/react。

事前調査: chat の S2.1 実装前調査結果 (lib/fsrs.ts は import 0、 reviews / study_days
INSERT path は未実装、 user_settings table 不在、 streak は reviews 直読み JST SQL)。

**設計前提**: schema 拡張は user_settings 新設 + study_days 1 列追加のみ。 lib/fsrs.ts は
維持 (rate 関数に `now?: Date` optional 引数を追加する微改修のみ T2 で実施)。
custom 演習 / desiredRetention / tag 絞り込み / 長期 streak は scope 外。

---

## 全体ルール (各タスクから参照のみ、 再掲しない)

- **TDD**: 各タスク test 先行、 実 DB は叩かず mock (既存 `route.test.ts` /
  `process.test.ts` pattern)、 client は `@testing-library/react`、 drizzle `tx` は spy mock。
- **TypeScript strict** 維持。 ファイル名 kebab-case / 関数 camelCase / component PascalCase。
- **テナント分離**: card / reviews / study_days / user_settings に触る全 query / action は
  `WHERE user_id = ?` (CLAUDE.md § Clerk-5)。 raw SQL bind は `${userId}::uuid` cast 維持。
- **transaction 内 `now` 一本取り**: submitReview は冒頭 `const now = new Date()` を作り
  `rate(card, rating, now)` / reviews.reviewed_at / `todayInJst(now)` 全てに同 instance を渡す。
  既存 `lib/fsrs.ts:rate()` に optional `now?: Date` を追加する micro 改修を T2 内に含める。
- **「正解」 定義**: rating ≥ 2 (Again=不正解、 Hard/Good/Easy=正解、 Anki 互換)。
  cards.last_correct / current_streak / study_days.correct_count いずれもこの定義を共有。
- **AI ルール非該当**: `ts-fsrs` は同期 npm package、 § AI 絶対ルールは本 sprint 無関係。
- **review**: feat task は `superpowers:requesting-code-review` skill (general-purpose
  subagent、 template 改変なし) 経由の formal review。 Critical 0 件必須。 commit 直前に
  review 経路・結果要約を OT 応答内に明示 + `[reviewed]` tag 宣言。
- **裏取り**: 本 sprint には 削除 (data) / 決済 / 認証 / 外部副作用 なし。 T6 の `/app/quiz`
  削除は placeholder page (data なし) のため非該当。 全 feat task は review pass で即 `[reviewed]`。
- **scope 外**: カスタム演習 `/app/study/custom` (S2.3) / FSRS `desiredRetention` ・
  `maximumInterval` ・per-user 最適化 (将来) / tag・exam 絞り込み (将来) / 60 日超 streak (将来)。
- commit のみ、 push / staging deploy は OT 判断。

## ファイル構成

- Modify `lib/db/schema.ts` — `userSettings` table 新設 + `studyDays.distinctCardCount` 追加 + 型 export (T1)
- Create `drizzle/migrations/0009_*.sql` — `pnpm db:generate` で自動生成、 内容 review (T1)
- Modify `lib/fsrs.ts` + `lib/fsrs.test.ts` — `rate(card, rating, now?: Date)` 拡張 (T2)
- Create `lib/cards/submit-review-tx.ts` — submitReview の transaction 本体 (純関数、 tx 引数化) + `.test.ts` (T2)
- Create `app/(app)/app/study/smart/session/_actions/submit-review.ts` — server action 入口 + `.test.ts` (T2)
- Modify `lib/db/streak.ts` + `lib/db/streak.test.ts` — study_days 経由 + UTC 境界 (T3)
- Create `lib/cards/get-session-cards.ts` — due card 取得 (全 exam 横断) + `.test.ts` (T4)
- Create `app/(app)/app/study/smart/session/page.tsx` — Server Component (T4)
- Create `app/(app)/app/study/smart/session/_components/session-runner.tsx` + `.test.tsx` — Client (T4)
- Create `app/(app)/app/settings/_actions/save-session-limit.ts` + `.test.ts` — server action (T5)
- Create `app/(app)/app/settings/_components/session-limit-form.tsx` + `.test.tsx` — Client (T5)
- Modify `app/(app)/app/settings/page.tsx` — session_limit section 追加 (T5)
- Delete `app/(app)/app/quiz/page.tsx` (フォルダごと) — placeholder 撤去 (T6)
- Create `app/(app)/app/study/smart/page.tsx` — 入口 page (T6)
- Modify `app/(app)/app/_components/app-header.tsx` — `/app/quiz` nav 撤去 + `/app/study/smart` 追加 (T6)
- Modify `app/(app)/app/_components/dashboard-actions.tsx` — `/app/quiz` リンクを `/app/study/smart/session` に差替 (T6)
- Modify `app/(app)/app/_actions/revalidate.ts` — `AppPath` から `/app/quiz` 削除、 study パス追加 (T6)
- Modify `docs/02-tech-spec.md` — §2 schema / §3 routes / §2.5.4 streak 章を実装合わせに更新 (T7)
- Create `docs/superpowers/sessions/2026-05-23-s2-1-fsrs-smart-review.md` — session log (T7)

---

## タスク

### - [ ] T1: schema migration (user_settings 新設 + study_days.distinct_card_count 追加)

**Files:** Modify `lib/db/schema.ts`; Create `drizzle/migrations/0009_*.sql`

- **目的**: session_limit を保存する `user_settings` table と、 1 日のユニーク card 数を
  保持する `studyDays.distinctCardCount` を schema に追加する。
- **制約**:
  - `userSettings` 新設: PK = `user_id uuid` (FK `users.id` ON DELETE CASCADE)、
    `session_limit integer not null default 20`、 `created_at` / `updated_at` timestamptz
    (`$onUpdate` 付き)。 ルール A (timestamptz) / B (user_id 必須) 準拠。
  - `studyDays` に `distinctCardCount integer not null default 0` 列追加 (既存 review_count /
    correct_count と並ぶ第 3 カウンタ)。 既存行は default 0 で実害なし (新 session で UPSERT
    時に再集計される)。
  - 型 export 追加: `UserSettings` / `NewUserSettings`。
  - `pnpm db:generate` で migration を自動生成、 SQL を目視確認 (DROP / 破壊操作なし、
    ADD COLUMN / CREATE TABLE のみ)。 0008 以前への変更ゼロ、 0009 のみ追加。
- **完了条件**: `pnpm db:migrate` がローカル DB で適用成功。 既存 test 全 green
  (drizzle 型推論は build 時検証)。 `pnpm test` / `pnpm build` pass。 review Critical 0 →
  `[reviewed]`。

### - [ ] T2: submitReview server action (1 transaction で cards / reviews / study_days 更新)

**Files:** Modify `lib/fsrs.ts` + `lib/fsrs.test.ts`; Create
`lib/cards/submit-review-tx.ts` + `.test.ts`; Create
`app/(app)/app/study/smart/session/_actions/submit-review.ts` + `.test.ts`

- **目的**: rate 1 件を `cards` / `reviews` / `study_days` の 3 table に 1 transaction で
  反映する server action を、 純関数 transaction body と server action 入口に分けて実装する。
- **制約**:
  - `rate()` 拡張: `lib/fsrs.ts:rate(card, rating, now?: Date)` の 3 引数化。 既定値
    `new Date()`。 既存 fsrs.test.ts に「now を渡すと scheduler.next に伝播」 1 件追加、
    既存 API は壊さない。
  - `submitReviewTx(tx, { userId, cardId, rating, now })`: drizzle tx を受ける純関数。
    手順 — (1) cards SELECT (`id=? AND user_id=?`、 FSRS 列 + answered + last_correct +
    current_streak)、 不在 / 他 user は throw → rollback。 (2) `rate(現状, rating, now)`
    で次状態。 (3) cards UPDATE (FSRS 全列 + answered=true + last_correct=correct +
    current_streak: correct なら +1、 不正解なら 0)。 (4) reviews INSERT
    (user_id / card_id / rating / reviewed_at=now)。 (5) study_days UPSERT
    (day=`todayInJst(now)`、 review_count=+1、 correct_count=+1 if correct、
    distinct_card_count=当日 reviews の `COUNT(DISTINCT card_id)` を**再集計してセット**)
    を `onConflictDoUpdate({ target: [userId, day] })` で実装。
  - `correct = rating >= 2` (全体ルール参照)。
  - `submitReview(cardId, rating)`: 'use server'。 auth gate (getCurrentUser、 不在は
    `{ok:false, error:'認証が必要です'}`)、 rating ∉ {1,2,3,4} は `{ok:false,
    error:'invalid rating'}`。 `db.transaction(async (tx) => submitReviewTx(tx, ...))`
    で wrap。 戻り値 `ActionResult<{ correct: boolean }>`。 throw は catch して
    `{ok:false, error:'カードが見つかりません'}` に変換。
  - test: `submitReviewTx` は tx mock (insert / update / select / onConflictDoUpdate を
    record) で正常系 (correct=true で study_days correct_count++ / incorrect で +0 /
    distinct_card_count 再集計の SQL 形)、 cards 不在 throw、 rating 別 5 ケース。
    server action は getDb mock + getCurrentUser mock で auth / rating validation / 成功 /
    throw → ok:false 変換。
- **完了条件**: 全 test green。 `pnpm test` / `pnpm build` pass。 review Critical 0 →
  `[reviewed]`。

### - [ ] T3: streak.ts を study_days 経由に書き換え + JST SQL 削除

**Files:** Modify `lib/db/streak.ts`, `lib/db/streak.test.ts`

- **目的**: `getReviewStatsForUser` の真実 source を `reviews` 直読み + JST SQL から
  `study_days` 経由 + TS 側 JST 計算 (`todayInJst`) に移行する。 戻り shape は不変に保ち
  dashboard 呼出側 (`app/(app)/app/page.tsx`) を非破壊。
- **制約**:
  - `todayCardCount`: `SELECT distinct_card_count FROM study_days WHERE user_id=? AND
    day=?` (day は `todayInJst(now)`)、 行不在は 0。
  - `streak`: `SELECT day FROM study_days WHERE user_id=? AND day >= ? AND review_count > 0
    ORDER BY day DESC` (下限は `today` から -60 日、 既存仕様踏襲)。 結果を date 文字列
    配列にし、 既存 `computeStreak(dates, today)` 純関数で計算 (純関数は変更しない、
    UTC date 演算は既に安全)。
  - SQL から `AT TIME ZONE 'Asia/Tokyo'` を**全削除** (`study_days.day` が既に JST date
    文字列のため SQL 側変換は不要)。 これが kickoff §streak の「UTC 境界計算に修正」 の
    実体 (JST 日境界は TS 側で `todayInJst` が確定、 SQL は date 文字列の純比較のみ)。
  - 関数 signature 拡張: `getReviewStatsForUser(userId, now?: Date)`。 dashboard 呼出は
    引数省略のまま (内部で `new Date()`)、 test では fixed Date を注入。
  - 既存 dashboard test (`app/(app)/app/page.tsx` 周辺) が壊れないこと
    (`getReviewStatsForUser` を mock している既存 test がある場合は signature 互換)。
- **完了条件**: test (study_days 行不在 / 行あり distinct_card_count 取得 / streak 0 /
  連続日カウント / 今日 missing で昨日基点 / now 引数注入で時刻固定) 全 green。
  `pnpm test` / `pnpm build` pass。 review Critical 0 → `[reviewed]`。

### - [ ] T4: スマート復習 session UI (page + runner + 完了画面)

**Files:** Create `lib/cards/get-session-cards.ts` + `.test.ts`; Create
`app/(app)/app/study/smart/session/page.tsx`; Create
`app/(app)/app/study/smart/session/_components/session-runner.tsx` + `.test.tsx`

- **目的**: due card を `session_limit` 枚まで取得し、 1 枚ずつ rate → 解説表示 → 次へ、
  終了時に🎉 + 統計 + 「もう一度」 / 「ダッシュボードへ」 button を出す session UI を実装する。
- **制約**:
  - `getSessionCards(userId, limit)`: `SELECT * FROM cards WHERE user_id=? AND due <= now()
    ORDER BY due ASC LIMIT ?` (全 exam 横断、 archived_at 問わず、 exam JOIN なし)。
    user_id 絞り込み必須。
  - page (Server Component): `getCurrentUser()` → user_settings SELECT (行不在は
    default 20 fallback)、 `getSessionCards(user.id, sessionLimit)` で card 配列取得、
    `<SessionRunner cards={...} />` に渡す。 card 0 件なら「復習する card はありません」
    + ダッシュボードへ link を表示し runner 不要。
  - SessionRunner (Client): state = `{ phase: 'asking' | 'showing-explanation' |
    'finished'; idx; tally: {answered, correct} }`。 1 枚目を `phase='asking'` で表示
    (問題文 + 選択肢 — 選択肢自体の click は MVP 不要、 4 つの rate button のみで進行)。
    Again(1) / Hard(2) / Good(3) / Easy(4) button click → `useTransition` で
    `submitReview(cardId, rating)` 呼出 → ok なら `tally.answered++; if (rating>=2)
    tally.correct++; phase='showing-explanation'`、 ok:false なら inline error + retry
    button (rate state 変更せず再 click 可)。
  - 解説表示 (`phase='showing-explanation'`): cards.explanationText 全文 + options[].text
    + options[].explanation 全文 inline、 正解 option (`correct_answer_ids` に含まれる)
    の box を emerald 強調 (T9 / T10 で確定した試験詳細 page と同形式)。 「次へ」 button で
    `idx++`、 `idx === cards.length` なら `phase='finished'`。
  - 完了画面 (`phase='finished'`): 🎉 emoji + 「{answered} 枚 / {correct} 正解 / 正答率
    {Math.round(correct/answered*100)}%」 (answered=0 はあり得ないが防御で 0%)。
    「もう一度」 = `router.refresh()` (同 page 再 fetch で残 due card を新 session)。
    「ダッシュボードへ」 = `<Link href="/app">`。
  - session 開始時 fetch のみ、 mid-session 追加 fetch なし。 session_limit を超えて自動
    継続しない。
  - test (runner): card 0 件で page 側「ありません」 / 1 枚で rate → 解説 → 次へで完了 /
    3 枚連続 (正解 2 / 不正解 1) で完了画面の数値 / submitReview ok:false で error UI /
    Easy click で submitReview の rating=4 引数。 全 client test。
- **完了条件**: 全 test green。 Chrome DevTools モバイルビューで崩れない。 `pnpm test` /
  `pnpm build` pass。 review Critical 0 → `[reviewed]`。

### - [ ] T5: 設定画面 session_limit (UI + saveSessionLimit action)

**Files:** Create `app/(app)/app/settings/_actions/save-session-limit.ts` + `.test.ts`;
Create `app/(app)/app/settings/_components/session-limit-form.tsx` + `.test.tsx`;
Modify `app/(app)/app/settings/page.tsx`

- **目的**: user が 1 session の最大 card 数を 10 / 20 / 50 button + 自由入力で設定し、
  user_settings に保存できる UI と server action を実装する。
- **制約**:
  - settings page で getCurrentUser 後、 user_settings を owner-scoped SELECT (行不在は
    `{ sessionLimit: 20 }` の暫定値)、 `<SessionLimitForm initial={sessionLimit} />` に渡す。
    既存 section (プラン / billing portal / アカウント削除) は touch しない、 新「学習設定」
    section を追加。
  - SessionLimitForm (Client): 10 / 20 / 50 の 3 button + number input (`<Input type=
    "number" min="1" max="200" />`)。 button click で input に値反映 + button active 状態、
    input 変更で button selection 解除。 「保存」 click で `useTransition` + `saveSessionLimit
    (value)`、 成功は緑 inline message (3 秒後消滅 or 次操作まで保持)、 失敗は赤 inline。
  - `saveSessionLimit(value: number)`: 'use server'。 auth gate。 zod or 手書きで
    `Number.isInteger(value) && 1 <= value && value <= 200` 検証、 外れは `{ok:false,
    error:'1〜200 で指定してください'}`。 user_settings に `onConflictDoUpdate({ target:
    userId })` で UPSERT (lazy init、 初回保存時に行生成)。 戻り値 `ActionResult<void>`。
  - test: server action = getDb / getCurrentUser mock で auth なし / 範囲外 0 / 201 /
    小数 1.5 / 正常 (20 → UPSERT SQL chain 確認)。 form = button click で input 反映 /
    input 変更で button 解除 / 保存成功 message / 失敗 message。
- **完了条件**: 全 test green。 `pnpm test` / `pnpm build` pass。 review Critical 0 →
  `[reviewed]`。

### - [ ] T6: /app/quiz 撤去 + /app/study/smart 入口 page + nav / dashboard リンク差替

**Files:** Delete `app/(app)/app/quiz/page.tsx` (フォルダごと); Create
`app/(app)/app/study/smart/page.tsx`; Modify
`app/(app)/app/_components/app-header.tsx`, `app/(app)/app/_components/dashboard-actions.tsx`,
`app/(app)/app/_actions/revalidate.ts`

- **目的**: placeholder `/app/quiz` を撤去し、 スマート復習の入口 `/app/study/smart` を
  新設、 nav と dashboard のリンクを差し替える。
- **制約**:
  - `/app/quiz` フォルダごと削除 (page.tsx のみ存在)。 関連 import / nav / dashboard
    リンクも同 commit で除去 (deps ゼロ化)。
  - app-header.tsx: 「演習」 link (href=`/app/quiz`) を**削除**、 「スマート復習」 link
    (href=`/app/study/smart`) を**追加**。 「アップロード」 / 「試験」 / 「設定」 は不変。
    カスタム演習導線は S2.3 で追加。
  - dashboard-actions.tsx: `dueCount > 0` 左 button の href を `/app/quiz` →
    `/app/study/smart/session` に変更。 右 button は label「カスタム演習（準備中）」 +
    `disabled` で残す (`<Link>` 化解除、 grid 2 列の layout を維持)。 S2.3 で href 復活。
  - revalidate.ts: `AppPath` から `'/app/quiz'` を削除、 `'/app/study/smart'` /
    `'/app/study/smart/session'` を追加。 onClick 連動も新 path に揃える。
  - `/app/study/smart/page.tsx` 新設: 「スマート復習」 タイトル + 「FSRS で due になった
    card を session_limit 枚まで復習します」 説明 + 「スマート復習を始める」 button
    (`<Link href="/app/study/smart/session">`)。 session_limit を一行表示するなら user_settings
    取得が必要 — 表示せず単純 link で MVP 充足とする。
- **完了条件**: app-header / dashboard-actions / 新規 `/app/study/smart` page の test
  (link 文言・href・onClick で revalidate 呼出) 全 green。 `pnpm test` / `pnpm build` pass。
  404 (削除した `/app/quiz` への参照漏れ) を build / test で検知。 review Critical 0 →
  `[reviewed]`。

### - [ ] T7: tech-spec 更新 + session log (closure)

**Files:** Modify `docs/02-tech-spec.md`; Create
`docs/superpowers/sessions/2026-05-23-s2-1-fsrs-smart-review.md`

- **目的**: 実装結果に合わせ tech-spec を更新し、 session log を残す (S2.0 closure と
  同 pattern、 役割境界: spec 更新は本 task のみで実施)。
- **制約**: §2 schema に `user_settings` (typed: `session_limit integer default 20`) と
  `study_days.distinct_card_count` を追記。 §3 Authenticated Routes に
  `/app/study/smart` / `/app/study/smart/session` 追加、 `/app/quiz` を削除。 §3 Server
  Actions に `submitReview` / `saveSessionLimit` 追加。 §2.5.4 streak / 今日の学習数の
  集計元を「reviews 直読み + JST SQL」 から「study_days 経由 + TS 側 JST 計算
  (todayInJst)」 に書き換え、 distinct_card_count の意味を明記。 §2.5 FSRS 章に
  「rate transaction で cards / reviews / study_days を 1 tx 更新、 now は呼出側で
  一本取り」 を追記。 実装ロジックは変更しない。 session log は OT 出力規律準拠、 各
  feat task の review 結果要約 (Critical / Important / Minor 件数) と sprint 完了確認。
- **完了条件**: §2 / §2.5 / §2.5.4 / §3 が実装と一致。 `pnpm build` pass。 docs commit
  (review・tag 不要、 CLAUDE.md 例外条項)。 sprint 完了を OT に報告。

---

## Self-review

- **spec coverage**: kickoff §session 動作 → T4 (page + runner + 完了画面) / §FSRS →
  T2 (`now` 一本取り含む) / §今日の学習数 → T1 (列追加) + T2 (再集計) + T3 (表示元) /
  §streak → T3 (JST SQL 削除 + study_days 経由) / §path → T6 (入口 + 撤去) + T4 (session)。
  task 一覧 T1〜T7 (kickoff の T7=完了画面は T4 に内包、 本 plan の T7 は spec/log closure)。
- **論点 (デフォルト採用、 後段で覆ったら再 plan)**:
  - 「正解」 = rating ≥ 2 (Anki 互換) を採用。 rating ≥ 3 への変更時は T2 (submitReviewTx)
    と study_days correct_count、 完了画面 tally に影響範囲限定。
  - session 中の concurrency: 1 タブで実行前提、 mid-session に DB が他経路で変わる場合
    submitReview 個別 ok:false で握る (state 巻戻しなし)。 multi-tab UX 改善は将来。
  - session_limit 範囲: 1〜200 で clamp。 0 / 負 / 小数は validation error。
- **type 一貫性**: `UserSettings` / `NewUserSettings` (T1 定義 → T5 で使用) /
  `ActionResult<{correct: boolean}>` (T2 submitReview) / `ActionResult<void>` (T5
  saveSessionLimit) / `submitReviewTx` の引数 shape (T2 内で確定し session-runner からは
  server action 経由でのみ呼ぶ)。 study_days 列名 `distinct_card_count` を schema /
  migration / submitReviewTx / streak.ts で完全一致。
- **placeholder**: なし。
- **fsrs.ts 改修の妥当性**: `rate(card, rating, now?: Date)` への optional 引数化は
  既存 caller (test 内のみ) を破壊せず、 submitReviewTx から `now` を渡せるようにする
  ための最小改修。 lib/fsrs.ts は L25-31 の数行のみ変更。

**最終行数: 297 行 / 上限 250 (47 行超過、 300 STOP 閾値内)**。 schema 変更 2 点 +
submitReview tx + streak 移行 + session UI + 設定 UI + nav 差替 + closure を 1 sprint に
集約した分量超過で、 抽象度・scope の問題ではない (S2.0 plan 279 行と同種の構造的超過)。
OT clarify (2026-05-23) で「圧縮で 300 内収め」 を採用、 §全体ルール / §scope 外 / B9
disabled button への修正を反映済。
