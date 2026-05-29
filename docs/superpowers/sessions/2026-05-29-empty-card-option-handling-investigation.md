# 空 card / 空選択肢の扱い — 既存実装の事実確認

- 日時: 2026-05-29
- 種別: investigation / session log (**実装変更・commit なし**、 成果物は本 doc のみ)
- 対象 branch: `develop`
- 目的: 割り込み (カード手動作成) の spec で「空 card をどこまで許容するか」 を決めるための事実確認。 決定はせず、 事実 + 選択肢の提示まで
- 手段: grep + 実コード read (推測排除)
- 関連: `docs/superpowers/sessions/2026-05-29-manual-create-tombstone-pre-investigation.md` (項目3 の残論点「空 card 初期値」「sort_key 末尾連番」 の深掘り)

---

## 結論サマリ

| 軸 | 結論 |
| --- | --- |
| 1 validation | optionSchema は text **非空 refine** (`card.ts:19`)、 optionsSchema は **min(1)** (`update-card-field.ts:54-55`)。 title min(1) / questionText 非空 refine。 correct 下限は**無し** (0 許容、 意図的) |
| 2 空選択肢の自動除去 | **client sanitize で除去** (`inline-option-row.tsx:198` `filter(o => o.text.trim().length > 0)`) + **server reject** (optionSchema text refine)。 = 空 option は保存経路で必ず落ちる |
| 3 出題フィルタ | **空 card / 空選択肢を出題対象から除外するフィルタは存在しない**。 session query は due 判定のみ。 OT 記憶の「出題されない制限」 は**未実装** (実体は軸2 の保存時 validation) |
| 4 sort_key 末尾連番 | **card 単位 sort_key の採番ロジックは存在しない**。 OT 記憶の「実装済」 は `nextOptionId` (= **選択肢 id** 採番) との混同。 card sort_key は OCR 由来 or inline 手入力のみ |

---

## 軸1. card / options / correctAnswerIds の zod schema

### 選択肢: `lib/validation/card.ts:14-27` `optionSchema`
- `id`: `z.string().min(1)` (必須、 `:15`)
- `text`: `z.string().max(1000).refine((s) => s.trim().length > 0, …)` = **空文字・空白のみ不可** (`:16-21`)
- `isCorrect`: boolean (`:22`)
- `explanation`: `z.string().max(2000).optional()` (`:23-26`)
- **correct_answer_ids は schema に含めない** — server action が is_correct から再生成 (`:11-12`、 `update-card-field.ts:115-120`)
- **正答数の下限なし** = 全 is_correct=false (正答 0) を意図的に許容 (`:7-10`、 OCR 正答未記載 card のため)

### inline 編集の field 別 schema: `update-card-field.ts`
- `titleSchema`: `z.string().trim().min(1).max(200)` = **空不可** (`:27-31`)
- `questionTextSchema`: `z.string().max(10000).refine(s => s.trim().length > 0)` = **空不可** (`:38-41`)
- `sortKeySchema` / `explanationTextSchema` / `memoSchema`: nullable、 空文字 → null 正規化 (`:33-36,43-51,84,95,101`)
- `optionsSchema`: `z.array(optionSchema).min(1).max(50)` + id 重複 refine = **最低 1 個・各 text 非空** (`:53-59`)

→ **inline 編集経路では title / questionText / 各 option text が必ず非空、 options 最低 1 個**。 ただしこれらは **編集 (update) 時の validation**。 作成 (insert) 時は別途 (現状 createCard 不在のため未定義)。

## 軸2. 空選択肢を保存しようとしたときの挙動

二重に弾かれる:
1. **client sanitize** (`inline-option-row.tsx:190-200`): `send` 入口で `const sanitized = target.filter((o) => o.text.trim().length > 0)` (`:198`)。 空 text の ghost option は payload から除外。 sanitized が空なら send 自体 skip (`:200`)。 ghost row は local state には残し user 編集中値を保護、 次 revalidate で消える (`:43-61` のコメント)。
2. **server reject** (optionSchema text refine、 軸1): 万一空 text が届いても optionsSchema で弾かれ、 action が `{ok:false}` → client が全 row rollback (`:223-231`)。

→ OT 記憶「空選択肢を作ると自動削除」 の実体は **(1) の client sanitize**。 「自動削除」 というより「保存対象から除外 (ghost のまま放置 → revalidate で消える)」。 DB に空 option が永続することはない (inline 経路では)。

## 軸3. 出題対象カードの絞り込みクエリ / フィルタ

### server: `lib/cards/get-session-cards.ts:26-34`
```
db.select().from(cards)
  .where(and(eq(cards.userId, userId), lte(cards.due, threshold)))
  .orderBy(asc(cards.due)).limit(limit)
```
→ **due 判定 + tenant 絞りのみ**。 options / question_text の中身による除外なし。

### client: `lib/cards/get-dexie-session-cards.ts:30-43`
→ `filter(c => c.due <= nowIso)` → sort → slice。 **同様に due のみ**。 空除外なし。

### 他の cards SELECT 経路 (全数確認)
`from(cards)` を使う全 query: `cards-pull.ts:24` (userId のみ) / `exams/list.ts:131,198` (exam 詳細表示) / `review-events/bulk/route.ts:154` (card_id 指定) / `get-session-cards.ts:28`。 **いずれも options/question_text の空を WHERE 条件にしていない**。

### session-runner / host のガード
- `study-session-host.tsx`: `chosen.length === 0` で空 session を作らない (`:71`) のみ。 **per-card の空 option ガードなし**。
- `session-runner.tsx`: `options = Array.isArray(current.options) ? current.options : []` と防御 (`:194,392`)、 `options.map` で選択肢描画 (`:416`)。 = **空 options の card が出題されると「選択肢ボタン 0 個」 で描画**される (出題自体は止まらない)。
- dashboard dueCount (`dashboard-actions.tsx:33`): Dexie cards の due のみ。 空除外なし。

→ **OT 記憶「選択肢が空のカードは出題されない制限をかけた」 は session query には存在しない**。 実装上の安全弁は軸2 の保存時 validation (空 option は永続しない) であって、 出題側フィルタではない。 = **空 options の card が (validation を迂回して) DB に存在すれば、 そのまま出題され dueCount にも数えられ、 選択肢 0 個で描画される**。

## 軸4. sort_key 末尾連番

### card 単位 sort_key (cards.sortKey)
- 型: **text nullable** (`schema.ts` cards、 `sortKeySchema` も `z.string().max(100).nullable()`)。
- 設定元: **OCR 抽出のみ** (`process.ts:515` `sortKey: c.sort_key ?? null`) + inline 手入力 (`update-card-field.ts:81-85`、 空→null 正規化)。
- 用途: exam 詳細の sort (`list.ts:115` コメント「sort_key (text) ASC NULLS LAST → created_at ASC」)。
- → **新規 card の sort_key を自動採番 (末尾連番) するロジックは存在しない**。

### `nextOptionId` は別物 (混同注意)
- `lib/cards/next-option-id.ts:14-28`: **選択肢 (option) の id** を card 内で採番する純粋関数。 rule = 全英字 1 文字なら次の未使用英字 / 全数字なら max+1 / それ以外 `opt-N`。
- caller は `inline-option-row.tsx` の「+ 選択肢を追加」 のみ (`:12`)。 = **option id 採番であって card の sort_key ではない**。

→ OT 記憶「inline 編集の選択肢追加で sort_key 末尾連番が実装済」 は `nextOptionId` (option id) との混同。 **card 単位 sort_key の連番は未実装**。 manual card 作成で sort_key 末尾連番を入れるなら新規実装が必要、 かつ sort_key は **text 型** のため「max + 1」 は数値前提では計算できない (例: "001" / "03-02" 混在、 OCR は zero-pad / 階層番号もある → §最後の論点)。

---

## まとめ: 空 card 作成時に各 notNull 列に何を入れるか (事実 + 選択肢)

cards の notNull 列 = `title` / `questionText` / `options` (jsonb) / `correctAnswerIds` (jsonb)。 FSRS 系は default あり、 `due` は **defaultNow = 作成直後に出題対象**。 sortKey / explanationText / memo は nullable。

### 制約事実 (DB と各経路)
- **DB**: title/questionText は text notNull だが**空文字 `''` は許容** (NOT NULL のみ、 length 制約なし)。 options/correctAnswerIds は jsonb notNull だが `[]` 許容。
- **inline 編集 (update) validation**: title min(1) / questionText 非空 / options min(1) + 各 text 非空。 = 作成後に編集すると非空が強制される。
- **出題側**: 空除外フィルタなし (軸3)。 = 作った瞬間 (due=now) から出題対象 + dueCount 加算。 options=[] なら選択肢 0 個で描画。

### 「空 card」 の選択肢 (決定しない、 spec 判断)

| 案 | title | questionText | options | 出題時の見え方 | 既存 validation 整合 | 追加実装 |
| --- | --- | --- | --- | --- | --- | --- |
| α 完全空 | `''` | `''` | `[]` | 選択肢 0 個・空問題文で出題されてしまう | insert は通る (DB)。 ただし**その後 inline 編集で title/questionText/options を埋めるまで不整合** | 出題フィルタ or draft 化が別途要 |
| β 最小プレースホルダ | `''` or `'(無題)'` | `''` | `[{id:'1', text:'', is_correct:false}]` | 選択肢 1 個だが text 空で出題 | option text 非空 refine は **編集時のみ** 効くので insert は通る。 出題で空ボタン表示 | 同上 (空 text option が出題され得る) |
| γ 非空プレースホルダ | `'新しいカード'` 等 | `'(問題文を入力してください)'` | `[{id:'1',text:'(選択肢1)',is_correct:true}]` + correctAnswerIds `['1']` | 出題可能だがプレースホルダ内容 | 全 schema 制約を満たす (編集経路でも valid) | なし (sort_key 採番除く) |

### spec で決めるべき残論点 (本調査の事実から導出)
1. **未完成 card の出題回避**: 軸3 のとおり**出題側フィルタが無い**ため、 作成直後の空/半端 card が即出題・dueCount 加算される。 → ① 非空プレースホルダ (案γ) で「壊れない card」 にする / ② `due` を遠未来に置き完成まで出題しない / ③ 出題クエリに「options 全空 or question_text 空を除外」 フィルタを新設 (= OT 記憶の制限を**今**実装する)、 のいずれか。
2. **option text 非空との整合**: 案α/β は空 text option を DB に作るが、 これは inline 編集の保存時 refine と矛盾する (作成は通るが編集で弾かれる)。 案γ なら一貫。
3. **sort_key 末尾連番**: 未実装 (軸4)。 text 型のため算出方針を決める (① 単純に既存最大の数値 parse +1、 ② 常に空(null)にして created_at 順に委ねる、 ③ questionNoFormat 準拠)。 既存 OCR card の sort_key 形式 ("001" / "03-02" 等) と混在しても破綻しない方式を選ぶ。
4. **correct 0 許容との関係**: optionSchema は正答 0 を許容 (軸1)。 案γ で is_correct=true を 1 個置くか、 正答 0 のまま作るかは UX 判断 (出題時に正解判定が常に不正解になる点に注意)。
