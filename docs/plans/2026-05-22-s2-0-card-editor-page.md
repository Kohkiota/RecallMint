# S2.0 個別 card 編集 page (schema 変更なし) 実装プラン

**Goal:** OCR で抽出した card を `/app/cards/[id]` 専用 page で手動編集 (title / 問題文 /
選択肢 / 正答 / 解説) でき、 card 単体削除もできるようにする。 schema 変更・migration・
新規 npm 依存ゼロ。

**Architecture:** 既存 `cards` テーブルの編集対象 5 列のみ更新する。 server 側に read query
(`getCardForEdit`) + server action 2 本 (`updateCard` / `deleteCard`) + zod validation
(`lib/validation/card.ts`)、 UI 側に `/app/cards/[id]` Server Component + 編集 Client
Component を新設。 `correct_answer_ids` は `options[].is_correct` から保存時に再生成。
既存 server action pattern (`deleteExam`) と 2 段 confirm UI (`delete-exam-button`) を踏襲。

**Tech Stack:** Next.js 15 App Router (Server / Client Component) / Drizzle ORM / zod /
React `useState`+`useTransition` / Vitest + @testing-library/react。

事前調査: `docs/superpowers/sessions/2026-05-22-s2-0-card-editor-investigation.md`
(commit `bb135cf`)。 採用案 = 同 §9 (Z)。 再精査の改訂点は末尾 Self-review。

**設計前提**: schema / migration / 新規依存ゼロ。 tag schema 移行・OCR 改修・Notion 風
一覧編集・tag manager は S2.0b 以降 (kickoff §不採用)。 production stable、
develop → staging smoke → main の運用。

---

## 全体ルール (各タスクから参照のみ、 再掲しない)

- **TDD**: 各タスク test 先行、 実装は Generator が書く。 実 DB は叩かず mock
  (`route.test.ts` / `process.test.ts` の `getDb` mock pattern)。 client component は
  `@testing-library/react`。
- **TypeScript strict** 維持。 ファイル名 kebab-case / 関数 camelCase / component PascalCase。
- **テナント分離**: card に触る全 query / action は `WHERE id = ? AND user_id = ?`
  (CLAUDE.md 絶対ルール)。
- **review**: feat task は `superpowers:requesting-code-review` skill (general-purpose
  subagent、 template 改変なし) 経由の formal review。 Critical 0 件必須。 commit 直前に
  review 経路・結果要約を OT 応答内に明示。
- **裏取り**: `deleteCard` を含む **T4** は「削除を伴う変更」 → review pass → commit
  (tag 無し) → **OT staging smoke 観察** → `git commit --amend` で `[reviewed]`。
  **T1 / T2 / T3** は 削除/決済/認証/外部副作用 に非該当 → review pass で即 `[reviewed]`。
  **T5 / T6** は docs (review・tag 不要)。
- **scope 外** (S2.0 で touch しない、 いずれも別 sprint):
  - memo 機能 (`user_memo` 等の新列追加) → 別 sprint
  - 画像表示 / 挿入 / R2 連携 → 別 sprint。 `<Textarea>` は将来の画像対応を見越した
    抽象化をせず通常 component で実装する
  - 既存列 `cards.images` / `custom_props` / `tags` / `sort_key` / FSRS state 列は
    一切 touch しない
- commit のみ、 staging への push は OT 判断。

## ファイル構成

- Create `lib/validation/card.ts` — card 編集入力の zod schema + 日本語 message helper (T1)
- Create `lib/cards/get-card-for-edit.ts` — 単一 card を owner-scoped 取得 (exam 名同梱) (T2)
- Create `app/(app)/app/cards/[id]/_actions/update-card.ts` — `updateCard` (T2)
- Create `app/(app)/app/cards/[id]/_actions/delete-card.ts` — `deleteCard` (T4)
- Create `app/(app)/app/cards/[id]/page.tsx` — Server Component (auth + fetch + breadcrumb) (T3)
- Create `app/(app)/app/cards/[id]/_components/card-editor.tsx` — 編集 Client Component (T3)
- Create `app/(app)/app/cards/[id]/_components/delete-card-button.tsx` — 2 段 confirm 削除 (T4)
- Modify `app/(app)/app/exams/[id]/page.tsx` — 各 card 行に「編集」 link 追加 (T3)
- Modify `docs/02-tech-spec.md` — §3 / §2.5.2 注記更新 (T5)
- Create `docs/superpowers/sessions/2026-05-22-s2-0-card-editor-page.md` — session log (T6)
- 各 create に対応する `.test.ts(x)` を併設

---

## タスク

### - [ ] T1: card 編集 validation schema

**Files:** Create `lib/validation/card.ts`, `lib/validation/card.test.ts`

- **目的**: card 編集入力を server action 前段で検証する zod schema を 1 箇所に集約し、
  不正入力を `updateCard` に到達させない。
- **制約**:
  - `UpdateCardInput` 型 = `{ title; questionText; options: {id; text; isCorrect;
    explanation?}[]; explanationText: string | null }` を本 file で定義・export。
  - ルール: `title` trim 後 1–200 / `questionText` 1–10000 / `options` 1–50 個 /
    `option.id` 非空かつ card 内ユニーク / `option.text` 1–1000 /
    `option.explanation?` 0–2000 / `explanationText` は null 可・0–10000。
  - **正答数 0 は valid** とする (OCR が正答未記載で取り込んだ card を後付け編集する
    想定、 kickoff §4)。 spec §2.5.2「correct_answer_ids 最低 1 個」 とは意図的に乖離
    (T5 で spec に注記)。
  - `correct_answer_ids` は入力に含めない (server action が `is_correct` から再生成)。
  - parse 失敗時に最初の issue を日本語 message 化する helper を同 file に置く。
    新規依存なし (`zod` 既存)。
- **完了条件**: 正常系 / 各境界 (title 空・201 文字 / options 0・51 個 / id 重複 /
  正答 0 が pass) の unit test 全 green。 `pnpm test` / `pnpm build` pass。
  review Critical 0 → `[reviewed]`。

### - [ ] T2: updateCard server action + 単一 card read query

**Files:** Create `lib/cards/get-card-for-edit.ts`,
`app/(app)/app/cards/[id]/_actions/update-card.ts` (+ 各 `.test.ts`)

- **目的**: 編集 page が card を取得し、 編集結果を保存する server 経路を用意する。
- **制約**:
  - `getCardForEdit(userId, cardId)`: owner-scoped SELECT。 `id / examId / title /
    questionText / options / explanationText` + exam `name` を JOIN 取得。 不在 / 他 user
    は `null` (page 側で `notFound()`)。
  - `updateCard(cardId, input: UpdateCardInput)`: `'use server'`、 `getCurrentUser()`
    auth gate (`{ok:false, error:'認証が必要です'}`)、 T1 zod parse → 失敗は
    `{ok:false, error}`、 owner-scoped `UPDATE cards SET ... WHERE id=? AND user_id=?`。
  - `correct_answer_ids` は `options.filter(o=>o.isCorrect).map(o=>o.id)` で再生成して
    保存 (spec §2.5.2 デノーマ)。 `options` は DB の `CardOption` (snake_case
    `is_correct`) 形へ変換。 0 行 update は `{ok:false, error:'カードが見つかりません'}`。
    transaction 不要 (単一 UPDATE)。
  - 成功時 `revalidatePath(\`/app/cards/${cardId}\`)` +
    `revalidatePath(\`/app/exams/${examId}\`)`、 戻り値 `ActionResult<void>`。
    `deleteExam` pattern 踏襲。
- **完了条件**: test (正常系 = UPDATE + correct_answer_ids 再生成 / 認証なし /
  他 user の cardId = 0 行 / zod 不正入力) 全 green、 `getDb` mock。
  `pnpm test` / `pnpm build` pass。 review Critical 0 → `[reviewed]`。

### - [ ] T3: /app/cards/[id] page + 編集 Client Component + exam 詳細の編集 link

**Files:** Create `app/(app)/app/cards/[id]/page.tsx`,
`app/(app)/app/cards/[id]/_components/card-editor.tsx` (+ `.test.tsx`)。
Modify `app/(app)/app/exams/[id]/page.tsx`

- **目的**: card 編集 UI を提供し、 exam 詳細から到達経路を張る。
- **制約**:
  - `page.tsx` (Server Component): `getCurrentUser()` → `getCardForEdit` → 不在
    `notFound()`。 breadcrumb「ダッシュボード > 試験一覧 > {exam名} > {card title}」、
    戻る link = `/app/exams/{examId}`。 `<CardEditor>` に初期値を渡す。
  - `card-editor.tsx` (Client Component): title=`<Input>` / questionText・
    explanationText=`<Textarea>` / 各 option 行 = text `<Textarea>` + explanation
    `<Textarea>` + 正答 checkbox + 行削除 + 「選択肢を追加」。 並び替えは上下 button
    (drag は v1.x)。 **正答 UI = pattern A**: 各 option 行に独立 checkbox を 1 つ置く
    のみ。 mode 切替 button / 正答数指定 UI は持たず、 check 数で単一 (1) / 複数 (2+) /
    正答 0 が自動的に決まる (UI 表示は check 数で morph しない)。 内部 state は boolean
    配列固定。 checkbox は native `<input type=checkbox>` か `shadcn add checkbox`
    (radix-ui 統合 package 経由、 新規依存なし) — import 可否を T3 着手時に確認。
    新規 option の id は card 内非衝突で採番 (既存が英字のみ→次英字 / 数字のみ→次数字 /
    それ以外→`opt-<n>`)。
  - 保存: 「保存」 button 明示 click のみ (auto-save 不採用)。 `useTransition` で
    `updateCard` 呼出、 成功は inline message・失敗は `result.error` 表示。 正答数 0 の
    ときは保存前に inline warning (block しない)。
  - dirty guard: 初期値と現 state 比較で dirty 判定。 dirty 時 `beforeunload` で browser
    unload を警告。 自前 breadcrumb / 戻る link click は dirty なら `confirm()` で
    in-app 離脱も guard。
  - exam 詳細 page: 各 card 行に `/app/cards/{card.id}` への「編集」 `<Link>` 追加
    (一覧側の削除 button は S2.0b、 本 sprint では追加しない)。
- **完了条件**: test (初期描画 / option 追加・削除・上下移動 / 正答 checkbox toggle /
  正答 0 で warning 表示 / 保存成功・失敗 / dirty 警告) 全 green。 Chrome DevTools
  モバイルビューで崩れない。 `pnpm test` / `pnpm build` pass。 review Critical 0 →
  `[reviewed]`。

### - [ ] T4: deleteCard server action + 削除 button

**Files:** Create `app/(app)/app/cards/[id]/_actions/delete-card.ts`,
`app/(app)/app/cards/[id]/_components/delete-card-button.tsx` (+ 各 `.test.ts(x)`)。
Modify `app/(app)/app/cards/[id]/page.tsx`

- **目的**: card 単体の物理削除経路と UI を提供する。
- **制約**:
  - `deleteCard(cardId)`: `'use server'`、 auth gate、 削除前に `examId` を owner-scoped
    SELECT で取得 (redirect 先用、 不在 / 他 user は `{ok:false,
    error:'カードが見つかりません'}`)、 owner-scoped 単一文 `DELETE FROM cards WHERE
    id=? AND user_id=?`。 `reviews` は FK CASCADE 連動削除 (アプリ側で個別 DELETE しない)。
    成功時 `revalidatePath(\`/app/exams/${examId}\`)`、 戻り値 `ActionResult<{examId}>`。
    `deleteExam` pattern 踏襲。
  - `delete-card-button.tsx`: `delete-exam-button.tsx` の 2 段 confirm + `useTransition`
    phase machine を踏襲。 自前 DB DELETE のみのため `useReverification` 不要
    (delete-exam-button と同根拠)。 成功後 `router.push(\`/app/exams/${examId}\`)`。
  - page header に削除 button を配置。 新規依存なし。
- **完了条件**: test (削除成功で examId 返却 / 認証なし / 他 user = 0 行・examId 取得
  不可 / confirm 2 段 UI) 全 green。 `pnpm test` / `pnpm build` pass。 review Critical 0。
  **削除を伴う変更 → 裏取り**: commit は tag 無しで止め、 OT staging smoke 後に
  `[reviewed]` を amend。

### - [ ] T5: tech-spec 更新 (closure)

**Files:** Modify `docs/02-tech-spec.md`

- **目的**: 実装に合わせ spec を更新 (S1.9.5 §6 更新と同パターン。 役割境界: 設計書
  更新は本タスクのみで行う)。
- **制約**: §3 Authenticated Routes の `/cards/[id]` を「カード詳細編集 page
  (title / 問題文 / 選択肢 / 正答 / 解説 編集 + card 単体削除)」 と明記。 §3 Server
  Actions の `updateCard` / `deleteCard` シグネチャを実装確定形へ更新、 `bulkUpdateCards`
  (`action='setCustomProp'` 含む) は S2.0b で tag schema 移行と同時に再定義予定と注記。
  §2.5.2 バリデーション「correct_answer_ids 最低 1 個」 に、 編集 UI は正答 0 を warning
  付きで保存許可する旨を注記。 実装ロジックは変更しない。
- **完了条件**: §3 / §2.5.2 が実装と一致。 `pnpm build` pass。 docs commit (review・tag 不要)。

### - [ ] T6: S2.0 sprint session log

**Files:** Create `docs/superpowers/sessions/2026-05-22-s2-0-card-editor-page.md`

- **目的**: 実装結果・review 結果・裏取り結果を記録。
- **制約**: OT 出力規律準拠。 各 feat task の review 結果要約 (Critical / Important /
  Minor 件数) と T4 の staging smoke 結果を含める。
- **完了条件**: session log commit (docs)。 sprint 完了を OT に報告。

### - [ ] T7: 試験詳細 page の全情報展開表示 (staging smoke 中の OT 追加)

**Files:** Modify `lib/exams/list.ts`, `lib/exams/list.owner-isolation.test.ts`,
`app/(app)/app/exams/[id]/page.tsx`

- **目的**: OCR 投入 card の状態 (問題文全文 / 全選択肢 + 正答 + 各選択肢解説 /
  card 全体解説) を試験詳細 page で一目把握できるようにする。 現状 snippet で
  切れ、 解説有無の確認に DB 直見が必要な問題を解消。
- **制約**: read-only、 server action 追加なし。 owner-scoped query 維持。
  `getCardsForExam` を rich 型 `ExamDetailCard` (`questionText` 全文 / `options` /
  `explanationText`) を返すよう変更する — 唯一の caller が当 page のため影響は
  局所。 `getCardsForSourceDocument` / `CardListEntry` (upload result 用) は不変。
  常時展開表示 (折りたたみなし)、 mobile 崩れなし。 編集 link は維持、 削除 button は
  追加しない (S2.0b)。 新規依存・schema 変更なし。
- **完了条件**: `/app/exams/[id]` で全 card の全情報が見える。 `getCardsForExam`
  の owner-isolation test を rich 形へ更新。 `pnpm test` / `pnpm build` pass。
  review Critical 0。 read のみ (削除/外部副作用なし) → review pass で即 `[reviewed]`。

### - [ ] T8: OCR debug log (env gate 付き、 staging smoke 中の OT 追加)

**Files:** Modify `lib/ai/clients/gemini.ts`, `lib/ai/clients/gemini.test.ts`
(新規), `.env.example`

- **目的**: OCR 抽出結果調査のため Gemini raw response を staging で log 可視化。
  事前調査 `docs/superpowers/sessions/2026-05-22-ocr-response-logging-trace.md` 準拠。
- **制約**: `callGemini` の `res.text` 取得直後、 `OCR_DEBUG_LOG==='1'` のときのみ
  `logger.info({event:'ocr.gemini.response', model, textPreview, textLength})`。
  `textPreview` は先頭 50000 字 truncate (Vercel log 行上限対策)。 env 未設定
  (本番) は no-op。 `.env.example` に staging 専用の注記付きで追記。
- **完了条件**: gate off で挙動不変・gate on で log する単体 test。 `pnpm test` /
  `pnpm build` pass。 review Critical 0。 副作用なし → review pass で即 `[reviewed]`。

### - [ ] T9: 選択肢 ID 表示 + 正解 summary (staging smoke 中の OT 追加)

**Files:** Modify `app/(app)/app/exams/[id]/page.tsx`,
`app/(app)/app/cards/[id]/_components/card-editor.tsx` (+ `.test.tsx`)

- **目的**: 選択肢の識別子と正解が一目で分かるようにする。
- **制約**: read 表示の追加のみ、 server action / schema 変更なし。 試験詳細 page で
  各選択肢 text に option ID prefix + 解説直前に「正解」 summary。 card 編集 page で
  各選択肢に option ID label + 解説直前に「現在の正解」 リアルタイム summary
  (client state ベース)。 正答 0 は「未設定」 表示。 新規依存・新規 file なし。
- **完了条件**: 両 page で ID + summary 表示。 `pnpm test` / `pnpm build` pass。
  review Critical 0。 read のみ → review pass で即 `[reviewed]`。

---

## Self-review

- **spec coverage**: kickoff §1 → T3 (page) / §2 → T3 (編集 UI) / §3 → T2 (updateCard) /
  §4 → T1 (validation) / §5 → T4 (deleteCard) / §6 → T3 (編集 link) / §7 → 実施せず
  (下記 ①) / §tech-spec → T5。 staging smoke 中の OT 追加 → T7 (試験詳細の全情報表示) /
  T8 (OCR debug log) / T9 (選択肢 ID + 正解 summary)。
- **再精査での改訂点**: ① kickoff §7 (AppPath に `/app/cards/[id]` 追加) は**実施しない**
  — `AppPath` / `revalidateAppPath` (`app/(app)/app/_actions/revalidate.ts`) は header
  nav の `<Link onClick>` client cache-busting 専用で dynamic route を literal にできず、
  card page は nav にも無い。 server action 側の `revalidatePath` (T2 / T4) で cache
  無効化は足りる。 ② 単一 card read query は `lib/exams/list.ts` (exam list helper) では
  なく card domain の新規 `lib/cards/get-card-for-edit.ts` に分離 (S2.0b の card 系
  query 追加先も兼ねる)。 ③ dirty guard は `beforeunload` のみだと App Router の in-app
  nav を捕捉できないため、 自前 breadcrumb / 戻る link に `confirm()` guard を併設。
- **type 一貫性**: `UpdateCardInput` (T1 定義 → T2 / T3 で使用) / `ActionResult<void>`
  (T2) / `ActionResult<{examId}>` (T4) / DB `CardOption` snake_case 変換 (T2)。
- **placeholder**: なし。

**最終行数: 260 行 / 上限 250 超過** (2026-05-22 改訂: memo / 画像対応を scope 外明記、
正答 UI pattern A 確定、 staging smoke 中に T7 / T8 / T9 を OT 追加。 上限 250 を 11 行
超過するが 300 行 STOP 閾値内、 超過理由は smoke 由来の task 3 件追加で抽象度の問題では
ないため分割不要と判断。 schema 変更ゼロ・新規依存ゼロは不変)。
