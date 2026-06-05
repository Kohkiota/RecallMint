# タグ機能 — LocalSync 経路適合性 事前調査 (2026-06-05)

実装はまだ不要。調査と報告のみ。 対象は (1) outbox 書込経路, (2) 増分 pull,
(3) tombstones, (4) Dexie store 構成, (5) cards.custom_props 実態, (6) 過去
tag schema 痕跡, (7) exams / cards 既存 jsonb。 加えて「card のタグ集合を
whole-set field として既存 card 同期経路に相乗りさせる」設計の feasibility 判定。

---

## 1. LocalSync 書込経路 (card 編集 → outbox → server)

### 1.1 outbox row 構造 (`lib/client-db.ts:146-155`)

```ts
export type ClientCardMutation = {
  local_id?: number          // Dexie auto-increment PK
  mutation_id: string        // UUID。 server で UNIQUE、 冪等化キー
  card_id: string
  op: 'update_field' | 'create' | 'delete'
  patch: Record<string, unknown>
  edited_at: string          // ISO 8601
  sync_status: SyncStatus    // 'pending' | 'syncing' | 'synced' | 'failed'
  last_attempted_at?: string
}
```

- **1 row = 1 mutation (op 単位)**。 field 単位 / whole-card snapshot ではない。
- `op='update_field'` の patch は `{ field: UpdateCardFieldName, value: unknown }` 形式。
  - server endpoint (`app/api/card-mutations/bulk/route.ts:122`) で zod
    `z.enum(['update_field','create','delete'])` を強制。

### 1.2 Coalesce キー (`lib/sync/card-mutations.ts:45-53`)

```ts
function coalesceKey(input: EnqueueCardMutationInput): string {
  if (input.op === 'update_field' && typeof input.patch.field === 'string') {
    return `${input.card_id}:update_field:${input.patch.field}`
  }
  return `${input.card_id}:${input.op}`
}
```

- `update_field` は **`card_id + field` 単位で 1 row に畳む** (last-write-wins)。
- `create` / `delete` は `card_id + op` 単位。
- 同 card・同 field の連続編集は最新 patch.value で既存 pending 行を上書き、
  mutation_id は再採番 (`lib/sync/card-mutations.ts:85-95`)。

### 1.3 options 配列の扱い (whole-array 設計)

`lib/cards/apply-card-mutation.ts:118-135` の server 側 buildSetClause で
`options` field は `z.array(optionSchema).min(1).max(50)` で配列全体を受け、
配列全体を 1 値として cards.options jsonb に置換。
**要素単位の add/update/delete op は存在しない**。

client 側 commit (`app/(app)/app/exams/[id]/_components/inline-option-row.tsx:196-201`)
も配列全体を sanitize して 1 mutation に渡している:

```tsx
enqueueCardMutation({
  card_id: cardId,
  op: 'update_field',
  patch: { field: 'options', value: payload }, // payload = ZodOption[] 完全配列
})
```

### 1.4 UpdateCardFieldName allowlist (`lib/cards/apply-card-mutation.ts:35-41`)

```ts
export type UpdateCardFieldName =
  | 'title'
  | 'sort_key'
  | 'question_text'
  | 'explanation_text'
  | 'memo'
  | 'options'
```

**現在 `tags` は含まれていない**。 server 側 `buildSetClause` switch も同様に
6 field のみ。 タグを既存経路に乗せるには **この allowlist + buildSetClause +
zod schema 追加が必要**。

### 1.5 Flush (`lib/sync/card-mutation-flush.ts`)

- 500ms debounce、 Web Locks (`CARD_MUTATION_FLUSH_LOCK_NAME`) で origin 内
  排他、 in-flight Set による mutation_id 二重送信防止。
- 全 pending を 1 回 POST `/api/card-mutations/bulk` (session grouping なし)。
- network / 4xx / 5xx 失敗時は pending 残置 (retry)、 response.body.failed
  に含まれる mutation_id のみ pending 残置で他は synced 化。

### 1.6 冪等担保 3 重防衛 (`lib/sync/card-mutation-flush.ts:13` 注釈)

1. server: mutation_id UNIQUE
2. client: module-scope in-flight Set
3. client: Web Locks

---

## 2. 増分 pull の構成

### 2.1 Stream 一覧 (現在 4 stream)

| Stream      | Cursor key (sync_meta)              | Server endpoint        | Server file                  |
|-------------|--------------------------------------|------------------------|------------------------------|
| cards       | `cardsCursor`                        | `GET /api/pull`        | `lib/db/cards-pull.ts:20`    |
| exams       | `examsCursor`                        | `GET /api/pull`        | `lib/db/exams-pull.ts:27`    |
| tombstones  | `tombstoneCursor`                    | `GET /api/pull`        | `lib/db/tombstones-pull.ts:28` |
| study_days  | (cursor なし — 90 日 full-window)    | 別 endpoint            | `lib/db/study-days-pull.ts:50-60` (pull-back.ts) |

cursor は ISO 8601 string、 各 stream で返った行の `updated_at` / `deleted_at`
の max を sync_meta テーブルに保存 (`lib/sync/sync-meta.ts:14-16`)。

### 2.2 card stream の payload (`lib/db/cards-mapper.ts:16-49`)

server → client mapper が 30 以上の field を写像。 **tags / custom_props
両方が既に payload に含まれている**:

```ts
// lib/db/cards-mapper.ts:30-31
custom_props: row.customProps,
tags: row.tags,
```

cards-pull.ts の SELECT も `*` のため tags 列を含む全カラム返却。

### 2.3 apply 順序 (`lib/sync/pull.ts:118-143`)

1. cards bulkPut
2. exams bulkPut
3. tombstones bulkDelete (cards / exams の物理削除を反映)
4. cursor 書込 (max ISO を sync_meta に保存)

3 stream 間は無依存。 tombstones が常に最後。

---

## 3. Tombstones (削除伝播)

### 3.1 Schema (`lib/db/schema.ts:676-693`)

```ts
export const tombstones = pgTable('tombstones', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  entityType: text('entity_type').$type<'exam' | 'card'>().notNull(),
  entityId: uuid('entity_id').notNull(),  // FK 不可 (対象は物理削除済)
  deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
// UNIQUE(entity_type, entity_id)
```

**polymorphic 単一テーブル**。 entity_type で `'exam' | 'card'` 識別。

### 3.2 生成元

- card 削除: `lib/cards/apply-card-mutation.ts:340-384` (delete mutation 適用時、
  tx 内で tombstone INSERT → cards DELETE を順に実行、 onConflictDoNothing)
- exam 削除: `app/(app)/app/exams/_actions/delete-exam.ts:69-84` (exam 1 件 +
  配下 card 全件の tombstone を 1 tx で INSERT → exam DELETE)

### 3.3 client apply (`lib/sync/pull.ts:118-143`)

```ts
const cardIds = tombstones.filter(t => t.entity_type === 'card').map(t => t.entity_id)
const examIds = tombstones.filter(t => t.entity_type === 'exam').map(t => t.entity_id)
if (cardIds.length) await db.cards.bulkDelete(cardIds)
if (examIds.length) await db.exams.bulkDelete(examIds)
```

- 物理削除 (soft-delete flag なし)
- Dexie には tombstones 自体の mirror を持たない (受領 → 即適用 → 捨てる)

### 3.4 TTL / 保持

schema に TTL / 保持期間列なし、 削除ルールなし。 現状は永久保存。

---

## 4. Dexie (IndexedDB) store 構成 (`lib/client-db.ts:178-207`)

### 4.1 Store 一覧 (現在 8 store)

| Store           | PK / Key              | Index                                                  | 用途 |
|-----------------|----------------------|--------------------------------------------------------|------|
| exams           | `id`                  | user_id, updated_at, content_version                   | exam mirror |
| cards           | `id`                  | exam_id, user_id, due, updated_at, content_version, sync_status | card mirror |
| user_settings   | `user_id`             | -                                                      | 設定 |
| study_sessions  | `session_id`          | exam_id, mode, status, sync_status                     | 演習 session |
| answer_events   | `++local_id`          | event_id, session_id, card_id, sync_status             | 回答 log |
| card_mutations  | `++local_id`          | mutation_id, card_id, sync_status                      | outbox |
| sync_meta       | `key`                 | -                                                      | cursor 永続化 |
| study_days      | `[user_id+day]`       | user_id, day                                           | 学習日カレンダー |

### 4.2 cards store の row shape (`lib/client-db.ts:67-99`)

```ts
export type ClientCard = {
  id: string
  user_id: string
  exam_id: string
  source_document_id?: string | null
  title: string
  sort_key?: string | null
  question_text: string
  options: ClientCardOption[]
  correct_answer_ids: string[]  // client 専用 (server では is_correct から compute)
  explanation_text?: string | null
  memo?: string | null
  images: ClientCardImage[]
  custom_props: Record<string, unknown>
  tags: string[]                // 既存
  answered: boolean
  last_correct?: boolean | null
  current_streak: number
  // FSRS: due, stability, difficulty, elapsed_days, scheduled_days,
  //       reps, lapses, state, learning_steps, last_review
  content_version: number
  created_at: string
  updated_at: string
  sync_status: SyncStatus       // mutation 経路のため MVP は 'synced' 固定
}
```

**`tags: string[]` は ClientCard 型に既に存在**。 Dexie schema 変更 (新規 store
追加 / index 追加) は不要 (タグ検索を index で高速化したい場合のみ将来検討)。

---

## 5. cards.custom_props の現状

### 5.1 Schema (`lib/db/schema.ts:307-310`)

```ts
customProps: jsonb('custom_props')
  .notNull()
  .default(sql`'{}'::jsonb`)
  .$type<Record<string, unknown>>(),
```

GIN index: `cards_props_gin_idx` (jsonb 検索用)。

### 5.2 書込経路 (全件)

**OCR pipeline のみ**: `app/(app)/app/upload/_actions/process.ts:521` の cards
bulk INSERT で `pipelineResult.cards[].custom_props` を直接 insert。
Gemini 2.5 Flash の discover mode (`lib/ai/prompts/ocr-extract.ts:244-253`)
で「文書に明示的に記載されているメタデータ」を自由キーで抽出した結果。

### 5.3 編集 UI からの書込 — **なし**

- `UpdateCardFieldName` allowlist に `custom_props` は含まれていない
  (§1.4 参照)。
- `inline-card-list.tsx` の editable field は title / sort_key / question_text
  / explanation_text / memo / options のみ。
- card 編集経路で custom_props は一切 touch されない (read-only)。

### 5.4 読込位置

- `lib/db/cards-mapper.ts:30` (server → client mapper の写像)
- `lib/client-db.ts:80` (Dexie 型定義)
- `app/(app)/app/upload/_actions/process.ts:652` (OCR preview で
  `customPropKeys: Object.keys(extracted.custom_props ?? {})` のキー列挙のみ)
- **表示 UI で実際に値を読む箇所は確認できなかった** (preview 以外)。

### 5.5 production 実データ判定 (コード経路ベース)

- card 作成時の INSERT は OCR 経由のみ。 既存 card への後付け書込経路はゼロ。
- discover mode の抽出実績 (`docs/research/ocr-schema-vs-discover.md`):
  - nursing-114: 0/36 (空)
  - sat: 3 キー (Domain / Skill / Skill_Sub)
  - IPMA: KCI のみ
- **結論**: OCR が文書から抽出した値がそのまま固定。 大半は空、 一部 exam で
  少数キー。 編集 UI 経由の書き換えは存在しない。

### 5.6 DROP 時の影響範囲

- schema (`lib/db/schema.ts:307-310`) — 列 + GIN index 削除
- mapper (`lib/db/cards-mapper.ts:30, :70` — 2 箇所)
- Dexie 型 (`lib/client-db.ts:80`)
- OCR pipeline (`lib/ai/schemas/`, `lib/ai/prompts/ocr-extract.ts:244-253`,
  `app/(app)/app/upload/_actions/process.ts:521,:652`) — discover mode 出力を
  捨てるか tags に振替えるか要設計
- 関連 docs / tech-spec の追記

---

## 6. 過去 tag schema 設計・実装痕跡

### 6.1 migration / DB 痕跡

`drizzle/migrations/0003_free_killmonger.sql`:

```sql
ALTER TABLE "cards" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;
```

→ **cards.tags text[] は S1a で先打ち済**。 revert / 削除 migration は無し。
`exams.tag_keys`, `card_tags` (junction), `tag_groups`, `tags` (master) などの
テーブル / 列は **未実装**。

### 6.2 git commit 痕跡

`be3df35` (2026-05-19): `feat(db): add cards.tags text[] column for manual tagging (S3 先打ち)`

→ S3 (タグ機能 sprint) の前に列だけ先に追加した経緯。 削除 / revert なし。

### 6.3 docs 痕跡

- `docs/02-tech-spec.md` §3.3 / §14.6: 「custom_props は S2.0b の tag schema
  移行で扱う、 現状は touch しない」
- `docs/research/ocr-schema-vs-discover.md` (2026-05-17): schema mode
  (事前定義 enum) vs discover mode (自由抽出) を PoC 比較、 discover mode
  採用
- memory `s2-sprint-reorder.md` の S2.0b 定義: **`exams.tag_keys + card_tags、
  custom_props DROP` + OCR 改修 + Notion 風一覧編集 + tag manager**

### 6.4 まとめ

| 項目                    | 状態 |
|-------------------------|------|
| `cards.tags text[]`     | 列のみ先打ち済 (default '{}'::text[]、 default 値で空配列) |
| `exams.tag_keys`        | **未実装** (S2.0b で予定されていた) |
| `card_tags` (junction)  | **未実装** (S2.0b で予定されていた) |
| `tag_groups` / 親子     | **未実装** |
| custom_props DROP       | **未実施** (S2.0b で予定されていた) |
| 過去 revert             | ゼロ |

memory の S2.0b 計画は **junction table 案 (`card_tags`)** だった。 今回の
brief 「whole-set field として既存 card 同期経路に相乗りさせる」 は **S1a で
先打ちされた `cards.tags text[]` を活用する案** であり、 計画変更に相当する。

---

## 7. exams / cards 現 schema

### 7.1 exams (`lib/db/schema.ts:234-271`)

| 列                  | 型                | 用途 |
|---------------------|------------------|------|
| id                  | uuid PK          | - |
| user_id             | uuid FK→users    | CASCADE |
| name                | text             | 試験名 |
| questionNoFormat    | text             | 'numeric' / 'hierarchical' / 'free' |
| archivedAt          | timestamptz null | downgrade 時自動 archive |
| cardCount           | integer          | 非正規化キャッシュ、 card INSERT と同 tx |
| contentVersion      | integer          | local-first 同期 version (S-cache-0) |
| createdAt / updatedAt | timestamptz   | - |

**jsonb 列なし**。

### 7.2 cards (`lib/db/schema.ts:279-364`)

| 列                  | 型                          | 用途 |
|---------------------|-----------------------------|------|
| id                  | uuid PK                     | - |
| user_id / exam_id   | uuid FK                     | CASCADE |
| source_document_id  | uuid FK→sourceDocuments     | SET NULL |
| title / question_text / explanation_text / memo | text | - |
| sort_key            | text null                   | - |
| **options**         | jsonb (CardOption[])        | whole-array |
| **correct_answer_ids** | jsonb (string[])         | client 表示用 de-norm |
| **images**          | jsonb (CardImage[])         | OCR 抽出画像 meta |
| **custom_props**    | jsonb (Record<string,unknown>) | §5 参照 |
| **tags**            | text[]                      | 既存・default '{}' |
| FSRS 系             | (due/stability/diff/.../state) | - |
| content_version     | integer                     | local-first 同期 version |
| createdAt / updatedAt | timestamptz               | - |

Index: `cards_user_updated_id_idx (user_id, updated_at, id)`,
`cards_props_gin_idx (custom_props GIN)`。 **tags GIN は無し**。

### 7.3 既存 jsonb 列の用途

| テーブル        | 列                | 用途             | 書込元 |
|----------------|-------------------|------------------|--------|
| cards          | options           | 選択肢本体        | OCR + 編集 UI |
| cards          | correct_answer_ids| 正解 id de-norm  | server 再生成 |
| cards          | images            | 画像メタ          | OCR |
| cards          | custom_props      | 自由 metadata    | OCR only |
| studySessions  | cardIds           | session card list | local-first |
| studySessions  | query             | 検索条件          | local-first |
| answerEvents   | selectedAnswerIds | 回答選択肢        | local-first |
| cardMutations  | patch             | mutation payload | local-first |

---

## 8. Feasibility 判定

### 設問

「card のタグ集合を **card の whole-set フィールド** として扱い (options 配列
と同じ要領)、 **独立した sync stream や新しい tombstone type を増やさず**
既存の card 同期経路に相乗りさせる」 — 今の outbox / pull で素直に成立するか。

### 結論: **成立する**。

各経路の適合性:

#### 8.1 outbox (書込)

- 既存 `op='update_field'` + `patch={ field: 'options', value: 配列全体 }` の
  pattern が **そのまま使える**。
- coalesce key も既存ロジック (`card_id:update_field:tags`) で機能、 同 card
  への連続タグ編集は 1 row に畳まれる (last-write-wins、 options と同じ挙動)。
- **必須の追加作業** (data 設計判断とは別の機械的差分):
  1. `UpdateCardFieldName` (apply-card-mutation.ts:35) に `'tags'` 追加
  2. `tagsSchema` (zod array<string>、 長さ / 個数 / 重複 / 正規化制約) を定義
  3. `buildSetClause` switch に `case 'tags'` 追加 (camelCase 不要、 column 名
     も `tags`)
  4. `app/api/card-mutations/bulk/route.ts` の patch zod に `field='tags'` の
     value 型を許可 (現在 field 値の型は zod 側で `z.unknown()` のはずだが要確認)

#### 8.2 pull (読込)

- `cards.tags` は **既に payload に含まれている** (`lib/db/cards-mapper.ts:31,71`)。
- `ClientCard.tags: string[]` も **既に存在** (`lib/client-db.ts:81`)。
- 増分 cursor は `updated_at` ベース。 tag 更新時に cards.updated_at が bump
  されれば自動で下る (server `applyCardFieldUpdate` は `updated_at = now()` を
  set している前提 — 要確認、 既存 6 field と同じ pattern なら問題なし)。
- **schema 変更ゼロ、 stream 追加ゼロ**。

#### 8.3 tombstones

- 「card 全体」 削除しか tombstone を生成しない現設計と整合。
- タグ集合は card field なので、 単一 tag の削除は配列の whole-array 上書きで
  表現される (`tags = [...prev].filter(t => t !== removed)`)。
- **新 tombstone type 不要、 tombstones テーブル変更ゼロ**。

#### 8.4 Dexie

- cards store の row shape に `tags: string[]` 既存、 schema 変更不要。
- index 追加は不要 (タグ別の高速検索が必要になった段階で `tags` を multi-entry
  index 化する判断は将来できる)。
- **store / index 追加ゼロ**。

### 8.5 ただし、 設計判断として別途要決定の論点

これは「経路に乗るか否か」とは別レイヤだが、 タグ機能を実装する前に決める必要
がある:

1. **タグマスター (中央定義) の有無**
   - 現案 (text[] only): tag は「card に紐づいた flat string set」。 マスター
     なし。 rename は全 card scan で更新。 タグ一覧は `SELECT DISTINCT unnest(tags)`
     で導出。
   - memory `s2-sprint-reorder` の旧 S2.0b 案: `exams.tag_keys` + `card_tags`
     junction でマスター持ち。 rename / 統計 / 階層化が楽。
   - text[] only でも tag manager UI は実現可 (タグ一覧 = DISTINCT 集計)
     だが、 rename は重い。

2. **タグの形 (flat string vs key:value)**
   - brief で「分野=循環器」 と書かれている。 text[] は flat なので:
     - (a) tag = `"循環器"` (key を context から推論 / 単一次元前提)
     - (b) tag = `"分野:循環器"` (serialize 規約、 flat のまま key-value 表現)
     - (c) key 別に複数 text[] 列 (`field_tags text[]`, `topic_tags text[]`,
       ...) — 動的に増やせないため × か
   - 「分野」 以外の dimension (難度 / 出題年 / etc) が想定される場合は要設計。

3. **custom_props の扱い**
   - 旧 S2.0b 案では DROP 予定。 text[] tags への移行が前提だった。
   - 現状 OCR が discover mode で抽出している自由 metadata (Domain / Skill /
     KCI 等) を:
     - (i) tags に詰め込む (key:value 規約 or key 別 prefix)
     - (ii) 捨てる (sat / IPMA で実データがあるが過去 OCR 限定)
     - (iii) custom_props を残す (tag とは別レイヤ)
   - OCR 改修要否に直結する。

4. **タグ検索 / 絞り込みの実装側**
   - 「分野=循環器の card を絞り込んで演習」 の query:
     - server: `WHERE tags @> ARRAY['循環器']` — index なしで seq scan。
       cards 数次第で要 GIN index。
     - client (Dexie): `cards.toArray().filter(c => c.tags.includes('循環器'))`
       — local-first なので primary path はこちら。 mobile で 1000 枚程度なら
       問題ないはず。

5. **OCR pipeline からのタグ流入**
   - OCR が custom_props ではなく直接 tags に書く形に改修するか。
   - schema mode (事前定義 enum) は `exams.tag_keys` 案と紐付くため、 現案
     (text[] only) なら不要。

### 8.6 想定差分の規模感 (純粋に「経路に乗せる」 部分のみ)

| 修正対象                                     | 行数 oo | 性質 |
|---------------------------------------------|---------|------|
| `apply-card-mutation.ts` (allowlist + zod + switch) | +20    | 機械的 |
| `bulk/route.ts` (field=tags の patch 検証)  | +5     | 機械的 |
| 編集 UI (タグ editor component)              | +200~  | 新規実装 |
| ClientCard 型変更                            | 0      | 既存 |
| Dexie schema 変更                            | 0      | 既存 |
| migration                                    | 0      | 既存 |
| pull / sync_meta / tombstones                | 0      | 既存 |

**「既存経路に乗せる」 部分は schema 変更ゼロ + sync stream 追加ゼロ + 機械的な
20-30 行で完結する**。 残りは UI 実装と上記 8.5 の設計判断のみ。

---

## 9. docs 全件再走査による設計履歴の裏取り (2026-06-05 追補)

OT 仮説:「タグを無限につけられるよう cards と別に **タグを別テーブルにする** 設計を
構想していたはず」 — の真偽を docs 172 file 網羅 grep で裏取り。

### 9.1 結論

**仮説は真。 しかし設計の形は「自由 free-tag マスター」 ではなく
「Notion DB ライク property schema」**。

### 9.2 一次資料 (確定 DDL の所在)

`docs/superpowers/sessions/2026-05-22-s2-0-card-editor-investigation.md:32-50`
に **「確定済の設計判断 (OT 合意済、 本 doc の前提)」 として DDL レベル**で記載:

```
exams.tag_keys jsonb NOT NULL DEFAULT '[]'::jsonb
  [ { "key": "カテゴリ", "type": "single_select",
      "options": [ {"id":1,"value":"A","color":"blue"}, {"id":2,"value":"B","color":"red"} ] },
    { "key": "ドメイン", "type": "multi_select",
      "options": [ {"id":1,"value":"EC2","color":"orange"} ] } ]

card_tags (新設テーブル)
  card_id   uuid    FK → cards.id ON DELETE CASCADE
  key       text    NOT NULL
  option_id integer NOT NULL
  PRIMARY KEY (card_id, key, option_id)

cards.custom_props 列を DROP (既存データを card_tags + exams.tag_keys に分解後)
```

### 9.3 設計の特徴 (同 doc :52-59)

- tag 定義は **exam に属する** (1 exam = 1 set of tag_keys)、 system-wide master は持たない
- card は `option_id` の整数参照のみで tag を持つ (脱正規化なし、 value/color rename が
  全 card に自動連動)
- `option_id` は **key 内 integer sequence** (key 跨ぎで一意ではない)
- single_select / multi_select 両対応、 `multi → single` は不可 (data loss 回避)
- OCR 時は全 key を single_select として **auto 追加**、 後から user が変更可
- 既存 exam への追加 upload 時、 未登録 key も **auto 追加**
- **Gemini 責務は現状維持** (discover mode で freeform `custom_props` を返す)、
  保存層 (`processUpload`) が jsonb を tag_keys + card_tags に分解保存する二層構造

### 9.4 「無限性」 の度合い

- per-exam の tag key 種別数: schema 上の上限なし (jsonb 配列)
- per-key の option 数: schema 上の上限なし
- per-card の tag 数: multi_select なら同 key 内で複数、 keys 跨ぎでも複数 ⇒ 事実上無制限
- ただし **「ユーザーが自由文字列を投げ込む型」 ではない**: exam の tag schema を
  先に定義し option を選択する Notion DB property 型

### 9.5 kickoff 時点で残っていた実装論点 (同 doc :80 D6, :213-216)

確定 DDL の中にもなお論点が残っている (S2.0 着手時に決定必要):

1. `card_tags` に **`user_id` 列がない** ⇒ CLAUDE.md「全 table に user_id 必須」
   絶対ルール および `schema.ts` 「ルール B」 (idempotency 3 表を除く全 table が
   user_id 保持) に抵触
2. `card_tags.key` が text 非正規化 ⇒ key rename 時に card_tags 行の cascade UPDATE
   が必要 (option の value/color 変更のような構造的自動連動ではない)
3. single_select の DB 一意性を制約で担保するか、 application 層担保か
4. option_id 採番戦略 (monotonic forever vs reuse)

### 9.6 現状との不整合 (同 doc :70 D2, :91)

- production DB 接続調査 (kickoff 時点) で **339 card 全て `custom_props = {}` 空**、
  `cards.tags text[]` も全件空 ⇒ 「custom_props → card_tags 移行」 の移行対象データ
  はゼロ
- `cards.tags text[]` (S1a 先打ち) は S3 で manual tag UI を作るための列だったが、
  新 schema (`card_tags`) と機能重複 ⇒ 存廃が論点 (同 doc §6 参照)

### 9.7 tech-spec / research doc との衝突

同 doc :77 D3 / :86-114 で明示:

- tech-spec §2.5.1 は「**試験単位の事前定義は不要 (discover mode 一本化)**」 と明記
- `docs/research/ocr-schema-vs-discover.md` (2026-05-17) で「discover mode 一本化」
  を採用判定
- 新 schema (`exams.tag_keys` 持ち、 exam 単位の事前定義) は **この判断を反転させる**
- spec §2.2 / §2.5.1 / §2.5.2 / §2.8 / §2.9 / §3 / §8 Logic 4・5 と research doc
  の改訂対象

### 9.8 設計履歴の時系列

| 日付 | 出来事 | doc |
|------|--------|-----|
| 2026-05-17 | discover mode 一本化決定 (PoC 5 試験でキー揺れ 0) | `research/ocr-schema-vs-discover.md` |
| 2026-05-19 | `cards.tags text[]` 先打ち migration (`be3df35`、 S3 用) | `2026-05-19-sprint-roadmap-review.md` 該当 |
| 2026-05-21 | S2 sprint 順序変更 ([[s2-sprint-reorder]] memory) | memory note |
| 2026-05-22 | S2.0 kickoff で確定 DDL (`exams.tag_keys + card_tags`、 `custom_props` DROP) | `2026-05-22-s2-0-card-editor-investigation.md:23-50` |
| 2026-05-22 | S2.0 を 2 分割: S2.0 (個別 card 編集、 schema 非依存) + S2.0b (tag schema 移行) | memory note |
| 2026-06-01 | S2.0b1 (一覧スリム化 + OCR poll 自動反映) 事前調査 + plan | `2026-06-01-s2-0b1-presurvey.md`, `plans/2026-06-01-s2-0b1-slim-and-ocr-poll.md` |
| 2026-06-05 | 今回 brief: text[] whole-set field 案で既存 sync 経路に相乗りさせる検討 | 本 doc §8 |

### 9.9 設計案の比較表 (現時点)

| 観点 | 案 X: `cards.tags text[]` whole-array (今回 brief 案) | 案 Y: `exams.tag_keys + card_tags` (2026-05-22 確定済案) |
|------|-----------------|-----------------|
| 別テーブル | なし | **あり** (`card_tags` junction) |
| tag 定義の場所 | なし (flat string set) | exam.tag_keys jsonb |
| 同期経路 | 既存 card outbox/pull に相乗り | card_tags 用に新規 stream/outbox が要りそう (要検討) |
| schema 変更 | ゼロ (列既存) | exams 列追加 + 新テーブル + custom_props DROP |
| migration | 不要 | 必要 (data move: custom_props → card_tags) ※実データなし |
| OCR 改修 | 任意 (discover 値の捨て / 振替を別途決定) | 必須 (discover 出力を tag_keys + card_tags に分解保存) |
| tag rename / 統計 | scan 全 card 重い | option_id 参照のため自動連動 |
| 階層 / 型情報 (single/multi/color) | なし | あり |
| Notion 互換 UI 親和性 | 低い | 高い |
| 実装 scope | 小 (機械的 20-30 行 + UI) | 大 (S2.0b 全項目) |

### 9.10 OT 仮説の評価

「タグを **無限につけられる**ように、 cards と別に、 タグは **別テーブル** にする
設計」 — の意図は:

- ✓ **別テーブル**: 案 Y で `card_tags` junction として確定済 (DDL レベル)
- △ **無限**: 「ユーザーが自由文字列を無制限に投げる」 型ではない。 「exam の tag
  schema を先に定義し、 その中で per-card に複数 (multi_select) 付与」 型。
  schema 上の数値上限はないため事実上無制限ではあるが、 値の自由度は exam の
  tag_keys 定義の中に限定される (option を増やせば対応可)
- ✓ **cards と別** = ✓ (junction)

OT 仮説の核心 (「別テーブル設計が過去にあった」) は **明確に YES**。 ただし
「無限の free-tag マスター」 ではなく、 **Notion DB property 型の exam-scoped
schema** であった点に注意。

---

## 11. 確定方針 (3 entity・試験横断・OCR fire-and-forget) の feasibility 調査 (2026-06-05 追補)

OT 確定方針:
- タグは **試験横断** (全 exam 共通 1 空間、 exam に紐付けない)
- 3 entity:
  - `tag_categories(id, name, select_type='single'|'multi', user_id)` — select_type 作成後 immutable、 name 重複可 (別 id で同名共存)
  - `tag_options(id, category_id, value, user_id)`
  - `card_tags(card_id, option_id, user_id)` — junction、 multi 前提、 常に複数紐付け
- single の「1 個まで」 制約は **UI 担保** (DB は single/multi 区別しない)
- OCR (Gemini discover) は毎回 **新規カテゴリ (multi) を作るだけ** (既存カテゴリには一切書き込まない、 同名でも別 id の新規) → 保存層での丸め処理ゼロ
- DB は全 truncate 可 (アクティブユーザー 0、 prod 含むデータ破棄)

### 11.1 同期機構の汎用性 — 既存エンティティの sync 状態整理

| Entity         | server push        | server pull           | client outbox       | cursor          | 状態 |
|----------------|--------------------|------------------------|---------------------|-----------------|------|
| cards          | `/api/card-mutations/bulk` | `/api/pull`     | `card_mutations` Dexie store | `cardsCursor` ISO | 完全双方向 |
| exams          | **なし** (action 未実装)   | `/api/pull`     | **なし**            | `examsCursor` ISO | pull のみ |
| study_days     | なし (read-only)    | `/api/study-days/pull` | なし                | なし (90 日 full-window) | snapshot |
| answer_events  | `/api/review-events/bulk` (client push) | なし | Dexie pending          | なし (event-sourced)    | client → server only |
| study_sessions | bulk 同送           | なし                  | Dexie pending       | なし            | client → server only |

**重要な発見**: **exam の rename / archive を行う server action は未実装** (`app/(app)/app/exams/_actions/` には `create-exam.ts` / `delete-exam.ts` のみ)。 exam 編集の sync 経路は **そもそも存在しない**。 つまり「top-level entity の non-create / non-delete 編集を sync する前例」 は card 以外にゼロ。

→ tag_categories.name の rename / tag_options.value の rename を sync するための **同期 outbox の前例は cards 1 種のみ**。

### 11.2 exam の sync 経路 (前例として観察)

- create: `create-exam.ts` の server action 直叩き ⇒ pull で反映
- delete: `delete-exam.ts` で `tombstones INSERT + exams DELETE` を 1 tx ⇒ pull で `bulkDelete`
- updated_at は drizzle `.$onUpdate()` で自動 set (schema.ts:259-262)
- **rename / archive UI は実装されていない**

→ 新 top-level entity (tag_categories, tag_options) を「server action 直叩き + pull」 で組むのは exam の延長として自然。 ただし **local-first 編集 (rename を打鍵中の楽観反映)** が欲しいなら新たに outbox 経路を作る必要がある。

### 11.3 tombstones の拡張性

`lib/db/schema.ts:676-693`:

```ts
entityType: text('entity_type').$type<'exam' | 'card'>().notNull(),
entityId: uuid('entity_id').notNull(),
// UNIQUE (entity_type, entity_id)
```

- `entityType` の `$type<...>` 拡張は **型のみの変更で OK** (text 列なので migration 不要、 アプリ層判定のみ)。 `'tag_category' | 'tag_option'` を足すのは機械的差分のみ。
- `entityId` は **単一 uuid 固定**。
- → tag_categories / tag_options は単一 uuid PK 想定なので **そのまま乗る**。
- → **junction (card_tags) は entity_id 単一 uuid に乗らない** ((card_id, option_id) 複合)。 これは §11.4 で扱う。

### 11.4 junction (card_tags) の表現 — 3 案

junction を既存 outbox + tombstones で扱う方法を 3 つに整理:

| 案 | outbox 形 | tombstone 要否 | 既存改修 | 評価 |
|----|------------|----------------|----------|------|
| **(a) whole-set replacement** | 既存 `op='update_field'` + `field='tag_option_ids'` + `value=optionId[]` (cards の virtual field) | 不要 (whole-array 上書きで削除を表現) | UpdateCardFieldName allowlist 追加 + buildSetClause case 追加 + server 側で diff→INSERT/DELETE junction | **最小改修**。 options 配列が既にこの pattern。 |
| **(b) junction-op** | 新 op `'card_tag_add' \| 'card_tag_remove'` を outbox に追加、 patch に `{ option_id }` 詰める | 不要 (op 自体が削除を表現) | outbox op enum 拡大、 zod 拡張、 server route 拡張、 coalesce key 改修 | (a) より複雑、 同 card 内の連続 add/remove の coalesce が非自明 |
| **(c) 並列 outbox** | `card_tag_mutations` 新 store + flush 経路 | 不要 | Dexie store 新設 (version bump)、 flush 新規実装、 endpoint 新設 | 最大改修。 card 系 outbox との一貫性が薄れる |

**OT 確定方針との整合**:
- card_tags は「常に複数紐付け、 multi 前提」 (DB は single/multi 区別しない)
- single の 1 個制約は UI 担保
- → **per-card で option_id の集合を扱う** が自然 (= (a) whole-set)。

**(a) の具体像**:
- cards の outbox に乗せる: `enqueueCardMutation({ card_id, op:'update_field', patch:{ field:'tag_option_ids', value: [optId1, optId2, ...] } })`
- coalesce key `${card_id}:update_field:tag_option_ids` で同 card の連続タグ操作を 1 mutation に畳む (options field と同じ挙動)
- server `/api/card-mutations/bulk` 受領 → `buildSetClause` の `case 'tag_option_ids'` で zod 検証 → `applyCardFieldUpdate` で `tx.delete(card_tags).where(card_id=X) ; tx.insert(card_tags).values(diff)` (whole-set replace) → `cards.updated_at` 自動 bump
- pull payload: cards stream に `tag_option_ids: number[]` (※ option_id は OT brief で「内部 ID」 と書かれており型未確定 — uuid なら `string[]`、 integer なら `number[]`) を 1 field 追加。 server 側は `LEFT JOIN card_tags ... GROUP BY` で集約
- Dexie: ClientCard に `tag_option_ids` 追加 (既存の `tags: string[]` は dead code として削除)

**(a) のトレードオフ**:
- whole-set push なので、 同 card に対する 2 端末同時操作で「先送り側の追加 / 削除が後送り側の whole-set で消える」 last-write-wins。 これは options 配列と同じ既存挙動。
- 一 card に紐づく option 数が爆発した場合 (例 100+) でも 1 mutation の payload が許容範囲なら無問題。 現実的に 10-30 程度想定で OK。
- server 側で junction の物理 DELETE+INSERT が走るため、 card_tags.updated_at 的な per-junction-row 監査は失う (junction 自体に updated_at 列を持たない設計と前提整合)。

### 11.5 tag_categories / tag_options の sync 設計

両者は「field 持ち top-level entity」 (cards / exams と同類)。 sync は以下 2 軸:

**pull (server → client)** — どちらも単純拡張で済む:
- 新 pull stream を 2 本追加 (`tag_categories`, `tag_options`)
  - server: `lib/db/tag-categories-pull.ts`, `lib/db/tag-options-pull.ts` を新設、 `getCategoriesDelta(userId, since)` / `getOptionsDelta(userId, since)` で `WHERE user_id=? AND updated_at >= ?` の incremental
  - server route: `app/api/pull/route.ts` の `Promise.all` に追加 (since_tag_categories, since_tag_options を query string で受領)
  - client: `sync_meta` key 2 個追加 (`tagCategoriesCursor`, `tagOptionsCursor`)、 `lib/sync/pull.ts` の apply 順序に挿入 (tombstones 適用前)
- Dexie store 2 個追加 (version bump、 v3)
  - `tag_categories: 'id, user_id, updated_at'`
  - `tag_options: 'id, category_id, user_id, updated_at'` (category_id index は category 配下 option 列挙の Dexie query 用)
- ClientTagCategory / ClientTagOption 型を `lib/client-db.ts` に追加

**削除伝播 (tombstones)** — `entity_type` 拡張で吸収:
- `tag_category` / `tag_option` を `$type<...>` に追加 (text 列なので migration 不要)
- 削除 server action で tombstone INSERT (exam 削除と同 pattern)
- cascade: category 削除 → 配下 option も削除 → 配下 card_tags 行も削除 (FK CASCADE)
  - tombstone は category と option それぞれ INSERT する必要あり (client 側 mirror から個別に削除するため)
  - card_tags の cascade 削除は client 側 mirror に直接は反映されないが、 §11.4 (a) で `cards.tag_option_ids` を server-side join で算出する設計なら、 categry/option 削除後の次回 cards pull で `tag_option_ids` から消えた option が自動的に落ちる ⇒ **問題なし**

**push (client → server) — local-first 編集の必要性**:
- カテゴリ名 rename / option 値 rename を打鍵中に楽観反映したいか、 が分岐点
- 楽観反映が要らない (rename は重い操作なので「保存」 ボタン押下で server action 直叩き + 後段の pull で確定) ⇒ exam パターン (action 直叩き + pull) で十分、 outbox 不要
- 楽観反映が要る ⇒ tag_categories / tag_options 用の outbox が要る
  - 最小: card_mutations を generic 化 (entity_type を追加、 entity_id 化) — 既存 card 経路の互換破壊リスク
  - 中: 並列 `category_mutations` / `option_mutations` Dexie store + flush + endpoint を card 系と同 pattern で複製 (DRY 違反だが安全)
  - 大: 「generic_mutations」 として全 top-level entity を一本化 (リファクタ大)
- **判断**: OT 方針の温度を聞きたい。 rename 頻度は低いはずなので exam パターンで十分とも言える。

### 11.6 OCR (Gemini discover) のタグ流入経路

**現在の discover 出力 shape** (`lib/ai/schemas/ocr-response.ts:52-54`):

```ts
custom_props: z
  .record(z.string(), z.union([z.string(), z.array(z.string())]))
  .optional(),
```

実例 (PoC `docs/research/ocr-schema-vs-discover.md`):
- SAT: `{ "Domain": "Reading", "Skill": ["Comprehension", "Inference"], "Skill_Sub": "Detail" }`
- IPMA: `{ "KCI": "..." }`
- nursing-114 / tourokuhanbai / 宅建: 全件 `custom_props` 自体省略 (zod optional)

**カテゴリと値の関係**: `{ "key": "value" }` フラット (key = カテゴリ、 value = 値、 配列なら multi)。

**現在の永続化経路** (`app/(app)/app/upload/_actions/process.ts:521`):

```ts
customProps: (c.custom_props ?? {}) as Record<string, unknown>,
tags: [] as string[],
```

→ Gemini 返り値が `cards.custom_props` jsonb 列にそのまま保存 (key→value のマップ)。 `tags` text[] は常に `[]` (dead code)。

**production 全件空の原因 (前回調査 D2 の特定)**:
- 配線は完全 (`process.ts:521`)
- 投入 PDF (nursing-114, 宅建, 登録販売者) に問題別の明示メタデータ無し ⇒ Gemini が `custom_props` を spec 通り省略 ⇒ DB に `{}` で保存
- **Gemini hallucination でも配線破断でもない、 prompt 仕様通りの動作**

**OT 確定方針 (毎回新規カテゴリを multi で作るだけ) への適合**:

discover 出力 1 件あたりの分解 (新 schema 想定):
```
Gemini:        { "分野": "循環器", "難度": ["高", "重要"] }
                ↓
process.ts 内 (cards bulk INSERT と同 tx 内):
  tag_categories INSERT:  
    (id=uuidv4, name="分野",  select_type='multi', user_id)
    (id=uuidv4, name="難度",  select_type='multi', user_id)
  tag_options INSERT:
    (id=uuidv4, category_id=<分野_id>, value="循環器",   user_id)
    (id=uuidv4, category_id=<難度_id>, value="高",       user_id)
    (id=uuidv4, category_id=<難度_id>, value="重要",     user_id)
  card_tags INSERT:
    (card_id, option_id=<循環器_id>, user_id)
    (card_id, option_id=<高_id>,     user_id)
    (card_id, option_id=<重要_id>,   user_id)
```

- **OT 方針「丸めない、 既存カテゴリには一切書き込まない」** に従い、 各 OCR upload 内でも問題横断で同名カテゴリを merge せず、 **問題ごとに別 id で重複作成** する判断もあり得る (極めて重複多発)。 もしくは upload 1 回内では merge し、 過去 upload とは merge しない、 等の中間案
  - これは OT 確認必要 (§11.9 論点)
- 配列値は OT 方針 (新規カテゴリは multi 固定) と整合 (`select_type='multi'`)、 単一値も同じく `multi` (UI 担保なので)

### 11.7 cards.tags / cards.custom_props の撤去スコープ

DB truncate 前提なので **コード参照箇所の改修のみ**。 並列 agent grep 集計:

| 列            | 全参照数 | 必須修正 file 数 | dead code 判定 |
|---------------|----------|--------------------|----------------|
| `cards.tags`  | 14       | ~10                | **完全 dead code** (書込経路ゼロ、 INSERT で `[]` 固定、 mapper/型/test fixture のみ) |
| `cards.custom_props` | 38 | ~20                | active (OCR write 経路 + UI 表示) ⇒ 新 schema 移行に伴う改修対象 |

**custom_props の active 経路 (撤去時に新 schema へ振替が要る箇所)**:
- OCR pipeline: `lib/ai/schemas/ocr-response.ts`, `lib/ai/ocr.ts`, `lib/ai/prompts/ocr-extract.ts`, `app/(app)/app/upload/_actions/process.ts:521`
- 表示 UI: `app/(app)/app/upload/result/[sourceDocumentId]/page.tsx:54-55` の `customPropKeys.join(', ')` レンダ
- list query: `lib/exams/list.ts:74, 171, 188-191` の `customPropKeys` 抽出
- mapper / 型 / test fixture 多数

撤去後の置換先:
- OCR pipeline: §11.6 の分解ロジックで tag_categories / tag_options / card_tags へ
- 表示 UI / list: 新しい `card.tag_option_ids` (cards 集約 payload) または category/option store からの集約結果

詳細 file:line 表は並列 agent C 出力に網羅 (本 doc には貼らず引用のみ)。

### 11.8 Feasibility 判定 — 確定方針は既存ルートに素直に乗るか

**結論: 素直に乗る**。 ただし以下の前提を満たす範囲で。

#### (i) tag_categories / tag_options (field 持ち top-level entity)

| 経路        | 現状の準備 | 必要な追加 | 困難度 |
|-------------|------------|------------|--------|
| pull        | ○ (cards/exams が前例)| pull stream 2 本 + cursor key 2 個 + mapper 2 個 + apply 順序追加 | 低 (機械的) |
| tombstones  | ○ (text 列の `$type<...>` 拡張で済む) | entity_type 拡張のみ、 migration 不要 | 低 |
| Dexie       | ○ (version bump 前例あり、 study_days で v2 実績) | store 2 個追加 + 型 2 個 + version 3 | 低 |
| server CRUD | ○ (exam create/delete が前例) | server action 4 個 (create / rename / delete × 2 entity)、 ただし rename は exam にも未実装 | 中 (rename は前例なし) |
| local-first push | △ (cards のみ前例、 exam も持たない) | rename を local-first にするなら別 outbox 設計が要る、 不要なら exam パターンで OK | OT 判断次第 |

#### (ii) card_tags (junction)

| 経路        | 評価 |
|-------------|------|
| outbox      | ○ 既存 card outbox に **whole-set field として相乗り可能** (§11.4 案 a)。 `field='tag_option_ids'` 追加 (UpdateCardFieldName + buildSetClause、 機械的 ~30 行) |
| tombstones  | **不要** (whole-set 上書きで削除を表現、 cascade も上位 entity の tombstone で吸収) |
| Dexie       | cards store の row shape に `tag_option_ids: number[]` (or `string[]`) 追加のみ。 store / index 追加不要 |
| pull        | cards-mapper.ts に LEFT JOIN + GROUP BY で集約した `tag_option_ids` を追加。 cards stream payload 1 field 増 |
| server apply | `applyCardFieldUpdate` の `case 'tag_option_ids'` で `tx.delete(card_tags).where(card_id=X) + tx.insert(card_tags).values(diff)` (whole-set replace) |

#### (iii) OCR fire-and-forget 流入

| 経路        | 評価 |
|-------------|------|
| 分解処理    | `process.ts` の cards bulk INSERT と同 tx 内に tag_categories / tag_options / card_tags の bulk INSERT を追加 (`pipelineResult.cards.flatMap` で抽出) |
| 既存 custom_props | DROP (or 別 sprint で残置)。 OCR 出力 zod schema は変更不要 (Gemini からの shape は不変)、 process.ts の分解ロジックだけ書き換え |
| prompt 改修 | **不要** (OT 明言)。 既存 discover 出力 (`Record<string, string|string[]>`) はそのまま使える |

### 11.9 OT 判断必要な論点

A. **tag_categories / tag_options の local-first push 要否**
- 案 1 (薄): exam パターン (server action 直叩き + pull 反映)。 rename / delete の打鍵に対し最初の保存だけ往復待ち、 その後 pull で確定
- 案 2 (厚): 新 outbox 経路 (card_mutations を generic 化 or 並列 outbox)。 楽観反映でレスポンシブ
- card は §11.4 (a) で既存経路に相乗りなので、 (1)(2) の判断はあくまで category/option 自体の rename UX 設計

B. **OCR 分解時の merge 粒度**
- (i) **全く merge しない** (OT brief の字義通り): 1 upload 内の 30 問が全て「分野」を出すと、 `tag_categories` に "分野" が 30 行 (別 id) 生まれる
- (ii) **同 upload 内では merge する** (key 名 + value 名で 1 upload 内ユニーク化): 1 upload に "分野=循環器" が 30 問にあれば、 category × 1 / option × 1 / card_tags × 30
- (iii) **value のみ既存 reuse** (key は毎回新規、 value は既存 option があれば reuse): 中間
- OT brief は (i) のように読める (「丸め処理は不要」 と明言) が、 (i) だとカテゴリ master が即爆発するので運用に耐えるか確認したい

C. **option_id の型**
- OT brief「カテゴリは内部 ID で識別」 — uuid か integer か未確定。 既存 entity は全 uuid なので **uuid 推奨** (tombstones entity_id と整合)

D. **`cards.tags text[]` の即時撤去か据置か**
- 撤去: 完全 dead code、 14 参照、 schema migration 1 件
- 据置: 残しても害なし (全件 `[]`)
- 同 sprint 内で撤去推奨 (混乱回避)

E. **whole-set push の容量懸念**
- 1 card に option 数が増えた場合、 1 mutation の payload に `tag_option_ids: int[]` が乗る。 100 options / card で 1KB 程度 (許容範囲)。 1000 超想定なら別設計

### 11.10 必要な最小新規部品 (確定方針を素直に乗せる構成)

```
schema 変更:
  + tag_categories table
  + tag_options table
  + card_tags table (junction)
  + tombstones.entity_type 拡張 ('tag_category', 'tag_option') — text 列なので migration 不要、 型のみ
  - cards.custom_props 列 + cards_props_gin_idx (DROP)
  - cards.tags text[] (DROP)

server-side:
  + lib/db/tag-categories-pull.ts (getCategoriesDelta + mapper)
  + lib/db/tag-options-pull.ts (getOptionsDelta + mapper)
  + lib/db/cards-mapper.ts に tag_option_ids 集約を追加 (LEFT JOIN GROUP BY)
  + app/api/pull/route.ts に since_tag_categories / since_tag_options を追加
  + app/(app)/app/tags/_actions/* (create/rename/delete × 2 entity = 4-6 server actions)
  + lib/cards/apply-card-mutation.ts の UpdateCardFieldName に 'tag_option_ids' 追加
  + buildSetClause case + applyCardFieldUpdate に junction whole-set replace ロジック
  + app/api/card-mutations/bulk/route.ts (route 自体は無修正、 patch 検証 zod のみ)
  + app/(app)/app/upload/_actions/process.ts の OCR 分解ロジック (cards INSERT と同 tx)

client-side:
  + lib/client-db.ts に ClientTagCategory / ClientTagOption 型 + store + version bump (v3)
  + lib/client-db.ts の ClientCard に tag_option_ids: string[] (or number[])
  + lib/sync/sync-meta.ts に tagCategoriesCursor / tagOptionsCursor key 追加
  + lib/sync/pull.ts に新 stream 2 つの apply (tombstones 適用前)
  + tag manager UI (新規)
  + card 編集 UI のタグ pill / popover (新規)

撤去 (DB truncate なので code のみ):
  - cards.tags / cards.custom_props の参照 ~30 file (§11.7)
```

migration は 1 本 (DROP 2 列 + CREATE 3 table)。 tombstones は ALTER 不要。 Dexie は v3 へ bump。

---

## 12. 同期エンジンの駆動方式・新エンティティ追加コスト・card 移動 (2026-06-05 追補)

§11 続編。 (1) 同期 push/pull 関数 chain、 (2) sync_status の実体、 (3) タグ表が相乗りできるか、 (4) card の試験間移動、 を事実ベースで網羅。

### 12.1 push の関数 chain (card 編集 → server 着弾)

| stage | 関数 | file:line | 役割 |
|------|------|-----------|------|
| 1 | UI commit | `app/(app)/app/exams/[id]/_components/inline-option-row.tsx:196-219` | mirror 直書き + `enqueueCardMutation()` 呼出。 immediateDrain フラグで debounce 制御 |
| 2 | `enqueueCardMutation()` | `lib/sync/card-mutations.ts:68-108` | coalesce key で pending row 検索 → 既存あれば last-write-wins で update、 なければ add (`sync_status: 'pending'`) |
| 2' | `coalesceKey()` | `lib/sync/card-mutations.ts:45-53` | `${card_id}:${op}[:${field}]` — **card_id を文字列に hardcoded** |
| 3 | `scheduleDrain()` | `inline-option-row.tsx:153-161` | 500ms debounce で `runGuardedCardMutationFlush` schedule (immediate は 0ms) |
| 4 | `runGuardedCardMutationFlush()` | `lib/sync/card-mutation-flush.ts:57-85` | Web Locks `CARD_MUTATION_FLUSH_LOCK_NAME` を `ifAvailable:true` で取得、 取れなければ skip (queue しない) |
| 4a | `flushAllPendingCardMutations()` | `lib/sync/card-mutations.ts:241-318` | `getPendingCardMutations()` (`where('sync_status').equals('pending').toArray()`) → in-flight Set 除外 → `markCardMutationsAttempted()` → POST `/api/card-mutations/bulk` → 成功分 `'synced'` modify、 失敗分 pending 残置 |
| 5 | bulk endpoint | `app/api/card-mutations/bulk/route.ts:314-373` | auth → zod parse → per-mutation tx → op 別 apply (`update_field`/`create`/`delete`) → log INSERT → `{applied, failed}` response |
| 6 | server apply | `lib/cards/apply-card-mutation.ts` 各種 | UPDATE/INSERT/DELETE + tombstone INSERT (delete のみ) + exam.cardCount 増減 (create/delete のみ) + cards.updated_at bump |

冪等防衛 3 重: ① server `mutation_id` UNIQUE / ② client in-flight Set / ③ Web Locks。

### 12.2 pull の関数 chain (cursor → delta → Dexie tx)

| stage | 関数 | file:line | 役割 |
|------|------|-----------|------|
| 1 | trigger | `exam-detail-pull-gate.tsx` useEffect、 `card-mutation-flush-trigger.tsx`、 `review-flush-trigger.tsx`、 `lib/sync/pull-back.ts:19-22` | page mount / flush 後 / visibility change で `runGuardedPull()` 起動 |
| 2 | cursor 読込 | `lib/sync/pull.ts:80-84` | `Promise.all([getSyncMeta(cardsCursor), examsCursor, tombstoneCursor])` → 各 ISO string |
| 3 | server fetch | `pull.ts:86-97` | `URLSearchParams` で `since_cards / since_exams / since_tombstone` 構築 → `GET /api/pull?...` |
| 4 | server delta | `app/api/pull/route.ts:63-79` | `Promise.all([getCardsDelta, getExamsDelta, getTombstonesDelta])` 並行実行 |
| 4a | delta SQL | `lib/db/cards-pull.ts:20`, `exams-pull.ts:27`, `tombstones-pull.ts:28` | `WHERE user_id=? [AND updated_at\|deleted_at >= ?]` (since inclusive)、 ORDER BY なし、 LIMIT なし |
| 5 | mapper | `cards-mapper.ts:16-49` 等 | server row (Date) → client (ISO string) + `sync_status: 'synced'` 固定 |
| 6 | Dexie tx | `pull.ts:120-144` | `db.transaction('rw', [cards, exams, sync_meta], async () => { bulkPut → bulkPut → tombstones filter+bulkDelete → cursor put })` 1 atomic tx |
| 7 | cursor 更新 | `pull.ts:138-143` | `maxIso(rows.map(updated_at))` を `sync_meta.put({key, value})` 同 tx 内 |

study_days は別 endpoint `/api/study-days/pull` + 別 Dexie tx (`lib/sync/study-days.ts:51-76`、 90 日 full-window replace、 cursor なし)。 `pull-back.ts:19-22` で 2 関数を fire-and-forget で同時起動。

### 12.3 新エンティティを pull に追加する具体差分

`tag_categories` を pull stream として足すコスト (cards-pull.ts 雛形と比較):

| file | 修正 | 行数 |
|------|------|------|
| 新規 `lib/db/tag-categories-pull.ts` | `getCategoriesDelta(userId, since)` + mapper | ~30 |
| `app/api/pull/route.ts` | `Promise.all` に追加、 query param zod 拡張、 response body 拡張 | ~5 |
| `lib/sync/sync-meta.ts` | `SYNC_META_KEYS.tagCategoriesCursor` 1 行 | 1 |
| `lib/client-db.ts` | ClientTagCategory 型 + Dexie store + `version(3).stores({...})` | ~10 |
| `lib/sync/pull.ts` | type + Promise.all + URLSearchParams + shape check + tx stores 拡張 + bulkPut + cursor put | ~13 |
| 新規 `lib/db/tag-categories-pull.test.ts` | delta テスト | ~50 |

**1 stream あたり ~80 行実装 + ~50 行 test**。 tag_options も同型なので **2 stream で実装 ~160 行**。

### 12.4 sync_status の実体 (store 別駆動方式)

| store | sync_status | 駆動方式 | 判定 |
|-------|-------------|----------|------|
| cards | 'synced' 固定 (pull mapper `cards-mapper.ts:48`)、 手動作成時のみ 'pending' (`build-new-client-card.ts:65`) だが **read 経路ゼロ** | 同期は card_mutations outbox 経由、 cards.sync_status は **dead field** (v1.x 予約) | **未使用** |
| card_mutations | active outbox | enqueue 時 'pending'、 flush 時 `where('sync_status').equals('pending')` で抽出、 成功時 'synced' modify | **真の outbox** |
| answer_events | active outbox 兼用 | event 発生時 'pending' で insert、 flush は `getPendingAnswerEvents()` (同上 query) | event-store-as-outbox |
| study_sessions | active outbox 兼用 | session 開始/完了/放棄ごとに 'pending' upsert、 全 event が synced になったら session も 'synced' | event-store-as-outbox |
| exams / user_settings / sync_meta / study_days | カラム自体なし | pull-only mirror | read-only |

**核心**: cards / answer_events / study_sessions は **「sync_status を持つ store では Dexie secondary index `sync_status` を `equals('pending')` で query するのが flush 抽出パターン」** で統一されている。 ただし **cards だけは sync_status を read していない** (mutation outbox を介して同期)。

「sync_status を付ければ既存ロジックが勝手に差分同期する」 仮説は **半分真**: store に index を付け、 enqueue 関数で 'pending' insert し、 flush 関数で `where('sync_status').equals('pending')` を呼ぶ pattern は確立しているが、 **trigger (debounce / 演習完了 / page mount 等) は store ごとに明示配線必須**。 既存「自動化」 は存在しない。

cards 同期を実際に駆動しているのは **outbox enqueue (`card_mutations.add()`)**、 sync_status ではない。

### 12.5 タグ表 (top-level entity) が既存 push/pull に相乗りできるか

#### (i) pull 側 — 素直に相乗り可能

cards/exams の前例どおり stream 追加で済む (§12.3、 1 stream あたり ~80 行)。 tombstones は entity_type 拡張のみ (text 列なので migration 不要、 型のみ)。

#### (ii) push 側 — card_mutations の card 固有度が高すぎる

`lib/db/schema.ts:647-669` の `card_mutations` の card 専用部:

```ts
cardId: uuid('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
```

- **`cardId` NOT NULL FK** — card 以外の entity を入れられない (NOT NULL は最大の縛り)
- coalesce key `${card_id}:${op}[:${field}]` (`card-mutations.ts:45-53`) — card_id 文字列 hardcoded
- bulk endpoint (`app/api/card-mutations/bulk/route.ts`) の零細結合:
  - `updateFieldPatchSchema` (line 72-81): field enum が card-specific (`'title'|'sort_key'|...`)
  - `createPatchSchema` (line 87-111): `exam_id` FK + `CardOption[]` 構造
  - `processMutation()` (line 165-305): delete/create/update_field の 3 分岐がそれぞれ `applyCardDelete/applyCardCreateWithId/applyCardFieldUpdate` を呼ぶ
- 「**card 専用 outbox + card 専用 endpoint + card 専用 apply 関数群**」 が深く結合

#### (iii) 3 案の比較

| 案 | 概要 | コード根拠 | 影響範囲 | 推奨度 |
|----|------|-----------|----------|--------|
| **(A) generic 化** | `card_mutations` の `cardId` → `entityType + entityId`、 op enum 拡張、 coalesce key generic 化、 bulk endpoint を switch 化 | `schema.ts:647-669`、 `card-mutations.ts:45-53`、 `bulk/route.ts:122-305` 全面改修 | 250-300 行の破壊的改修、 既存 card 経路の全 regression テストが必要、 migration で `card_mutations` の `cardId` NOT NULL FK を緩める必要あり | × |
| **(B) 並列 outbox** | `tag_category_mutations` / `tag_option_mutations` を新規 Dexie store + server table、 flush 関数を card_mutations と同 pattern で複製、 endpoint も新規 | 既存 `card-mutations.ts` 構造を丸ごとコピー、 ~400 行新規 (DRY 違反だが、 card 経路は無傷) | 既存 cards 経路 0 改修、 新規実装中心 | △ |
| **(C) server action + pull** | tag_category / tag_option の create/rename/delete は server action 直叩き、 client は server action 完了後に `runGuardedPull()` で反映 | exam (create-exam / delete-exam) と同 pattern、 outbox なし | 最小実装 (server action 4-6 個 + UI)、 ただし楽観反映なし → 数百 ms の rename 遅延 | ○ |

#### (iv) 推奨

**(C) server action + pull**。 理由:

1. **rename / delete 頻度が低い**: tag_category / tag_option の編集は card 編集 (1 タップ単位) と性質が異なり、 「ユーザーが意図的に管理画面で実行」 する低頻度操作。 500ms 待つ rename は許容範囲。
2. **既存 exam が同 pattern**: exam の create / delete も server action 直叩き + pull。 tag entity を exam と同じ pattern で乗せると **既存設計の延長で済む**。
3. **将来 (B) への拡張余地**: もし local-first 編集が必要になったら、 後から並列 outbox を 1 セット (tag_category_mutations or tag_option_mutations) 増やせる。 (A) generic 化と違い破壊的でない。
4. **junction (card_tags) は §11.4 (a) で card outbox に相乗り**: card のタグ付け / 解除は high-frequency UI なので、 既存 card outbox の whole-set field として乗せる (`field='tag_option_ids', value=int[]`)。 (C) との組み合わせで「タグマスター編集 = server action、 card のタグ付与 = 既存 outbox 相乗り」 と役割分担できる。

つまり、 **タグ機能全体の同期構成**:
- **tag_categories / tag_options master**: server action + pull (3 stream に乗る pull のみ、 outbox なし) ← 案 (C)
- **card_tags junction**: cards outbox に whole-set 相乗り (§11.4 a) ← 既存改修最小
- **OCR 分解**: server-side で process.ts に分解 INSERT を追加、 上記両経路の delta で client に届く

実装コスト概算:
- pull 側: tag_categories stream + tag_options stream で ~160 行
- server side: tag_category / tag_option の create / rename / delete server action 4-6 個 (~150 行)
- card_tags 相乗り: UpdateCardFieldName 拡張 + apply 関数の whole-set replace logic ~50 行
- OCR 分解 (`process.ts`): ~50 行
- Dexie store 追加 + 型: ~30 行
- UI (tag manager + card のタグ pill / popover): 別工程

合計 ~440 行 + UI、 (B) 並列 outbox 案 (~400 行 push 一式) より総量は近いが **既存 cards 経路を 0 触る** 安全性が高い。

### 12.6 card の試験間移動 (exam_id 変更)

#### (i) cardCount の管理経路 (全箇所)

| event | file:line | 操作 | tx |
|-------|-----------|------|----|
| card create (mutation) | `lib/cards/apply-card-mutation.ts:316-320` | `cardCount + 1` (created=true のみ) | ✓ 同 tx |
| OCR bulk INSERT | `app/(app)/app/upload/_actions/process.ts:535-544` | `cardCount + N`、 **`updatedAt: sql\`${exams.updatedAt}\`` で据え置き** | ✓ 同 tx |
| card delete (mutation) | `lib/cards/apply-card-mutation.ts:379-382` | `cardCount = GREATEST(cardCount - 1, 0)`、 updatedAt 据え置き | ✓ 同 tx |

**重要慣習**: cardCount の増減で **exam.updated_at を bump しない** (process.ts comment: 「試験一覧の updatedAt DESC 順を card 増減で乱さないため」)。

#### (ii) cards.exam_id 変更経路の有無

grep 結果: **0 件**。 `update(cards).set({ examId: ... })` は schema 内に存在しない。 `UpdateCardFieldName` (`apply-card-mutation.ts:35-41`) にも `'exam_id'` は含まれない。

schema constraint (`schema.ts:286-288`):
```ts
examId: uuid('exam_id').notNull().references(() => exams.id, { onDelete: 'cascade' }),
```
ON UPDATE CASCADE なし ⇒ exam_id は **任意に変更可能** (FK 整合は移動先 exam_id が実在することのみ要求)。

#### (iii) UpdateCardFieldName 拡張案の問題

`'exam_id'` を allowlist に足し `buildSetClause` で case 追加するだけでは **不十分**。 理由:

- `applyCardFieldUpdate` (`apply-card-mutation.ts:157-173`) は cards 1 行の UPDATE しかしない
- exam 移動には **両 exam の cardCount 増減** (from -1 / to +1) が要る → 別 logic が必要
- `applyCardFieldUpdate` の戻り値は UPDATE 後の examId のみ。 移動元 examId (旧値) を返していない → bulk route 側で旧値を取れない
- 戻り値を `{ examId, oldExamId }` に拡張するパッチも泥臭い

#### (iv) 推奨: 専用 `move` op

outbox `op` enum に `'move'` を追加し、 patch を `{ from_exam_id, to_exam_id }` とする:

```
client outbox:
  op: 'update_field' | 'create' | 'delete' | 'move'
  patch (move): { from_exam_id: uuid, to_exam_id: uuid }
  coalesce key (move): `${card_id}:move` ← 連続 move は最後勝ち
server apply (新規 applyCardMove(tx, cardId, userId, { fromExamId, toExamId })):
  1. SELECT card.examId WHERE id=cardId AND userId=? — 旧 examId 取得 + owner scope
  2. fromExamId と一致確認 (mismatch なら失敗)
  3. SELECT exams WHERE id=toExamId AND userId=? — 移動先存在 + owner 確認
  4. UPDATE cards SET examId=toExamId, updatedAt=now() WHERE id=cardId AND userId=?
  5. UPDATE exams SET cardCount=GREATEST(cardCount-1,0), updatedAt=updatedAt WHERE id=fromExamId AND userId=?
  6. UPDATE exams SET cardCount=cardCount+1, updatedAt=updatedAt WHERE id=toExamId AND userId=?
  ※ 4-6 全て同 tx 内
```

差し込み点: `app/api/card-mutations/bulk/route.ts` の `processMutation()` (`route.ts:351-371`) に 4 個目の op 分岐を追加。

#### (v) exam_id 不変の暗黙前提 — 抵触箇所と評価

| 箇所 | 評価 |
|------|------|
| Dexie client query `db.cards.where('exam_id').equals(examId)` (`inline-card-list.tsx:78`) | ✅ 問題なし。 pull が新 examId で bulkPut すれば useLiveQuery が自動再評価、 旧 exam view から消えて新 exam view に出現 |
| server query `WHERE examId=?` for sortKey 採番 (`process.ts:204-208`) | ✅ 問題なし。 移動先 exam に対する採番なので独立 |
| index `cards_sort_idx` `cards_exam_idx` `cards_answered_idx` (`schema.ts:347-363`) | ✅ PG が自動再構成 |
| index `cards_user_updated_id_idx` | ✅ exam_id 含まずなので影響なし |
| **`source_documents.examId`** | ⚠️ 設計判断必要。 OCR 由来 card は `cards.source_document_id` で source_documents を参照、 source_documents は exam に紐づく (`sourceDocuments.examId` FK)。 移動後、 card が exam B に属しながら source_documents は exam A 紐付きのまま — schema は禁止していない。 (1) source_documents を移動先に re-parent / (2) 据え置く / (3) NULL 化 の 3 案。 推奨は **(2) 据え置き** (OCR 歴史の正確性、 schema 制約も許容) |
| pull cursor | ✅ card.updated_at bump で cards stream cursor が進み、 新 examId で client に届く。 ただし exam.updated_at は cardCount 変更で bump しない設計 ⇒ 両 exam の cardCount は **次に exam 自体に変更があるまで client mirror が古い値のまま残る** ⚠️ |
| client 側 cardCount 表示 (`inline-card-list.tsx:171` の `cards.length`) | ✅ cards mirror から count しているため、 cardCount 列に依存していない。 移動で `where('exam_id')` の hit 数が変わり自動で正しくなる |
| tombstones | ✅ 不要 (削除ではない) |
| studySessions / answerEvents / reviews | ✅ card_id FK のみで exam_id 直接保持なし、 影響なし |

**注意点**: exam.cardCount は denormalized cache。 client mirror の cardCount は **stale になり得る** が、 client UI が cards mirror 行数から count している限り見た目は正しい。 ただし `db.exams.get(examId).cardCount` を直接表示している箇所があれば乖離が見える可能性 — 要 grep (本調査未確認)。

#### (vi) UI 現状

`app/(app)/app/exams/[id]/page.tsx` / `inline-card-list.tsx` に **move ボタンなし**。 移動先 exam selector も未実装。 client 側に全 exam list は Dexie `db.exams.toArray()` で取得可能 (既に pull で同期されている)。

### 12.7 結論サマリ

1. **同期エンジンの実体**: push は outbox enqueue 駆動、 pull は cursor + delta 駆動。 sync_status は store ごとに駆動方式が違い、 cards だけは dead field (mutation outbox 経由)。
2. **新エンティティの pull 追加コスト**: 1 stream あたり ~80 行で素直に拡張可能。
3. **タグ表の同期**: card_mutations は card 固有度が高く generic 化は破壊的。 推奨は **(C) server action + pull (exam パターン踏襲) + 案 (a) card_tags は card outbox に whole-set 相乗り** の組合せ。
4. **card 移動**: 専用 `move` op が推奨 (UpdateCardFieldName 拡張は cardCount 2 exam 同時調整ができず不格好)。 schema 上の障壁ゼロ、 source_documents の re-parent / 据え置きの判断のみ要。

---

## 13. exam.cardCount UI 表示 / source_documents.examId 依存箇所の確認 (2026-06-05 追補)

§12 の追加 grep。 card 移動 (exam_id 変更) で壊れる箇所の有無を裏取り。

### 13.1 exam.cardCount を UI 表示で読む箇所

**結論: 表示で `ClientExam.card_count` (Dexie 直列) を読む箇所は なし**。 すべて cards mirror の行数から動的集計。

根拠:

- **試験一覧** (`app/(app)/app/exams/_components/exam-list-live.tsx`):
  - 9-11 行 comment: 「card_count は exams.card_count を使わず cards mirror から動的集計する。 これにより server 側の非正規化列との整合性ズレを気にしない local-first な表示が可能」
  - 27-48 行: `db.exams` と `db.cards` を並列取得、 `countByExam` Map を `c.exam_id` で集計、 出力 object の `cardCount: countByExam.get(e.id) ?? 0` で詰め直す
  - 102 行 `カード {exam.cardCount} 件` の `exam.cardCount` は **47 行の local computed value** であり、 `ClientExam.card_count` ではない

- **詳細 page** (`inline-card-list.tsx:97-98` comment): 「card_count は exam list / 詳細 header いずれも mirror の card 行数で算出するため、 mirror への insert がそのまま件数表示に反映される (exam.card_count は別 bump しない)」

- **delete 経路** (`delete-card-button.tsx:12` comment): 「exam.card_count は別 decrement しない。 真の確定値は server 適用後の pull-back で収束」

- **server-side**: `cardCount` は INSERT/UPDATE のみ (`apply-card-mutation.ts:226, 317, 380`、 `process.ts:538`)、 SELECT して表示返却する server query は **無し** (`lib/exams/list.ts` 内にも該当 SELECT なし)

- **mapper** (`lib/db/exams-pull.ts:20`): `card_count: row.cardCount` で client mirror に書き込んではいる ⇒ **持っているが UI で読まない** dead-ish field 状態

**含意**: card 移動で server 側の `exam.cardCount` 整合 (from -1 / to +1) を完全に省略しても、 UI 表示は壊れない。 ただし server 側で integrity を保つ価値は別にある (server-only query / 監査 / 将来の API 提供時の正しさ) ので applyCardMove で 2 exam の cardCount を増減する設計は維持推奨。

→ §12.7 の論点 D 「cardCount client mirror stale」 は **実害なしと確定**。

### 13.2 source_documents.examId への依存箇所 (OCR 取込経路を除く)

**結論: card 移動時に source_documents を触る必要は なし** (据え置きで cosmetic な副作用のみ)。

OCR 経路 (`app/(app)/app/upload/_actions/process.ts`、 `app/(app)/app/upload/_components/upload-form.tsx`、 `lib/ai/ocr.ts`) と schema/migration を除いた、 source_documents.examId 依存箇所:

| file:line | 用途 | card 移動で壊れるか |
|-----------|------|---------------------|
| `lib/exams/list.ts:141-149` (`getSourceDocumentForUser`) | OCR result page で「この source_document の親 exam 名」 を取得 (INNER JOIN exams ON exams.id = sourceDocuments.examId) | **壊れない** (source_doc → exam の参照を辿るだけ、 card.examId 不介在) |
| `lib/exams/list.ts:160-181` (`getCardsForSourceDocument`) | OCR result page で「この source_document が抽出した cards 一覧」 を取得 (WHERE cards.sourceDocumentId = ?) | **壊れない**。 ただし「移動後 card が混じる」 cosmetic 副作用 ⇒ 移動した card は依然この source_doc の抽出物として正しく現れる |
| `lib/exams/source-doc-status.ts:114-121` (`getSourceDocumentStatusMap`) | 試験一覧の処理中 / 失敗バッジ表示用、 exam ごと最新 source_document の status を DISTINCT ON で取得 | **壊れない** (source_documents.examId は不変、 card 移動とは独立軸) |
| `app/api/exams/status/route.ts:59-66` (同上 API route 版) | 同上 | **壊れない** |
| `drizzle/migrations/0000_keen_the_hunter.sql:147` | `source_documents.exam_id FK → exams.id ON DELETE CASCADE` 制約 | exam 削除で source_documents が連鎖削除されるが card 移動とは独立 |
| `drizzle/migrations/0006_wet_lady_deathstrike.sql:3`、 `0008_safe_swarm.sql:1` | `source_docs_exam_idx` 等の index | query 高速化用、 移動と独立 |

**cosmetic な副作用** (機能破壊はないが、 移動後に発生し得る状態):

1. **OCR result page の表示揺れ**: 移動した card は `getCardsForSourceDocument` の結果に残るため、 result page では「投入先 exam 名 = 移動元 (exam A)」 と表示されつつ、 当該 card は実際には exam B に属する状態になる。 ユーザー UX としては「OCR 履歴」として整合 (OCR 実行時点では exam A に投入された) なので妥当。
2. **移動元 exam 削除時の source_document_id NULL 化**: exam A を削除すると `source_documents.exam_id` の FK CASCADE で source_documents 行が消える ⇒ `cards.source_document_id` の FK ON DELETE SET NULL で **移動済み card (exam B 所属) の source_document_id が NULL になる**。 出自記録は失われるが card 自体は exam B に生存し続ける。 これは「OCR 出自を残したいなら exam を delete せず archive 推奨」 という既存の archive 機能 (`exams.archivedAt`) の使い分けに帰着。

→ §12.6 の論点 「(2) 据え置き推奨」 を裏付け。 source_documents を re-parent (UPDATE source_documents.exam_id) する案を採るには 上記 cosmetic を回避する追加実装になるが、 そこまでの必要性は無い。

---

## 14. push の汎用化 — 設計案・移行・推奨 (2026-06-05 追補)

§11/§12 続編。 同期がドメインごとに散らかる将来 (タグ、 画像、 ...) を防ぐため、 push を 1 本の汎用 entity-mutations に統合できるか検討。

### 14.1 既存 push 経路の完全カタログ

| 経路 | Dexie outbox | sync_status active | flush trigger | 冪等鍵 | Web Lock | retry/backoff | 失敗時 |
|------|--------------|---------------------|----------------|--------|----------|----------------|--------|
| card inline edit | `card_mutations` | `'pending'→'syncing'→'synced'` | 500ms debounce + mount/online/visibility | `mutation_id` UNIQUE | `recallmint:card-mutations:flush` | controller あるが backoff 未実装 | pending 残置 |
| answer events | `answer_events` 自身が outbox | 同上 | 演習完了 / mount / online | `event_id` UNIQUE | `recallmint:review-events:flush` | ExponentialBackoff 5 段階 (10s/30s/1m/5m/15m) | pending 残置 + 24h で `'failed'` 隔離 |
| study sessions | `study_sessions` 自身 | 同上、 全 event 同期完了で session も synced 化 | answer events と共送 | session_id PK | 同上 | 同上 | 同上 |
| exam create / delete | なし | — | server action 直叩き | tombstone INSERT は `onConflictDoNothing` | — | — | server action error throw |
| OCR upload (process.ts) | なし | — | server action 直叩き (multipart upload) | cards INSERT は `ON CONFLICT DO NOTHING` | DB advisory lock | — | markFailed + Discord notify |

主要発見:
- **mutation-driven (coalesce)** = card_mutations 1 種のみ
- **event-sourced (append-only)** = answer_events / study_sessions
- **server action 直叩き** = exam create/delete、 OCR upload (これは local-first 範疇外、 通信を伴う必須往復)

### 14.2 card-mutations の card 密結合点 (引用付き)

generic 化の際にどこを変える必要があるか:

**server schema** (`lib/db/schema.ts:647-669`):
```ts
cardId: uuid('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
```
→ `entityId uuid notNull` に generic 化、 `entityType text notNull` を追加、 FK は削除 (entity_type ごとに対象 table が異なるため)。 cascade は client mirror 側で tombstone 経由で表現。

**client schema** (`lib/client-db.ts:146-155`):
```ts
export type ClientCardMutation = {
  card_id: string
  op: 'update_field' | 'create' | 'delete'
  ...
}
// Dexie: card_mutations: '++local_id, mutation_id, card_id, sync_status'
```
→ `entity_id` + `entity_type` フィールド追加、 Dexie index は `'++local_id, mutation_id, entity_type, entity_id, sync_status'` 複合に。

**coalesce key** (`lib/sync/card-mutations.ts:45-53`):
```ts
return `${input.card_id}:update_field:${input.patch.field}`  // または
return `${input.card_id}:${input.op}`
```
→ `${entity_type}:${entity_id}:update_field:${field}` 形に generic 化。 logic 自体は entity-agnostic で済む (key 構築のみ entity_type を prefix)。

**flush** (`lib/sync/card-mutation-flush.ts:25`):
```ts
const CARD_MUTATION_FLUSH_LOCK_NAME = 'recallmint:card-mutations:flush'
```
→ `recallmint:entity-mutations:flush` に rename、 全 entity 共有 1 lock。 entity_type ごとに lock を分けるか統一するかは後述 §14.4 で議論。

**bulk endpoint** (`app/api/card-mutations/bulk/route.ts`):
- `updateFieldPatchSchema` の field enum: `['title', 'sort_key', 'question_text', 'explanation_text', 'memo', 'options']` (line 72-81) → entity_type 別 field enum を持つ registry に置換
- `createPatchSchema` の field 一式 (line 87-111) → entity_type 別 create schema
- `processMutation` の op 分岐 → `(entityType, op) → applyFunction` の dispatch table
- per-op apply 関数 (`applyCardFieldUpdate` / `applyCardCreateWithId` / `applyCardDelete`) → entity_type ごとに同 signature の関数を registry 登録

**apply 関数群** (`lib/cards/apply-card-mutation.ts`):
- `UpdateCardFieldName` enum: card-specific
- `buildSetClause` switch: card-specific
- `correctAnswerIds` 再生成: card-specific 不変条件
- `applyCardCreateWithId`: exam owner check + cardCount +1 (card-specific cascade)
- `applyCardDelete`: tombstone INSERT + cards DELETE + cardCount -1 (card-specific cascade)

→ apply 関数は **entity_type ごとに完全に異なる**。 generic 化しても「dispatch だけ generic、 中身は entity_type 別」 になる。

### 14.3 review-events の構造 (event-sourced) — 統合射程に入れるか

**統合しない**を推奨する根拠:

| 観点 | mutation-driven (card_mutations) | event-sourced (answer_events) |
|------|-----------------------------------|---------------------------------|
| 書込モデル | coalesce で last-write-wins (mutable log) | append-only (immutable log) |
| coalesce key | `entity_id + field` 単位で畳む | 畳まない (全 event 保持) |
| 親子関係 | 親なし (card flat) | session (親) + events (子)、 session 完了で連鎖 |
| flush trigger | edit ごとに debounce | 演習完了 / page mount |
| retry | controller あるが backoff 未実装 | 5 段階 ExponentialBackoff |
| server apply | per-mutation tx、 op 別 dispatch | 1 tx 内で session + events + reviews + study_days + FSRS replay (多 phase) |

→ data model が根本的に異なる (mutable coalesce log vs immutable event log)。 1 channel に統合すると dispatch 層に「coalesce する / しない」 分岐が入り observability も統合 logger に混ざる。 性質の違うものを同居させる **abstraction cost > 統一の利得**。

**結論**: 「汎用 entity-mutations」 は **mutation-driven path のみ** を対象とする。 card / tag_category / tag_option / 将来の image (これも entity field を mutable に編集する想定なら) を相乗りさせる。 event-sourced (answer_events / study_sessions) は別パイプとして維持。

### 14.4 汎用 entity-mutations の設計案

#### (i) Server schema

```sql
CREATE TABLE entity_mutations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mutation_id   uuid NOT NULL UNIQUE,                      -- 冪等鍵
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type   text NOT NULL,                             -- 'card' | 'tag_category' | 'tag_option' | ...
  entity_id     uuid NOT NULL,                             -- FK なし (entity_type ごとに対象 table が異なる)
  op            text NOT NULL,                             -- 'create' | 'update_field' | 'delete' | (entity 別 op 拡張可)
  patch         jsonb NOT NULL,                            -- op + entity_type 別の値
  edited_at     timestamptz NOT NULL,
  applied_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entity_mutations_user_idx ON entity_mutations(user_id, edited_at);
CREATE INDEX entity_mutations_entity_idx ON entity_mutations(entity_type, entity_id, edited_at);
```

- 既存 `card_mutations` は **rename + ALTER で吸収** (truncate 可なので column 追加に伴う backfill 不要)
- FK 削除は意図的: tag_options は exam-independent、 cards は exam に紐づく、 等 entity_type ごとに参照先が違う ⇒ application 層で integrity 保証

#### (ii) Client schema

```ts
export type ClientEntityMutation = {
  local_id?: number
  mutation_id: string
  entity_type: 'card' | 'tag_category' | 'tag_option'   // string union、 追加は型拡張
  entity_id: string
  op: string                                             // entity_type ごとに enum 拡張可
  patch: Record<string, unknown>
  edited_at: string
  sync_status: SyncStatus
  last_attempted_at?: string | null
}

// Dexie schema (version bump):
entity_mutations: '++local_id, mutation_id, [entity_type+entity_id], sync_status'
```

- 複合 index `[entity_type+entity_id]` で entity-scoped coalesce 検索を高速化

#### (iii) Coalesce key

```ts
function coalesceKey(input: EnqueueEntityMutationInput): string {
  if (input.op === 'update_field' && typeof input.patch.field === 'string') {
    return `${input.entity_type}:${input.entity_id}:update_field:${input.patch.field}`
  }
  return `${input.entity_type}:${input.entity_id}:${input.op}`
}
```

→ `${entity_type}:${entity_id}` を prefix にするだけで既存 logic そのまま流用可。

#### (iv) Apply registry (server)

```ts
// lib/server/entity-mutation-registry.ts (新設、 概念)
type EntityApplyRegistry = {
  [entityType: string]: {
    [op: string]: (tx: DbExecutor, entityId: string, userId: string, patch: any) => Promise<ApplyResult>
  }
}

const REGISTRY: EntityApplyRegistry = {
  card: {
    update_field: (tx, id, uid, patch) => applyCardFieldUpdate(tx, id, uid, patch.field, patch.value),
    create:       (tx, id, uid, patch) => applyCardCreateWithId(tx, uid, { cardId: id, ...patch }),
    delete:       (tx, id, uid, _)     => applyCardDelete(tx, id, uid),
    move:         (tx, id, uid, patch) => applyCardMove(tx, id, uid, patch),  // §12.6
  },
  tag_category: {
    create: (tx, id, uid, patch) => applyTagCategoryCreate(tx, uid, { id, ...patch }),
    update_field: (tx, id, uid, patch) => applyTagCategoryFieldUpdate(tx, id, uid, patch),
    delete: (tx, id, uid, _) => applyTagCategoryDelete(tx, id, uid),
  },
  tag_option: { /* 同様 */ },
  // 将来: image, ...
}
```

zod schema も同様に registry 化:

```ts
const PATCH_SCHEMAS: { [entityType: string]: { [op: string]: ZodSchema } } = { ... }
```

→ bulk endpoint の `processMutation` は単に `REGISTRY[entityType][op](tx, ...)` を dispatch するだけになる (現状の 3 分岐 if-else が消える)。

#### (v) Flush

Web Lock 名を `recallmint:entity-mutations:flush` に rename、 全 entity 共有 1 lock。 mutation-driven は全部この 1 経路で flush ⇒ debounce / immediate / mount triggers は entity_type 共通で動く。

entity_type 別に分ける利点は薄い (同 user の card 編集と tag rename が同時に走っても server 側で per-mutation tx 独立なので並列化に lock 競合は無関係)。

#### (vi) UI trigger

```ts
// 既存
enqueueCardMutation({ card_id, op, patch })
// ↓ rename + 引数拡張
enqueueEntityMutation({ entity_type: 'card', entity_id, op, patch })

// 新規 tag 編集
enqueueEntityMutation({ entity_type: 'tag_category', entity_id, op: 'update_field', patch: { field: 'name', value: '...' } })
```

旧 API は **薄い wrapper として残せる** (`enqueueCardMutation(input)` = `enqueueEntityMutation({ entity_type: 'card', ...input })`)。 既存 UI 呼出箇所 (`inline-text-field.tsx` / `inline-option-row.tsx` / `delete-card-button.tsx` / `card-mutation-flush-trigger.tsx`) を一括移行 vs wrapper 経由で漸進移行 が選択肢。

### 14.5 移行手順 (truncate 可、 ユーザー 0 前提でもリグレッション回避)

#### 段階的 (3 段階) を推奨

**Phase 1: server-side rename + schema 拡張 (1 sprint 小)**
1. `card_mutations` table を `entity_mutations` に rename
2. `entity_type text NOT NULL DEFAULT 'card'` 追加、 後で DEFAULT 削除
3. `cardId` 列を `entityId` に rename、 FK constraint を削除
4. `op` enum の zod を generic に (validate は registry 経由)
5. `applyCardX` 関数を registry に登録、 dispatch を switch から table lookup に
6. 既存 bulk endpoint は `entity_type='card'` 固定で動く (上位互換)

→ この段階で **card 経路の挙動は完全に不変** (coalesce / 冪等 / debounce / Web Locks / 失敗時 pending 残置)。 既存 card テストが全て通る状態を担保。

**Phase 2: client-side rename + Dexie version bump (1 sprint 小)**
1. `ClientCardMutation` → `ClientEntityMutation`、 `card_id` → `entity_id` + `entity_type` 追加
2. Dexie store rename + version bump (`card_mutations` → `entity_mutations`、 v3 → v4)
3. `coalesceKey` 拡張
4. `enqueueCardMutation` を thin wrapper として残し、 内部実装は `enqueueEntityMutation` に委譲
5. `runGuardedCardMutationFlush` → `runGuardedEntityMutationFlush`、 Web Lock 名 rename
6. UI trigger 全箇所 (4 file) を新 API 呼出に書換 (or wrapper 経由で据置)

→ この段階でも **card 経路の挙動は完全に不変**。 既存 e2e / UI テストが全て通る状態を担保。

**Phase 3: 新 entity_type の追加 (タグ実装の各 sprint)**
- `REGISTRY['tag_category']` / `REGISTRY['tag_option']` の apply 関数群を追加
- patch zod schema を追加
- UI で `enqueueEntityMutation({ entity_type: 'tag_category', ... })` を呼ぶ
- 既存 card 経路は一切触らない

**truncate の使い所**: Phase 1 の rename 時。 `entity_mutations` 新規 CREATE + 旧 `card_mutations` DROP の方が ALTER 連発より安全。

#### 既存 card 挙動の不変保証

各 Phase 後に確認:
- coalesce: `${entity_type}:${entity_id}:...` で card は `card:<id>:...` 形に。 同 card 同 field の連続編集は last-write-wins (`card-mutations.test.ts:93-114` 同等のテストが通ること)
- 冪等: `mutation_id` UNIQUE は不変、 in-flight Set も不変
- debounce: 500ms / immediateDrain も不変
- Web Locks: lock 名は変わるが logic 不変
- 失敗時: pending 残置 / `'syncing'` 経由なし / `failed` modify なし

### 14.6 汎用化 vs 並列複製 vs server action 直叩き

| 軸 | (A) 汎用 entity-mutations | (B) 並列複製 (tag 用 outbox 別建) | (C) server action + pull |
|----|---------------------------|------------------------------------|--------------------------|
| 初期実装行数 | ~400-500 (Phase 1+2) | ~400/entity × 2 = 800 | ~150 (action 4-6 個) |
| 既存 card 経路リスク | 中 (rename / Dexie version bump) | 0 (無触) | 0 (無触) |
| 3 本目 (image 等) 追加 | registry に 1 entry + apply 関数 = ~100 | 別建 +~400 | server action +~50 |
| 4 本目 | 同上 | +~400 | +~50 |
| long-term 保守 (5+ entity) | 1 channel + registry、 観測一元 | N channel、 観測散乱、 retry 戦略乖離リスク | N action、 楽観反映なし、 編集 UX 劣化 |
| 楽観反映 | 既存 card と同等 | 既存 card と同等 | なし (server 往復待ち) |
| 編集 UX (rename 等) | card と同等の即時反映 | 同上 | 500ms-1s 遅延 |

#### 推奨: **(A) 汎用 entity-mutations**

理由:

1. **3 本目で必ず破綻**: image 追加 / settings の granular sync / 将来何が増えるか不明、 並列複製は 3 本目あたりから「retry 戦略のドリフト」「Web Lock 名の被り」「sync_status 列の意味揺れ」 で確実に保守不能化
2. **観測一元化**: 1 channel に揃えると flush 失敗 / 冪等衝突 / lock-busy 等の logger 集約。 並列だと N 個の controller で散る
3. **タグ前 truncate の窓**: 既存 card 経路を rename する破壊的変更は今後できない (ユーザーデータ蓄積後)。 truncate / ユーザー 0 の **今だけ** 安全に schema rename / Dexie version bump 可
4. **設計の純度**: §11/§12 の card_tags whole-set 相乗り設計と整合 — 「card のタグ field を card outbox で送る」 は entity_type='card' で送れば良く、 タグマスター (tag_category / tag_option) は entity_type='tag_category' / 'tag_option' で送る。 同 channel で性質が違う mutation が混在しない

#### (B) を選ぶケース

- Phase 1+2 の rename を実施する余裕がない / regression リスクを 0 にしたい
- 並列 channel を 2 本までで止める確信がある (image 等が来ない約束)

→ プロジェクトの将来計画 (image, settings sync 等) が固まっていれば (B) も合理的だが、 RecallMint は MVP 後の自由度を高く保ちたいはずなので (A) を取る方がリスク調整として良い

#### (C) を選ぶケース

- タグマスター rename / delete は管理画面の低頻度操作で **500ms 遅延を許容** できる
- card_tags junction (= card の whole-set field) は §11.4 (a) で card outbox に既に相乗り済 → 高頻度 UI はカバー済
- 並列 channel を増やしたくない、 かつ汎用 refactor のリスクも取りたくない

→ §12.5 で当初推奨した経路。 タグ実装スコープのみを最小化したいなら今でも妥当。 ただし「将来の sync 散らかり」 を本質的には防がない (image 追加時に同じ問題に直面)

### 14.7 結論 (push)

**推奨**: **(A) 汎用 entity-mutations への refactor**。 タグ前に Phase 1+2 を独立 sprint で実施し、 タグ実装は Phase 3 として乗せる。 truncate / ユーザー 0 の窓を逃すと後で同じ refactor を実施するコストは現在の 2-3 倍 (data migration / contract drift / 既存 UI 修正範囲拡大)。

review-events は **統合射程外**。 event-sourced path として独立維持。

---

## 15. pull の整理 — 散らかりの実体と統一形 (2026-06-05 追補)

### 15.1 「散らかり」 の実体

並列 grep の結果、 pull の「散らかり」 は **見かけのもの** で、 各 stream の性質に応じた正当な分離だった:

| 表象 | 実体 | 判定 |
|------|------|------|
| `/api/pull` (3 stream) と `/api/study-days/pull` の endpoint 分裂 | cursor 戦略の本質的違い (ISO incremental vs full-window replace) | 必要な分離 |
| cursor 方式不統一 (ISO since vs cursor なし) | stream 性質の違い (差分 vs カレンダー snapshot) | 必要な不統一 |
| TX 境界分離 (`[db.cards, db.exams, db.sync_meta]` vs `[db.study_days]`) | 失敗時不変性の要件が異なる (cursor 進めない vs full replace) | 必要な分離 |
| mapper スタイル混在 (cards は独立 file 30+ field、 他は inline 3-5 field) | 規模の違い | 統一すべき (cosmetic、 機能影響なし) |
| trigger 散在 (mount / online / visibility / explicit kick 4 箇所) | 必要な最小経路 | OK |

詳細: §15.2 / §15.3。 結論として **pull 側に「整理が必要な散らかり」 は存在しない**。 タグ実装で stream 2 本足すコストも机上で確認済 (~5-7 file の機械的差分、 1 stream あたり ~80 行 + テスト)。

### 15.2 study_days を別建てにしている根拠 (コード comment 引用)

`lib/db/study-days-pull.ts:21-24`:
```
今日を含む過去 N 日 (N=90 → today - 89)。 streak 計算は最大 61 日 (today + 過去 60)
しか使わないが、 client 側 dashboard 表示や将来の月別表示余地を確保するため 90 を
余裕を持たせて確定。
```

`lib/sync/study-days.ts:1-10`:
```
replace 戦略 (clear + bulkPut) + 失敗時不変性。 server endpoint は冪等
(90 日 window で常に full snapshot)、 client はローカルを置き換える。 cursor は
持たない (full-window snapshot replace のみ)。
```

→ study_days を `/api/pull` に統合すると以下が壊れる:
- cursor を持たない stream を cursor 軸の応答 envelope に乗せる必要が生まれる
- `tombstones` apply 順序 (cards/exams の後) の中で「clear が走る」 別 stream が混じり、 順序依存が複雑化
- 失敗時不変性のモデルが「cursor 進めない」 と「90 日 snapshot 据置」 で異なるため、 統合 TX 内で失敗判定が分岐

→ **そのまま維持が最善**。

### 15.3 タグ stream 追加の機械的差分 (再確認)

`tag_categories` / `tag_options` の 2 stream 追加:

| file | 修正 | 行数 |
|------|------|------|
| 新規 `lib/db/tag-categories-pull.ts` | `getCategoriesDelta` + `toClientTagCategory` mapper | ~30 |
| 新規 `lib/db/tag-options-pull.ts` | 同 pattern | ~30 |
| `app/api/pull/route.ts` | `Promise.all` に 2 stream 追加、 query params + response body 拡張 | ~10 |
| `lib/sync/sync-meta.ts` | `tagCategoriesCursor` + `tagOptionsCursor` 追加 | 2 |
| `lib/client-db.ts` | ClientTagCategory / ClientTagOption 型 + Dexie store 2 個 + version bump | ~20 |
| `lib/sync/pull.ts` | Promise.all + shape check + tx stores 拡張 + bulkPut + cursor put | ~25 |
| 新規 `lib/db/tag-categories-pull.test.ts` / `tag-options-pull.test.ts` | delta テスト 2 本 | ~100 |

合計 ~220 行 (うち test ~100)。 cards/exams stream を template にした機械的差分のみで registry 化は不要。

### 15.4 将来 stream 数が増えた場合の registry 化判断

現在 5 stream (cards / exams / tombstones / study_days / + tag 追加で 7)、 image 追加で 8。 10+ になった段階で:

- `SYNC_META_KEYS` 定数 object の管理 (現在は手書き)
- `pull.ts` の Promise.all + shape check + tx stores + bulkPut + cursor put の繰り返し
- `/api/pull/route.ts` の query params + response body 構築の繰り返し

これらが「機械的に多数の同型 stub」 になる時点で registry pattern を入れる。 8 stream 未満では現状の明示的 manual extend が **「stream 性質を code 上で読める」** メリットが強い。

### 15.5 mapper スタイル整列 (optional)

cards だけが `lib/db/cards-mapper.ts` 独立 file、 他 3 stream は `*-pull.ts` 内 inline。 整列するなら cards mapper を inline に寄せるか、 他 3 を独立 file に切り出すか。 機能影響ゼロ、 cosmetic のみ。 タグ実装と同 sprint で揃える価値は低い。

### 15.6 結論 (pull)

**pull に「整理が必要な散らかり」 は無い**。 タグ stream 2 本は機械的差分で素直に乗る (合計 ~220 行)。 registry 化は 10+ stream まで保留。 study_days の別建ては設計意図どおり維持。

---

## 16. 統合判断 — sprint 順序 (2026-06-05 追補)

### 16.1 タグ実装と push 汎用化の関係

タグ実装は前提として:
1. tag_categories / tag_options の **新 top-level entity の同期** (mutation-driven、 楽観反映あり想定)
2. card_tags **junction の whole-set 相乗り** (§11.4 (a))
3. OCR 分解の cards bulk INSERT 同 tx 拡張

(1) を「楽観反映あり」 で実装するなら、 **push 汎用化が前提**。 並列複製 (B) を取ると後で必ず生え際で破綻する。

(1) を「楽観反映なし、 server action 直叩き」 (§12.5 推奨 (C)) で逃げると、 push 汎用化を遅延できる。 ただし「tag rename は管理画面操作なので 500ms 遅延 OK」 が成り立つかは UI 設計次第。

### 16.2 推奨 sprint 順序

#### 案 α (推奨): **push 汎用化を独立 sprint → タグ実装**

```
Sprint Sync-1: push 汎用化 (entity-mutations refactor)
  - Phase 1: server schema rename + apply registry (§14.5)
  - Phase 2: client schema rename + Dexie version bump
  - 完了条件: 既存 card 編集の全 e2e / 単体テストが緑、 [reviewed] tag
  - 規模: ~400-500 行 (server ~200, client ~200, test ~100)

Sprint Tag-1: タグマスター schema + sync
  - tag_categories / tag_options の DB schema 追加 (3 table CREATE + cards.custom_props/tags DROP)
  - pull stream 2 本 (~220 行)
  - tag_category / tag_option の entity-mutations apply 関数を registry に追加 (~150 行)
  - 完了条件: タグマスター CRUD が local-first で動く

Sprint Tag-2: card_tags 相乗り
  - UpdateCardFieldName に 'tag_option_ids' 追加
  - buildSetClause に case 追加、 applyCardFieldUpdate に junction whole-set replace 分岐
  - cards-mapper.ts に LEFT JOIN GROUP BY で tag_option_ids 集約

Sprint Tag-3: OCR 分解
  - process.ts の cards bulk INSERT と同 tx 内に tag_categories / tag_options / card_tags 分解 INSERT
  - 既存 custom_props 関連の dead code 撤去 (§11.7 の 38 参照)

Sprint Tag-4: UI
  - tag manager (category 一覧 / rename / 削除)
  - card 編集 UI のタグ pill / popover (whole-set replace の trigger)
```

メリット:
- Sync-1 完了時点で「同期基盤が将来 entity 追加に対応できる」 ことを確認できる
- Tag-* の各 sprint は schema 変更 / UI 実装に集中、 同期 logic の bug と混ざらない
- Sync-1 のリグレッションをタグ実装で検出する依存リスクを避けられる
- review-flow に diff 量が分散

デメリット:
- Sync-1 が「機能追加なしの refactor sprint」 になる (ユーザー視点の進捗 0)
- truncate 実施タイミングを Sync-1 か Tag-1 のどこかで挟む必要 (おそらく Sync-1 前)

#### 案 β: **push 汎用化 + タグ実装を同 sprint で混ぜる**

メリット:
- truncate 1 回で済む
- refactor の motivation がタグ実装と直結し「やる意義」 を実感しやすい
- sprint 数が圧縮される

デメリット:
- 1 sprint の diff が ~1000 行超え、 review 困難
- 同期 logic refactor の regression がタグ実装と混ざり原因切り分け困難
- 「entity-mutations の正常動作」 を「タグの動作」 で間接確認することになる (直接テスト不在)
- Critical bug 検出時の rollback 単位が大きい

#### 案 γ: **タグだけ先、 push 汎用化は後回し (server action + pull で逃げる)**

メリット:
- タグを最速で着地
- 同期基盤を触らない

デメリット:
- truncate 窓 (アクティブユーザー 0) を逃すと、 後の汎用化が data migration / contract drift で 2-3 倍コスト
- タグマスター rename の UI 体験が server 往復待ちで劣化
- image 等の追加で結局同じ refactor を後でやることになる

### 16.3 推奨

**案 α (push 汎用化を独立 sprint → タグ実装)**。

理由を 1 行ずつ:

1. **truncate 窓**: アクティブユーザー 0 / prod 含むデータ破棄可 の状態は **二度と再現しない**。 今やる以外に schema rename を安全に実施する機会がない。
2. **将来 entity (image / settings granular sync 等) も同 channel に乗る**: タグ 2 entity だけのために refactor を入れるのではなく、 「mutation-driven 同期の 1 本化」 という基盤投資として位置づけ。
3. **regression 切分け**: Sync-1 の e2e が緑 ⇒ タグ実装に進む、 という gate が立つ。 同 sprint で混ぜると不可。
4. **review 規模**: §11/§12 で確認した「タグ実装の総量 ~440 行 + UI」 と「push 汎用化 ~400-500 行」 は別 sprint に分けるべきサイズ。 1 sprint 1000 行超は CLAUDE.md「plan 300 行超過で STOP」 の精神に反する。
5. **review-events は据置**: §14.3 のとおり統合射程外、 sprint で触らないので議論不要。

### 16.4 OT 判断必要な論点

A. **案 α / β / γ のどれを採るか**。

B. **「mutation-driven 同期の汎用化」 を投資として認めるか**。 タグ実装だけ見ると (C) server action + pull が最小工数だが、 将来 image 等を見据えると (A) 汎用化が正味で得。 タグだけ最小工数を優先するか、 将来込みで投資するか。

C. **truncate のタイミング**。 Sync-1 (entity-mutations rename) と Tag-1 (tag schema 追加 + cards.custom_props/tags DROP) のどちらの前か。 Sync-1 前なら Sync-1 単独で「壊れない (truncated 空 DB 上で動作)」 を確認、 Tag-1 で再度 truncate 不要 (mig で追加 / DROP)。

D. **review-events 統合射程外の確認**。 §14.3 で「event-sourced は別パイプ維持」 を推奨したが、 将来 event-sourced 系も増えた場合 (例えば「pageview-events」 が増えるなど) はその時点で別の generic 化を検討する、 で OK か。

判断必要: yes

---

## 17. 参考: 関連テーブル一覧 (`lib/db/schema.ts`)

- `users`: Clerk 連携、 stripe_customer_id 保持
- `userSettings`: sessionLimit / fsrsMode
- `exams`, `cards`: §7
- `sourceDocuments`: OCR upload 元、 exam と同寿命 / SET NULL
- `uploadRecords`: OCR 月次台帳、 append-only、 quota 集計元
- `reviews`: FSRS 評価履歴、 append-only、 card_id FK CASCADE
- `studyDays`: 学習日カレンダー、 composite PK (user_id + day)
- `studySessions`: 演習 session (S-cache-0 新設)
- `answerEvents`: 回答 event 生 log (S-cache-0 新設)
- `cardMutations`: 編集 mutation log (冪等 mutation_id)
- `tombstones`: §3
- `contactMessages`: お問い合わせ
- `stripeEvents`, `aiUsage`, etc.: 課金 / 利用枠
