# 試験手動作成 / カード手動作成・削除 / tombstone テーブル — 実装前棚卸し

- 日時: 2026-05-29
- 種別: investigation / session log (**実装変更・commit なし**、 成果物は本 doc のみ)
- 対象 branch: `develop`
- 目的: 割り込み 3 機能 (項目2=試験手動作成 / 項目3=カード手動作成・削除 / exam・card 統合 tombstone 新設) の実装着手前に、 既存経路・schema・制限を実コード行で確定し、 「実装に必要な変更点」 と 「spec で決めるべき残論点」 を切り分ける (決定はしない)
- 手段: grep + 実コード read (推測排除)
- 確定済み前提 (kickoff): 試験は名前のみ最小作成・manual は source_documents 行なし・catalog 表記は実態(unlimited)に修正・試験にタグなし / card 新規=空 card 追加→inline 編集(S2.0b 流用)・削除 confirm あり undo なし・sort_key 末尾連番 / 物理削除+FK cascade 維持・tombstone は記録側のみ実装(読む側=増分 pull は後続)

---

## 結論サマリ

| 軸 | 結論 |
| --- | --- |
| A 試験削除現状 | `delete-exam.ts` は **db.transaction なしの単一文 DELETE + FK cascade 依存**。 tombstone 化には tx 導入が要る (構造的に可能) |
| B 配下 card 列挙 | 物理削除前に `tx.select(cards.id).where(examId, userId)` で列挙可能。 同 tx で「列挙→tombstone INSERT→DELETE」 成立 |
| C カード削除現状 | 単体 `delete(cards)` / `createCard` は **コードに存在しない** (cascade のみ)。 新規 server action を `exams/[id]/_actions/` に配置が自然 |
| D 試験作成現状 | OCR の exam INSERT は `process.ts:332-336` = **`{userId, name}` のみ**。 manual も同最小 INSERT + source_documents 行なしで成立 |
| E 一覧バッジ | source_documents 行ゼロ exam は **破綻なく描画**: `getActiveExamsWithCardCount` は exams 単体 SELECT (JOIN なし)、 `ExamStatusBadge` は entry なしで `return null` |
| F plan 制限 | exam 数・card 数の上限は **コードに存在しない** (`plan-limits.ts` は ocrPagesPerMonth のみ)。 「1 試験まで」 は `plan-catalog.ts:58` の表示のみ (未 enforce) |
| G tombstone schema | `cardMutations` 規約踏襲。 entity_id は物理削除後のため **FK 不可** (plain uuid)。 単一テーブル案を §軸G に提示 |
| H 既存 pattern | tx 化は問題2/3 pattern・FK cascade・冪等性を壊さない。 serializeDbError 適用余地あり |

---

## 軸A. 試験削除の現状経路

- `app/(app)/app/exams/_actions/delete-exam.ts`:
  - `deleteExam(examId)` (`:22`) → `_deleteExam` (`:35`) を try/finally で包み、 finally で `revalidatePath('/app/upload')` (`:31`、 cross-page dropdown 依存のため残置)。
  - `_deleteExam`: `getCurrentUser` → **`db.delete(exams).where(and(eq(exams.id, examId), eq(exams.userId, user.id)))`** (`:44-46`)、 単一文。 **db.transaction なし**。
  - FK CASCADE (source_documents.exam_id / cards.exam_id / reviews.card_id = ON DELETE CASCADE) で配下を DB が連動削除 (コメント `:14-16`)。 アプリ側で個別 DELETE しない。
  - 不在 / 他 user は WHERE 0 行マッチで silent success (idempotent、 `:42-43`)。
- → **tombstone 化の含意**: 「配下 card id 取得 → tombstone INSERT → 物理 DELETE」 を原子的にするには **`db.transaction(async (tx) => …)` でラップが必須**。 tx API は repo 内で確立 (`process.ts:252,530`、 `app/api/review-events/bulk/route.ts:132`)。

## 軸B. exam 削除で消える配下 card の列挙

- cards は `examId` notNull FK (cascade)。 物理削除前に同 tx で列挙可能:
  - `tx.select({ id: cards.id }).from(cards).where(and(eq(cards.examId, examId), eq(cards.userId, user.id)))`
- → 同一 tx 内で **(1) exam owner 確認 + 配下 card id 列挙 → (2) tombstone INSERT (exam 1 + card N、 網羅方式) → (3) `tx.delete(exams)` で cascade 物理削除** が成立。
- 冪等性の注意: exam 不在時 (再削除 / 他 user) は tombstone を入れてはならない。 順序は「exam 存在確認 (0 行なら ok 即 return、 tombstone なし) → 列挙 → tombstone INSERT → DELETE」。 tombstone INSERT は `onConflictDoNothing` で再削除レースも吸収 (§軸G の UNIQUE 前提)。

## 軸C. カード削除の現状 + 新規配置先

- **単体カード削除経路は存在しない**: grep で `delete(cards)` は `process.ts` の bulk INSERT 周辺含めゼロ (cascade 経由のみ)。 `createCard` / `deleteCard` も不在。 schema コメント `:224`「単体 card 作成 (createCard) は未実装、 実装時に +1 を同 tx で行うこと」 が裏付け。
- 既存の card 単位 server action は `app/(app)/app/exams/[id]/_actions/update-card-field.ts` (`'use server'` + `getCurrentUser` + `getDb` + owner-scoped UPDATE + `ActionResult`、 `:1-10`)。
- → **新規 `delete-card.ts` / `create-card.ts` を同 `exams/[id]/_actions/` に配置**するのが構造上自然 (update-card-field と同じ contract)。

## 軸D. 試験作成の現状 + manual 最小 INSERT

- OCR の exam INSERT: `process.ts:332-336` (mode='new' 分岐、 advisory-lock tx 内):
  ```
  tx.insert(exams).values({ userId: user.id, name: resolvedExamName }).returning({ id: exams.id })
  ```
  - 埋める列は **userId + name のみ**。 他は default: cardCount=0 / contentVersion=0 / questionNoFormat=null / archivedAt=null / created・updatedAt=now (schema `:208-`)。
  - その後 `sourceDocuments` INSERT (`:354-366`) は OCR 固有。 manual では作らない。
- cardCount 更新: cards bulk INSERT と同 tx で `cardCount: sql\`${exams.cardCount} + ${cardRows.length}\`` (`process.ts:532,538`)。 → **manual card 作成は同様に +1 を同 tx で**。
- → **manual 試験作成の最小 INSERT = `{ userId, name }`** (source_documents 行なし)。 名前のみ最小作成 (前提) と完全整合。

## 軸E. source_documents 行ゼロ exam の一覧描画

- `app/(app)/app/exams/page.tsx`:
  - `getActiveExamsWithCardCount(userId)` + `getExamStatusMap(userId)` を並列取得 (`:42-45`)。
  - `getActiveExamsWithCardCount` (`lib/exams/list.ts`) は **exams 単体 SELECT** (`from(exams)`、 `where(userId, archivedAt IS NULL)`、 `cardCount: exams.cardCount`)。 **source_documents を JOIN しない** (`:12-13`)。
  - `getExamStatusMap` は source_documents の DISTINCT ON から `Map<examId, 'processing'|'failed'>` を返す (`source-doc-status.ts:108-127`)。 source_documents 行のない exam は **entry なし**。 失敗時も空 Map (best-effort)。
  - `ExamStatusBadge` (`exam-status-live.tsx:134`): `status = statuses[examId]` (`:136`)、 **entry なし → `return null`** (`:152`)。 page コメント `:66-67`「completed exam は context に entry なし = 非表示」 が明示。
- → **manual exam (card 0・source_doc なし) は「name + カード 0 件 + バッジ非表示」 で破綻なく描画**。 一覧側の改修は不要。 (空状態 CTA は現状 `/app/upload` のみ `:50-52` → 項目2 で「手動作成」 導線追加が要る)

## 軸F. plan 制限の現状

- `lib/auth/plan-limits.ts`: `PLAN_LIMITS = { free:{ocrPagesPerMonth:30}, standard:{300}, pro:{null} }`。 **exam 数・card 数の上限フィールドは無い**。
- 「1 試験まで」 表示箇所:
  - `lib/plan-catalog.ts:58` `FREE_PLAN.features = ['月 30 問まで AI OCR 取込', '1 試験まで', 'FSRS 基本機能']` (単一 source)。
  - 描画: `components/pricing/pricing-table.tsx:156` (pricing) + `app/(app)/app/upgrade/upgrade-plans.tsx:145` (upgrade) が `entry.features.map`。
  - `docs/02-tech-spec.md:1051` の表にも記載。
- → 「1 試験まで」 は **表示のみで未 enforce** (実コードに exam-count gate なし)。 catalog を実態(unlimited)に合わせる修正点 = `plan-catalog.ts:58` の features 配列文字列 (UI 2 箇所は自動追従) + tech-spec doc 表。

## 軸G. tombstone テーブル schema 案

`cardMutations` (`schema.ts:601-623`) の規約踏襲: `id uuid PK defaultRandom` / FK は `onDelete:'cascade'` / `timestamptz notNull` / `createdAt defaultNow` / index 名 `<table>_<x>_idx`。 ただし **entity_id は対象を物理削除した後に残すため FK を張れない** (plain uuid)。

提案 (単一テーブル、 exam・card 統合):

```
export const tombstones = pgTable('tombstones', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  entityType: text('entity_type').$type<'exam' | 'card'>().notNull(),
  entityId: uuid('entity_id').notNull(),          // FK 不可 (対象は物理削除済)
  deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull(),   // 論理削除時刻 (= 削除実行時の now)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), // server 受領時刻
}, (t) => [
  // 増分 pull (後続): user の since カーソル走査用
  index('tombstones_user_deleted_idx').on(t.userId, t.deletedAt),
  // 再削除レースの冪等化 (onConflictDoNothing 用)
  uniqueIndex('tombstones_entity_uq').on(t.entityType, t.entityId),
])
```

論点メモ:
- `deletedAt` を増分 pull カーソルにする (createdAt と近いが、 削除の論理時刻を明示)。 どちらをカーソルにするかは増分 pull 実装時 (後続) に確定。
- `userId` FK cascade: user 削除で tombstone も消える (整合)。 entity_id は FK なし = dangling 前提 (設計通り)。
- migration: 最新は `0013_purple_jack_power.sql` → **新規 `0014_*` を drizzle generate** で採番。
- `entity_type` は enum 列でなく text+$type (cardMutations の `mode` 等と同流儀)。

## 軸H. 既存 pattern / 冪等性への影響

- **tx 化 (delete-exam)**: 現単一文 DELETE → tx 化は加算的。 FK cascade はそのまま (tx 内 DELETE でも cascade 動作)。 問題2/3 (in-flight guard / bulk SQL / review-events) は別領域で無関係。
- **冪等性**: tombstone UNIQUE(entity_type, entity_id) + `onConflictDoNothing` で再削除を安全化 (delete-exam の既存 idempotent 挙動を維持)。
- **serializeDbError 適用余地**: delete-exam / delete-card / create-card の tx catch で `serializeDbError` (`lib/db/serialize-db-error.ts`) を使えば、 tombstone INSERT / cascade DELETE の pg native error (FK 違反等) を可視化できる (問題3 で確立した観測手法の流用)。 必須ではないが新規 tx 経路の観測強化として推奨。
- timestamptz は Drizzle chainable builder (`.values({...})`) 経由なら #5789 (raw sql template の Date embed) に当たらない。 tombstone INSERT は chainable で書けるため安全。

---

## まとめ: 3 点それぞれの「変更点」 と「残論点」

### 項目2: 試験手動作成

**実装に必要な変更点**:
- 新規 server action (例 `exams/_actions/create-exam.ts`): `getCurrentUser` → name の zod validate → `db.insert(exams).values({ userId, name }).returning({ id })` → 作成 exam id 返却。 source_documents 行は作らない。
- `/app/exams` に「手動作成」 導線 (名前入力 → 作成 → 詳細へ遷移)。 空状態 CTA (`page.tsx:50-52`) にも追加。
- catalog 修正: `plan-catalog.ts:58` features の「1 試験まで」 を実態(unlimited)へ + `docs/02-tech-spec.md:1051`。

**spec で決めるべき残論点**:
- name validation (最大長 / 空白のみ拒否 / 同名重複の可否)。
- 作成 UI の形態 (一覧上の inline フォーム / モーダル / 別ページ) と作成後の遷移先 (詳細画面 or 一覧)。
- questionNoFormat 初期値 (null のままで良いか、 manual で選ばせるか)。
- enforce 方針の最終確認 (前提=unlimited だが、 将来 card 数上限を入れる余地を schema/catalog にどう残すか)。

### 項目3: カード手動作成・削除

**実装に必要な変更点**:
- 新規 `exams/[id]/_actions/create-card.ts`: 同 tx で `insert(cards)` (最小 notNull 列) + `cardCount += 1` + sort_key 末尾連番。 作成後は既存 inline 編集 (update-card-field) で内容を埋める。
- 新規 `exams/[id]/_actions/delete-card.ts`: 同 tx で tombstone INSERT(card) + `delete(cards)` (owner-scoped) + `cardCount -= 1`。 confirm dialog の UI (delete-card-button)、 undo なし。
- `InlineCardList` (`exams/[id]/_components/`) に「空 card 追加」 ボタン + 各 card の削除導線。

**spec で決めるべき残論点**:
- **空 card の初期値 (最重要)**: cards の notNull 列 = title / questionText / options / correctAnswerIds。 optionsSchema は `min(1)`。 「空 card」 の初期 title・questionText (空文字許容か '(無題)' か)、 初期 options (空 1 件 `[{id:'1',text:'',is_correct:false}]` か)、 correctAnswerIds (空配列か) をどう置くか。 inline 編集の zod (questionText 非空 refine 等) と作成時 validation の整合。
- **sort_key 末尾連番の算出**: sort_key は **text 型 (nullable)**。 「既存 max + 1」 を text でどう計算するか (数値 parse して +1 / questionNoFormat 準拠 / 単純連番)。 既存 OCR card の sort_key 形式との整合。
- 削除の confirm UI 文言 / 最後の 1 枚を消せるか (試験を空にできるか)。
- 空 card 追加直後の inline 編集 mount (autoEdit) を S2.0b の `autoEditOnMount` (inline-option-row) と揃えるか。

### tombstone テーブル

**実装に必要な変更点**:
- schema 追加 (§軸G) + migration `0014_*` (drizzle generate)。
- delete-exam を tx 化し、 配下 card 全件 + exam を tombstone 記録 (網羅方式、 onConflictDoNothing)。
- delete-card で card を tombstone 記録。
- **記録側のみ**。 読む側 (増分 pull / `/api/*/pull?since=` への tombstone 反映) は後続スプリント。

**spec で決めるべき残論点**:
- カーソル列 (deletedAt vs createdAt) — 増分 pull 実装時に確定で良いが、 index を先に張る前提。
- tombstone の保持期間 / GC (無限増加。 後続で cron 掃除 or 一定期間で物理削除する設計を別途。 今回は記録のみで保留)。
- exam 削除時の網羅記録の規模 (1 試験 100-500 card 想定 → tombstone INSERT が bulk になる。 1 文 multi-row insert で十分か、 chunk するか)。
- 単体テーブル名の最終確定 (`tombstones` / `deletion_tombstones`)。
