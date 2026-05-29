# 試験手動作成 / カード手動作成・削除 / tombstone テーブル — design spec

- 起票日: 2026-05-29
- 種別: design spec (実装前)
- 状態: **OT review 反映済 (2026-05-29)、 確定**。 実装は `writing-plans` で別途 plan 化 (本 spec では実装しない)
- 前段棚卸し (実コード根拠):
  - `docs/superpowers/sessions/2026-05-29-manual-create-tombstone-pre-investigation.md`
  - `docs/superpowers/sessions/2026-05-29-empty-card-option-handling-investigation.md`
- スコープ: 項目2 (試験手動作成) / 項目3 (カード手動作成・削除) / tombstones テーブル新設 (**記録側のみ**)。 増分 pull での tombstone 反映は**後続スプリント = 本 spec のスコープ外**。

---

## 0. 前提 (確定方針、 live コード再確認済)

| 事実 | live 出典 |
| --- | --- |
| exam INSERT は `{userId, name}` のみで成立 | `app/(app)/app/upload/_actions/process.ts:332-336` |
| cards notNull 列 = title / questionText / options / correctAnswerIds | `lib/db/schema.ts:262,264,265,266` |
| cards.due は `defaultNow` (= 作成直後に出題対象) / sortKey は text nullable | `schema.ts:293,263` |
| cardCount は派生キャッシュ、 card 増減と同 tx で更新 | `schema.ts:224` (コメント) / `process.ts:538` |
| delete-exam は単一文 DELETE + FK cascade、 **db.transaction なし** | `delete-exam.ts:44-46` |
| optionSchema text 非空 refine / optionsSchema min(1) / title min(1) / questionText 非空 refine / correct 下限なし | `lib/validation/card.ts:14-27` / `update-card-field.ts:27-59` |
| 出題側に空 card/空選択肢の除外フィルタは**無い** (due 判定のみ) | `lib/cards/get-session-cards.ts:26-34` / `get-dexie-session-cards.ts:30-43` |
| `ExamStatusBadge` は status entry なしで `return null` / 一覧 query は exams 単体 (source_documents JOIN なし) | `exam-status-live.tsx:152` / `lib/exams/list.ts:12-13` |
| `nextOptionId` は**選択肢 id** 採番 (a-z / numeric max+1 / opt-N) | `lib/cards/next-option-id.ts:14-28` |
| card 単位 sort_key の採番ロジックは**未実装** | (前段調査 軸4) |
| `ActionResult<T=void> = {ok:true,data?:T} | {ok:false,error:string}` | `lib/actions/result.ts` |
| confirm UI パターン = 2 段 (idle→confirm→deleting/error) + useTransition + router.refresh | `delete-exam-button.tsx` |
| 最新 migration = `0013_purple_jack_power.sql` → 新規 `0014_*` | `drizzle/migrations/` |

---

## 1. tombstones テーブル (新設)

`cardMutations` (`schema.ts:601-623`) の規約踏襲。 **entity_id は対象を物理削除した後に残すため FK を張れない** (plain uuid)。

```ts
export const tombstones = pgTable(
  'tombstones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').$type<'exam' | 'card'>().notNull(),
    entityId: uuid('entity_id').notNull(), // FK 不可: 対象は物理削除済
    deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('tombstones_user_deleted_idx').on(t.userId, t.deletedAt), // 後続: 増分 pull の since カーソル走査
    uniqueIndex('tombstones_entity_uq').on(t.entityType, t.entityId), // 再削除 idempotency (onConflictDoNothing)
  ],
)
export type Tombstone = typeof tombstones.$inferSelect
export type NewTombstone = typeof tombstones.$inferInsert
```

- `entityType` は enum 列でなく text+`$type` (既存 `mode` 等の流儀)。
- `userId` cascade: user 削除で tombstone も消える。 `entityId` は dangling 前提 (設計通り)。
- migration: `pnpm db:generate` で `0014_*` を新規採番 (手書きしない)。
- **読む側 (増分 pull) は本 spec スコープ外**。 index/UNIQUE は後続の前提として今張る。

---

## 2. 項目2: 試験手動作成

### 2.1 server action `app/(app)/app/exams/_actions/create-exam.ts`

```
createExam(name: string): Promise<ActionResult<{ examId: string }>>
```
- `getCurrentUser()` → null なら `{ok:false, error:'認証が必要です'}`。
- zod: `z.string().trim().min(1,'試験名は必須です').max(200,'試験名は 200 文字以内で入力してください')`。 `.trim()` で**空白のみ拒否**、 **同名重複は許可** (UNIQUE 制約を張らない)。 失敗 → `{ok:false, error: firstIssue}`。
- `db.insert(exams).values({ userId: user.id, name: parsed }).returning({ id: exams.id })`。 **source_documents 行は作らない**。 questionNoFormat は未指定 = null のまま。
- `{ok:true, data:{ examId: inserted[0].id }}`。
- `finally { revalidatePath('/app/upload') }` (delete-exam と同様、 upload の投入先 dropdown が active exam 一覧依存のため)。 `/app/exams` は遷移先が詳細画面のため revalidate 不要 (戻り時の通常 nav で再 fetch)。
- owner-scope: INSERT は user.id 固定。 他 user への混入なし。

### 2.2 UI 導線 (`/app/exams`)

新規 client component `exams/_components/create-exam-form.tsx`: 名前入力 + 作成ボタン → `createExam` → `ok` で `router.push('/app/exams/${examId}')`。

ASCII (一覧上部 + 空状態):
```
┌─ 試験一覧 ─────────────────────────────────┐
│  [＋ 手動で試験を作成]   ← クリックで inline 展開        │
│   ┌─ 展開時 ─────────────────────────────┐ │
│   │ 試験名: [____________________] [作成] [×]  │ │
│   └──────────────────────────────────────┘ │
│  ── 既存試験 ──                                  │
│  ・基本情報試験   カード 12 件 ・…   [詳細] [削除]      │
└────────────────────────────────────────────┘

空状態 (exams.length===0):
  まだ試験がありません。
  [アップロードから始める]   [手動で試験を作成]   ← CTA 2 択に
```

### 2.3 catalog 表記修正 (実態 = unlimited)

- **修正対象 1**: `lib/plan-catalog.ts:58` `FREE_PLAN.features` の文字列 `'1 試験まで'` → **`'試験・カードの作成は無制限'`** に確定 (OT review 確定値)。 UI 2 箇所 (`pricing-table.tsx:156` / `upgrade-plans.tsx:145`) は `features.map` で自動追従するため、 修正は本文字列 1 箇所のみ。
- **修正対象 2**: `docs/02-tech-spec.md:1051` の表行 `| Free | 月 30 問 | 1 試験まで |` の「1 試験まで」 を同値 (`試験・カードの作成は無制限`) に同期修正。
- exam 数・card 数の enforce は**入れない** (前提 = unlimited、 `plan-limits.ts` は ocrPagesPerMonth のみ据置)。

---

## 3. 項目3: カード手動作成・削除

### 3.1 sort_key / placeholder 採番 (pure 関数、 nextOptionId 流用)

新規 `lib/cards/next-card-sort-key.ts` — `nextOptionId` の三分岐を card sort_key (text, 形式混在) 用に転用:

```
nextCardSortKey(existing: (string | null)[]): string
```
- 非 null/非空の既存 sort_key を `vals` に集める。
- `vals` が空 → `'1'`。
- `vals` が全て `/^\d+$/` (zero-pad 含む "001" 等) → `String(Math.max(...vals.map(Number)) + 1)` (= nextOptionId の numeric 分岐と同形)。 ※ zero-pad 幅合わせは任意 (text ASC で「009→10」 は正順、 user 編集可のため MVP は非 pad)。
- それ以外 (階層番号 "03-02" 混在等) → fallback `String(vals.length + 1)` で衝突しない連番 (nextOptionId の `opt-N` fallback に相当する「壊れない既定値」)。

title placeholder も同方式で「末尾連番」:
- `nextCardTitle(existingCount: number): string` → 例 `新規カード ${existingCount + 1}`。 titleSchema min(1) を満たす非空 + 一意性確保。

### 3.2 空 card の notNull 列プレースホルダ (既存 validation を通る値)

create-card は **server 定数プレースホルダ**を入れる (user 入力なし)。 値は update-card-field の編集時 schema を満たすよう選ぶ (= 作成直後に inline 編集しても即エラーにならない state):

| 列 | 値 | 根拠 (満たす制約) |
| --- | --- | --- |
| `title` | `nextCardTitle(count)` 例「新規カード 3」 | titleSchema `min(1)` |
| `questionText` | `'(問題文を入力してください)'` | questionTextSchema 非空 refine |
| `options` | `[{ id: '1', text: '(選択肢1)', is_correct: false }]` | optionsSchema `min(1)` + optionSchema text 非空 refine |
| `correctAnswerIds` | `[]` (空のまま) | jsonb notNull は `[]` 許容。 correct 0 は optionSchema 設計上許容 (`card.ts:7-10`) |
| `sortKey` | `nextCardSortKey(existing)` | text nullable。 末尾連番 |
| `examId` / `userId` | 引数 / 認証 user | notNull FK |
| `sourceDocumentId` | null | nullable (manual = OCR 出自なし) |
| `due` ほか FSRS | default (due=now) | — |

**出題への影響 (前提どおり、 フィルタ新設なし)**: due=now のため作成直後から smart 復習に出る。 correctAnswerIds=[] = 正答 0 のため出題時は常に不正解判定。 これは「空 card もそのまま出題、 ユーザー責任」 の確定方針 (前段調査 軸3: 出題除外フィルタは元々無い)。 → **出題側クエリは一切変更しない**。

### 3.3 server action `app/(app)/app/exams/[id]/_actions/create-card.ts`

```
createCard(examId: string): Promise<ActionResult<{ cardId: string }>>
```
- `getCurrentUser()` → null なら認証エラー。
- `db.transaction(async (tx) => {`
  - exam owner 確認: `tx.select({id,…}).from(exams).where(and(eq(exams.id,examId),eq(exams.userId,user.id)))`。 0 行 → `{ok:false, error:'試験が見つかりません'}` (tx 内 return で rollback)。
  - 既存 sort_key/件数取得: `tx.select({sortKey:cards.sortKey}).from(cards).where(and(eq(cards.examId,examId),eq(cards.userId,user.id)))`。
  - `tx.insert(cards).values({ userId, examId, sourceDocumentId:null, title, sortKey, questionText, options, correctAnswerIds:[] }).returning({id})` (§3.2 の値)。
  - `tx.update(exams).set({ cardCount: sql\`${exams.cardCount} + 1\` }).where(and(eq(exams.id,examId),eq(exams.userId,user.id)))` (process.ts:538 と同形)。
- `})` → `{ok:true, data:{ cardId }}`。
- catch: `serializeDbError(err, { examId })` を logger.warn (§7)。

### 3.4 server action `app/(app)/app/exams/[id]/_actions/delete-card.ts`

```
deleteCard(cardId: string): Promise<ActionResult>
```
- `getCurrentUser()`。
- `db.transaction(async (tx) => {`
  - card 取得: `tx.select({examId:cards.examId}).from(cards).where(and(eq(cards.id,cardId),eq(cards.userId,user.id)))`。 0 行 → idempotent `{ok:true}` (tombstone 入れない、 delete-exam の不在時挙動に倣う)。
  - tombstone INSERT: `tx.insert(tombstones).values({ userId, entityType:'card', entityId:cardId, deletedAt:new Date() }).onConflictDoNothing()`。
  - `tx.delete(cards).where(and(eq(cards.id,cardId),eq(cards.userId,user.id)))`。
  - `tx.update(exams).set({ cardCount: sql\`GREATEST(${exams.cardCount} - 1, 0)\` }).where(and(eq(exams.id,examId),eq(exams.userId,user.id)))` (負数ガード)。
- `})` → `{ok:true}`。
- **最後の 1 枚も削除可** (試験を空に = card 0 件、 §5 で一覧/詳細が破綻しないこと確認済)。
- catch: serializeDbError。

### 3.5 UI (`/app/exams/[id]` の `InlineCardList`)

- 末尾に「＋ カードを追加」 ボタン → `createCard(examId)` → `ok` で `setNewCardId(cardId)` + `router.refresh()`。
- **autoEdit**: `InlineTextField` に `autoEditOnMount?: boolean` を**新設** (現状 `InlineOptionCell` のみ持つ `autoEditOnMount` の one-shot initializer パターン `inline-option-row.tsx:530,555` を踏襲)。 `InlineCardList` は `card.id === newCardId` の card の **`question_text` セル**にのみ `autoEditOnMount={true}` を渡し、 refresh 後の再 mount で即編集モードにする。 最初に開くのを question_text とする理由: **card の主体は問題文であり、 ユーザーが追加直後に最初に書くのが問題文だから** (title / 選択肢は問題文を起点に埋める)。 他セル (title / sort_key / 選択肢) は通常 click で編集。
- 各 card に削除導線 (×) → `DeleteCardButton` (DeleteExamButton の 2 段 confirm パターン流用、 undo なし)。

ASCII:
```
┌─ カード一覧 (5 件) ───────────────────────────┐
│ ┌─ card ────────────────────────────[×]──┐ │
│ │ [sort_key] [タイトル……………]                  │ │
│ │ 問題文: …………………                            │ │
│ │ 選択肢 (3 件)  ○ 正解: a                       │ │
│ │   …                                          │ │
│ └────────────────────────────────────────┘ │
│              ……                                  │
│ [＋ カードを追加]   ← 追加直後は新 card の問題文が編集 mode  │
└────────────────────────────────────────────┘

削除 confirm (DeleteCardButton、 2 段):
  [×] → 「このカードを削除しますか？」 [削除する] [やめる]
        （削除中… / エラー時 inline error）
```

### 3.6 cardCount 整合の注記 (重要)

`exams.cardCount` は **派生キャッシュ** (実件数を `cards` への COUNT で都度求めない最適化、 `schema.ts:224`)。 整合保証は次の一点のみ:

> **createCard (+1) / deleteCard (-1) / deleteExam (exam 行ごと消滅で更新不要) の各「同一 transaction 内更新」 が cardCount と実 card 件数を一致させる唯一の機構である。**

- 同 tx 更新が崩れる (= INSERT/DELETE と cardCount 更新が別 tx になる / 一方だけ失敗する) と、 cardCount が実件数とズレる。 これを構造的に防ぐため、 §3.3 / §3.4 / §4 の各更新は**必ず同一 tx 内**に置く。
- 万一ズレた場合 (過去データ / 異常時) は **`UPDATE exams SET card_count = (SELECT COUNT(*) FROM cards WHERE exam_id = …)` 相当の再計算が別途必要**。 本 spec では再計算 utility / 自動修復は**スコープ外** (ズレ検知時の手当として認識のみ記録)。
- → テストで「同 tx 更新後に cardCount = 実件数」 を必ず検証する (§6)。

---

## 4. delete-exam の tx 化 (項目: tombstone 記録)

`delete-exam.ts` の `_deleteExam` を db.transaction でラップ (現 §0 の単一文 → 網羅記録 tx へ)。

差分 (before → after):
```
before: db.delete(exams).where(id, userId)   // 単一文 + FK cascade のみ
after:  db.transaction(async (tx) => {
          // 1. exam 存在・owner 確認
          const ex = await tx.select({id:exams.id}).from(exams)
            .where(and(eq(exams.id,examId), eq(exams.userId,user.id)))
          if (ex.length === 0) return            // 不在/他user → tombstone なし idempotent
          // 2. 配下 card id 列挙 (物理削除前、 cascade で消える前に取得)
          const childCards = await tx.select({id:cards.id}).from(cards)
            .where(and(eq(cards.examId,examId), eq(cards.userId,user.id)))
          // 3. tombstone 網羅 INSERT (exam 1 + card 全件)、 chainable multi-row (#5789 回避)
          const now = new Date()
          await tx.insert(tombstones).values([
            { userId:user.id, entityType:'exam', entityId:examId, deletedAt:now },
            ...childCards.map(c => ({ userId:user.id, entityType:'card' as const, entityId:c.id, deletedAt:now })),
          ]).onConflictDoNothing()
          // 4. 物理削除 (FK cascade で cards/source_documents/reviews 連動)
          await tx.delete(exams).where(and(eq(exams.id,examId), eq(exams.userId,user.id)))
        })
```
- 順序は「存在確認 → 列挙 → tombstone → delete」 必須 (cascade 後は card id を取れないため列挙が delete より前)。
- idempotency: 不在時は tombstone を入れず return (既存 silent success 維持)。 再削除レースは UNIQUE(entityType,entityId) + onConflictDoNothing で吸収。
- `revalidatePath('/app/upload')` は finally で維持。
- catch: serializeDbError (§7)。
- **網羅記録の規模**: 1 試験 100-500 card 想定。 chainable `.values([...])` の単一 multi-row INSERT で十分 (件数上限の chunk 化は MVP では不要、 必要なら後続)。

---

## 5. 一覧描画の非回帰確認 (source_documents 行ゼロ exam)

- `getActiveExamsWithCardCount` は exams 単体 SELECT (`list.ts:12-13`、 source_documents JOIN なし) → manual exam も name + `cardCount` で正常表示。
- `getExamStatusMap` は source_documents 由来 → manual exam は entry なし → `ExamStatusBadge` が `return null` (`exam-status-live.tsx:152`) で**バッジ非表示**。
- card 0 件の exam 詳細 (`/app/exams/[id]`): `InlineCardList` は cards.map で 0 件描画 + 「＋ カードを追加」 ボタンのみ表示 (空でも破綻しない)。
- → **一覧・詳細とも改修不要** (描画は既存ロジックで成立)。

---

## 6. テスト方針 (TDD)

pure 関数を厚く、 server action は `update-card-field.test.ts` の DB テストパターン踏襲。

| 対象 | test |
| --- | --- |
| `nextCardSortKey` (pure) | 空→'1' / 全 numeric→max+1 / "001".."009"→"10" / 階層混在→count+1 fallback / null 除外 (`next-option-id.test.ts` 同様) |
| `nextCardTitle` (pure) | count→「新規カード N」 非空保証 |
| 空 card placeholder | 生成値が optionsSchema/titleSchema/questionTextSchema を**通る**ことを zod で検証 (作成→編集 valid 一貫性) |
| `createExam` | 空白のみ→error / >200→error / valid→insert + examId 返却 / owner-scope (user.id 固定) |
| `createCard` | placeholder 挿入 + cardCount+1 が**同 tx** / sortKey 末尾連番 / exam 不在→error / owner-scope |
| `deleteCard` | tombstone(card) INSERT + card DELETE + cardCount-1 が同 tx / 不在→idempotent ok / owner-scope / 再削除 onConflictDoNothing |
| `deleteExam` (tx 化後) | 配下 card 列挙 → tombstone(exam+card 網羅) INSERT → cascade delete / 不在→tombstone なし idempotent / 既存 delete-exam.test.ts の non-regression |
| **cardCount 整合** (§3.6) | createCard 後 `exams.cardCount === COUNT(cards WHERE exam_id)` / deleteCard 後も一致 / 複数回 create+delete を混在させても一致 / deleteExam では exam 行ごと消えるため検証不要。 「同 tx 更新が実件数と一致する」 ことを各 action test の事後アサートに含める |
| tombstones schema | migration 適用 / UNIQUE(entityType,entityId) 効く |
| 一覧 | manual exam (source_doc なし) でバッジ非表示 (ExamStatusBadge 既存 test + 必要なら追加) |

- AI 実 API 不使用 (本機能は AI 非依存)。 Stripe/Clerk 非依存。

---

## 7. 観測強化 (serializeDbError)

新規 tx 経路 (createCard / deleteCard / deleteExam tx 化) の catch で `serializeDbError(err, {…})` (`lib/db/serialize-db-error.ts`) を logger.warn に渡す。 tombstone INSERT / cascade DELETE / cardCount 更新の pg native error (FK 違反・UNIQUE 衝突等) を可視化 (問題3 で確立した観測手法の流用)。 timestamptz は chainable `.values({deletedAt:new Date()})` 経由のため #5789 (raw sql template の Date embed) に当たらない。

---

## 8. 実装タスク分解と順序

1. **tombstones schema + migration 0014** (`schema.ts` 追記 → `pnpm db:generate`)。 — 後続の delete 系の前提。
2. **pure 関数** `nextCardSortKey` / `nextCardTitle` / 空 card placeholder builder (TDD 容易、 独立)。
3. **createExam action + 手動作成 UI** (`create-exam.ts` + `create-exam-form.tsx` + 空状態 CTA) + **catalog 表記修正** (独立、 並行可)。
4. **createCard action + InlineCardList 追加ボタン + autoEdit** (`InlineTextField` に `autoEditOnMount` 新設)。 — 1,2 に依存。
5. **deleteCard action + DeleteCardButton (confirm)**。 — 1 に依存。
6. **deleteExam tx 化 + tombstone 網羅記録** (`delete-exam.ts` 改修)。 — 1 に依存、 既存 test の non-regression 必須。
7. (catalog 修正は 3 に同梱 or 独立 commit)。

依存: 1 → (2,3 並行) → 4 → (5,6)。 各 task は feat(_) として TDD + `requesting-code-review` + `[reviewed]` (CLAUDE.md)。 削除は「外部副作用」 ではない (自前 DB のみ) ため review pass で `[reviewed]` 可。

---

## 9. スコープ外 (本 spec では扱わない)

- tombstone を**読む側** (増分 pull `/api/*/pull?since=` への反映、 client mirror からの削除)。 = 後続スプリント。
- tombstone の保持期間 / GC (無限増加対策)。 = 後続 (記録のみ先行)。
- exam 数・card 数の plan enforce (前提 = unlimited)。
- 出題除外フィルタ (空 card を出題から外す)。 = 確定方針で**新設しない**。
- exam の rename/メタ編集 UI (questionNoFormat 等)。 = 別 idea。
- card 並び替え (drag) / sort_key 手動以外の再採番。

---

## 10. spec 自己レビュー (placeholder / 矛盾 / scope / 曖昧)

- placeholder/TODO: なし (全 contract・値・schema を具体化)。
- 矛盾: 「空 card を出題除外しない」 と「placeholder で valid に保つ」 は両立 (フィルタ不要、 描画も壊れない)。
- scope: 記録側のみ・読む側は §9 で明示除外。 単一実装 plan に収まる粒度。
- 曖昧: catalog 文言は **`試験・カードの作成は無制限` に確定** (§2.3、 OT review)。 sort_key zero-pad 幅は MVP 非 pad と明記。 title placeholder 文言 (`新規カード N`) は例示 (実装時確定)。
- OT review 反映 (2026-05-29): ① catalog 文言確定 (§2.3) ② cardCount 整合の注記 + test 追加 (§3.6 / §6) ③ autoEdit セル = question_text を理由付きで明示 (§3.5)。
