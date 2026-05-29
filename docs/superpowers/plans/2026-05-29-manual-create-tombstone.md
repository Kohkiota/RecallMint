# 試験/カード手動作成 + tombstone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` で task 単位に実装する。 各 task の TDD step は checkbox (`- [ ]`)。
> **規律 (CLAUDE.md「Plan の書き方」)**: 本 plan は**設計判断の記録**であり生コードを埋めない。 具体の contract・schema・プレースホルダ値・採番ロジック・ASCII は確定 spec **`docs/superpowers/specs/2026-05-29-manual-create-tombstone-design.md` (commit 3a90b28)** を唯一の出典とし、 各 task から節番号で参照する。 Generator が TDD で実コードを書く。

**Goal:** OCR レスで試験・カードを作れる手動作成経路と、 削除を記録する exam・card 統合 tombstone テーブルを追加する (記録側のみ)。

**Architecture:** server action + Drizzle (Postgres) + Next.js 15 App Router。 既存 inline 編集 (S2.0b) と FK cascade を流用。 削除は物理削除 + tombstone を同一 transaction に記録。 出題側・増分 pull は変更しない (spec §9)。

**Tech Stack:** TypeScript strict / Drizzle ORM / Vitest (+ fake-indexeddb は client のみ) / zod。

---

## 全体ルール (各 task 共通、 冒頭一度のみ — 各 task から参照)

- **TDD 厳守**: test 先行 → `pnpm vitest run <path>` で fail 確認 → 最小実装 → green → commit。 順序を崩さない。
- **pure 関数を厚く**: `nextCardSortKey` / `nextCardTitle` / 空 card placeholder builder は分岐網羅の単体テスト (`lib/cards/next-option-id.test.ts` 同様)。
- **server action の DB test**: `app/(app)/app/exams/[id]/_actions/update-card-field.test.ts` のパターン踏襲。 実 AI/Stripe/Clerk 非依存。
- **観測強化を後付けにしない**: 新規 tx 経路 (createCard / deleteCard / deleteExam tx 化) は **最初の commit から** catch に `serializeDbError` (`lib/db/serialize-db-error.ts`) を同梱 (spec §7)。
- **tombstone INSERT は chainable `.values([...])`** で書く (raw sql template の Date embed = Drizzle #5789 を回避、 spec §7)。
- **cardCount は同 tx 更新が整合保証** (spec §3.6)。 create/delete の各 action test に「更新後 `cardCount === COUNT(cards WHERE exam_id)`」 のアサートを含める (spec §6)。
- **完了条件 (全 task 共通)**: 当該 test green + `pnpm test` 全 green + `pnpm build` clean + `requesting-code-review` 通過 (Critical 0) + commit に `[reviewed]` タグ。 削除系も自前 DB のみ = 外部副作用なしのため review pass で `[reviewed]` 付与可 (CLAUDE.md)。 feat(_) commit 直前に review ログ 4 点を chat 明示。
- **spec 不変**: 確定方針は変更しない。 解釈揺れが出たら STOP して OT 相談。

**依存順 (spec §8)**: Task1 → (Task2 ∥ Task3) → Task4 → (Task5 ∥ Task6)。

---

## Task 1: tombstones schema + migration 0014

**目的**: exam・card 統合 tombstone テーブルを新設する (記録側の器、 後続の delete 系 task の前提)。

**Files:**
- Modify: `lib/db/schema.ts` (末尾の type export 群の前に `tombstones` pgTable 追記 + `Tombstone`/`NewTombstone` type export)
- Create: `drizzle/migrations/0014_*.sql` (`pnpm db:generate` が採番・生成、 手書きしない)

**制約**: spec **§1** の schema 定義に厳密準拠 (列・型・`$type<'exam'|'card'>`・`entityId` は FK 張らない plain uuid・index `tombstones_user_deleted_idx`・UNIQUE `tombstones_entity_uq`)。 `cardMutations` (`schema.ts:601-623`) の規約に揃える。

**Steps:**
- [ ] schema に `tombstones` を追記 (spec §1) + type export。
- [ ] `pnpm db:generate` で `0014_*.sql` を生成し、 内容が spec §1 (CREATE TABLE + UNIQUE + index + userId FK cascade、 entityId に FK なし) と一致することを目視確認。
- [ ] `pnpm build` で型・生成物が通ることを確認 (schema 単体の vitest は設けない — UNIQUE/制約の挙動は Task5/6 の action test で実 tx 経由で検証する)。
- [ ] commit (`feat(db): tombstones table + migration 0014`)。

**完了条件**: 全体ルール準拠 + migration 生成済 + build clean。 (schema のみで logic 変更なしのため review は軽量で可、 ただし新 migration を含むため `requesting-code-review` は通す。)

---

## Task 2: pure 関数 (sort_key / title 採番 + 空 card placeholder)

**目的**: 手動 card 作成で使う採番・プレースホルダ生成を、 副作用なしの純粋関数として確立する。

**Files:**
- Create: `lib/cards/next-card-sort-key.ts` + `.test.ts`
- Create: `lib/cards/next-card-title.ts` + `.test.ts`
- Create: `lib/cards/empty-card.ts` (notNull 列のプレースホルダ値を組み立てる builder) + `.test.ts`

**制約**: `nextCardSortKey` は spec **§3.1** の三分岐 (空→'1' / 全 numeric→max+1 / 混在→`length+1` fallback、 `nextOptionId` 流用、 zero-pad は MVP 非 pad)。 `nextCardTitle` は spec §3.1 (`新規カード N`、 非空)。 `empty-card` builder は spec **§3.2** の値 (title/questionText/options[min1, text 非空]/correctAnswerIds=[]) を返し、 **生成値が `optionsSchema`/`titleSchema`/`questionTextSchema` (`lib/validation/card.ts` / `update-card-field.ts`) を通る**こと。

**Steps:**
- [ ] `nextCardSortKey` の failing test (空/numeric/zero-pad/混在/null 除外の各 case) → fail 確認 → 最小実装 → green。
- [ ] `nextCardTitle` の failing test (count→非空連番) → fail → 実装 → green。
- [ ] `empty-card` builder の failing test (返り値が各 zod schema を **parse 成功**することを assert) → fail → 実装 → green。
- [ ] commit (`feat(cards): manual card 用 sort_key/title 採番 + 空 card placeholder`)。

**完了条件**: 全体ルール準拠 + 3 pure 関数の分岐網羅 test green。

---

## Task 3: createExam action + 手動作成 UI + catalog 修正

**目的**: 名前のみの試験手動作成経路と導線を作り、 catalog の旧表記を実態に合わせる。 (Task2 と並行可。)

**Files:**
- Create: `app/(app)/app/exams/_actions/create-exam.ts` + `.test.ts`
- Create: `app/(app)/app/exams/_components/create-exam-form.tsx`
- Modify: `app/(app)/app/exams/page.tsx` (一覧上部の手動作成導線 + 空状態 CTA 2 択、 spec §2.2 ASCII)
- Modify: `lib/plan-catalog.ts:58` (features 文字列、 spec §2.3 確定値) + `docs/02-tech-spec.md:1051` (表行)

**制約**: action contract は spec **§2.1** (`createExam(name): ActionResult<{examId}>`、 zod trim/min1/max200/重複可、 `{userId,name}` のみ INSERT、 source_documents 行なし、 owner-scope、 `finally revalidatePath('/app/upload')`)。 catalog は spec **§2.3** 確定値 `試験・カードの作成は無制限`。 enforce は入れない。

**Steps:**
- [ ] `create-exam.test.ts` failing test (空白のみ→error / >200→error / valid→insert+examId / owner user.id 固定) → fail 確認 → 最小実装 (spec §2.1) → green。
- [ ] catalog 文字列 (`plan-catalog.ts:58`) + tech-spec 表 (`02-tech-spec.md:1051`) を確定値に修正 (features.map で UI 2 箇所自動追従、 spec §2.3)。
- [ ] `create-exam-form.tsx` + 一覧導線/空状態 CTA を実装 (UI は spec §2.2、 作成成功で `/app/exams/[examId]` へ `router.push`)。 DevTools MCP で smoke (一覧→作成→詳細遷移)。
- [ ] `pnpm build` + `pnpm test` green 確認。
- [ ] review → commit (`feat(exams): 試験の手動作成 + catalog 表記修正 [reviewed]`)。

**完了条件**: 全体ルール準拠 + action test green + 手動作成→詳細遷移が DevTools smoke で確認。

---

## Task 4: createCard action + InlineCardList 追加ボタン + autoEdit

**目的**: 試験編集画面で空 card を追加し、 追加直後に問題文セルが編集モードで開く。 (Task1,2 に依存。)

**Files:**
- Create: `app/(app)/app/exams/[id]/_actions/create-card.ts` + `.test.ts`
- Modify: `app/(app)/app/exams/[id]/_components/inline-text-field.tsx` (`autoEditOnMount?` を新設、 `InlineOptionCell` の one-shot initializer `inline-option-row.tsx:530,555` を踏襲)
- Modify: `app/(app)/app/exams/[id]/_components/inline-card-list.tsx` (「＋ カードを追加」 ボタン + `newCardId` state + 新 card の question_text セルへ autoEdit)

**制約**: action contract は spec **§3.3** (`createCard(examId): ActionResult<{cardId}>`、 **同 tx** で exam owner 確認→placeholder INSERT (Task2 の `empty-card` + `nextCardSortKey`/`nextCardTitle`)→`cardCount += 1`、 catch に `serializeDbError`)。 autoEdit セル = **question_text** (spec **§3.5** の理由付き明示)。 出題除外フィルタは作らない (spec §3.2)。

**Steps:**
- [ ] `create-card.test.ts` failing test (placeholder 挿入が schema を満たす / `cardCount += 1` が**同 tx** / sortKey 末尾連番 / exam 不在→error / owner-scope / **更新後 cardCount === COUNT 整合**) → fail → 実装 (spec §3.3、 serializeDbError 同梱) → green。
- [ ] `inline-text-field.tsx` に `autoEditOnMount?` を追加する failing test (mount 時 editing=true、 one-shot) → fail → 実装 → green。
- [ ] `inline-card-list.tsx` に追加ボタン + `newCardId` 連携を実装 (createCard→cardId→`setNewCardId`→`router.refresh`→該当 card の question_text が autoEdit)。 DevTools MCP で smoke。
- [ ] `pnpm build` + `pnpm test` green。
- [ ] review → commit (`feat(exams): カード手動作成 (空 card 追加 + autoEdit) [reviewed]`)。

**完了条件**: 全体ルール準拠 + create-card test green (cardCount 整合含む) + 追加→問題文 autoEdit が smoke 確認。

---

## Task 5: deleteCard action + confirm UI

**目的**: 個別カードを confirm 付きで削除し、 tombstone を記録する。 (Task1 に依存。)

**Files:**
- Create: `app/(app)/app/exams/[id]/_actions/delete-card.ts` + `.test.ts`
- Create: `app/(app)/app/exams/[id]/_components/delete-card-button.tsx` (`delete-exam-button.tsx` の 2 段 confirm パターン流用、 undo なし)
- Modify: `app/(app)/app/exams/[id]/_components/inline-card-list.tsx` (各 card に削除導線)

**制約**: action contract は spec **§3.4** (`deleteCard(cardId): ActionResult`、 **同 tx** で card 取得 (不在→idempotent ok)→tombstone INSERT(card) `onConflictDoNothing`→`delete(cards)` owner-scope→`cardCount = GREATEST(-1,0)`、 catch に `serializeDbError`)。 最後の 1 枚も削除可 (試験を空に)。 tombstone は chainable `.values()`。

**Steps:**
- [ ] `delete-card.test.ts` failing test (tombstone(card) INSERT + card DELETE + `cardCount -= 1` が**同 tx** / 不在→idempotent ok / owner-scope / 再削除 onConflictDoNothing / **更新後 cardCount === COUNT 整合** / 最後の 1 枚削除可) → fail → 実装 (spec §3.4、 serializeDbError 同梱) → green。
- [ ] `delete-card-button.tsx` (2 段 confirm) + inline-card-list 削除導線を実装。 DevTools MCP で smoke (削除→confirm→消える、 試験を空にできる)。
- [ ] `pnpm build` + `pnpm test` green。
- [ ] review → commit (`feat(exams): カード削除 + tombstone 記録 [reviewed]`)。

**完了条件**: 全体ルール準拠 + delete-card test green (tombstone/cardCount 整合含む) + confirm 削除が smoke 確認。

---

## Task 6: deleteExam の tx 化 + 配下 card 網羅 tombstone

**目的**: 既存 exam 削除を tx 化し、 exam + 配下 card 全件を tombstone に網羅記録する。 (Task1 に依存。)

**Files:**
- Modify: `app/(app)/app/exams/_actions/delete-exam.ts` (`_deleteExam` を `db.transaction` でラップ、 spec §4)
- Modify: `app/(app)/app/exams/_actions/delete-exam.test.ts` (既存 non-regression + tombstone 検証追加)

**制約**: spec **§4** の順序厳守 (存在・owner 確認 (0 行→tombstone なし idempotent return) → 配下 card id 列挙 (cascade で消える前) → tombstone 網羅 INSERT (exam 1 + card 全件、 chainable multi-row、 `onConflictDoNothing`) → `delete(exams)` で FK cascade)。 `finally revalidatePath('/app/upload')` 維持。 catch に `serializeDbError`。

**Steps:**
- [ ] `delete-exam.test.ts` に failing test 追加 (配下 card 列挙→tombstone(exam+card 網羅) INSERT→cascade delete / 不在→tombstone なし idempotent / 再削除 onConflictDoNothing / 既存 cascade 削除の non-regression) → fail 確認。
- [ ] `_deleteExam` を tx 化実装 (spec §4、 serializeDbError 同梱、 既存 idempotent 挙動と revalidate 維持) → green。
- [ ] `pnpm build` + `pnpm test` 全 green (既存 delete-exam test を壊さない)。
- [ ] review → commit (`feat(exams): exam 削除の tx 化 + 配下 card 網羅 tombstone [reviewed]`)。

**完了条件**: 全体ルール準拠 + tombstone 網羅記録 + 既存 delete-exam non-regression green。

---

## Self-Review (spec coverage)

- spec §1 (tombstones) → Task1。 §2 (試験手動作成 + catalog) → Task3。 §3.1/3.2 (採番・placeholder) → Task2。 §3.3 (createCard) + §3.5 (autoEdit) → Task4。 §3.4 (deleteCard) + §3.5 (confirm) → Task5。 §4 (deleteExam tx 化) → Task6。 §5 (一覧非回帰) → 改修不要のため Task3/4 の smoke で確認。 §6 (test) / §7 (serializeDbError) → 全体ルール + 各 task に内包。 §9 (スコープ外: 読む側/GC/enforce/出題フィルタ) → plan でも未着手で整合。
- placeholder/生コード: なし (CLAUDE.md 準拠、 具体は spec 参照)。
- 依存・命名整合: `empty-card`/`nextCardSortKey`/`nextCardTitle` (Task2) を Task4 が参照、 `tombstones` (Task1) を Task5/6 が参照、 `autoEditOnMount` (Task4) はセル=question_text で一貫。
