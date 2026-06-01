# 「空選択肢も全て保存」案の実現可否 調査 (2026-06-01)

read-only 調査。HEAD = `3383012`。ghost merge 回帰 (`70d0714`) を「ghost ライフサイクルの
複雑なロジック」ではなく「+追加した選択肢は空でも全て永続化する」で解消できるかの実現可否を
schema・保存経路・演習/採点・OCR の 4 軸で確認。修正はしない。

前提レポート: `2026-06-01-inline-option-ghost-and-trailing-newline-investigation.md`
(不具合1 = `70d0714` の `merged=[...serverOptions, ...localGhosts]` で空 ghost が末尾残留)。

---

## 結論 (要約)

- **schema 上は可能**。options は `cards.options` jsonb (`schema.ts:266`)、DB 側に NOT NULL /
  空文字禁止 / 長さ制約は**一切なし**。`CardOption.text` は `string` 必須だが `''` も型上 valid
  (`schema.ts:41-46`)。空文字を弾くのは**アプリ層の zod refine と client sanitize のみ**。
- 「空も保存」に必要な変更は **4 箇所** (編集/作成経路)。OCR 経路は**元から空を弾いていない**
  ため変更不要 (= 空 option 流入経路は既に OCR 側に存在)。
- **最重要リスク = 演習/採点**。出題 component (`session-runner.tsx`) は **全 option を無条件
  描画**・空除外 filter なし。空 option を永続化すると**空ボタンがそのまま出題**される
  (`:431-468`)。さらに空 option を `is_correct=true` にしたカードは「ID ラベルだけの見えない
  正解肢」になり、押さないと永久不正解 / 押せば正解という UX 破綻が生じ得る (`:201-209`、id 集合
  一致判定)。判定自体は id ベースで位置非依存のため**ずれて壊れることはない**が、空肢の出題が
  不自然になる。
- **トレードオフ**: 「空も保存」は schema 非変更で済むが、**演習表示時の空除外**という新たな
  対処を別途要する (sanitize を保存から表示へ移すだけで本質は変わらない)。一方レポートの **1-a
  (merge で編集中 ghost のみ保持・放置空 drop)** は client working-set ライフサイクル 1 箇所
  (`:114-122`) のみで、schema・server・演習・採点に非干渉。変更範囲は 1-a が小さい。

---

## 調査軸1: DB schema の制約

### option の格納先と制約 (実コード)
- 格納先: **`cards.options` jsonb 列** (別テーブルなし)。`lib/db/schema.ts:266`
  `options: jsonb('options').notNull().$type<CardOption[]>()`。
- 正答は別列にデノーマライズ: `:267` `correctAnswerIds: jsonb('correct_answer_ids').notNull()`。
- 型: `lib/db/schema.ts:41-46`
  ```
  export type CardOption = { id: string; text: string; is_correct: boolean; explanation?: string }
  ```
  `text` は `string` 必須 (optional でない) だが `''` も型上 valid。
- **DB 側 (jsonb) には text の NOT NULL / 空文字禁止 / 長さ制約は一切なし** (jsonb のため当然)。
  → **空文字 option を保存しても DB schema (drizzle) は弾かない**。弾くのはアプリ層のみ。

### 空文字を弾く zod (全箇所)
1. `lib/validation/card.ts:14-27` `optionSchema` (編集/作成の canonical):
   `:18-21` `text: z.string().max(1000).refine((s) => s.trim().length > 0, …)` ← **空禁止あり**。
2. `lib/ai/ocr.ts:32-37` `optionSchema` (OCR 用): `:34` `text: z.string()` ← **空制約なし**。

---

## 調査軸2: 保存経路のバリデーション

選択肢を DB に書く server 経路は **2 つだけ**:

### 経路1: 編集・手動作成 (`POST /api/card-mutations/bulk`)
空を弾く箇所 (この経路、全列挙):
- `lib/validation/card.ts:19` — `optionSchema.text.refine(trim>0)`。update/create 両 op + client が共有。
- `lib/cards/apply-card-mutation.ts:69-75` — `optionsSchema = z.array(optionSchema).min(1)`。
  `update_field(options)` が使用。`.min(1)` で options ゼロも reject。
- `app/api/card-mutations/bulk/route.ts:99-105` — `createPatchSchema.options = z.array(optionSchema).min(1)`。
  `create` op が使用。
- **client** `app/(app)/app/exams/[id]/_components/inline-option-row.tsx:155` —
  `sanitized = target.filter((o) => o.text.trim().length > 0)`。空 row を payload から除外。
  `:158` `sanitized.length === 0` で commit skip。**これが空 option 非永続化の実質的な砦**。

### 経路2: OCR 取込 (`app/(app)/app/upload/_actions/process.ts`)
- `:510-523` `cardRows` 構築 → `:517` `options: c.options as CardOption[]` を**無変換**で →
  `:530-534` `tx.insert(cards)`。
- 検証は `lib/ai/ocr.ts:32-37` (`text: z.string()`、**空許容**)。**空を弾く filter / refine / .min
  はこの経路に一切ない** → OCR が空 text option を返せばそのまま DB に入る (既に流入経路あり)。

### 「空も通す」に必要な変更箇所 (列挙のみ)
経路1 を空通過にするには:
1. `lib/validation/card.ts:19-21` — `.refine((s) => s.trim().length > 0, …)` を除去/緩和 (両 op + client 共有 source)。
2. `lib/cards/apply-card-mutation.ts:71` — `optionsSchema` の `.min(1)` (options ゼロを許すなら)。
3. `app/api/card-mutations/bulk/route.ts:101` — `createPatchSchema.options` の `.min(1)` (create 側、同上)。
4. `inline-option-row.tsx:155` — `sanitized` の `.filter(trim>0)` を除去 (除去しないと client が空 row を
   送らず server を緩めても無意味)。あわせて `:158` の skip 条件、`:249-251` `handleDeleteOption` の
   `length <= 1` ガードも要確認。
- 経路2 (OCR) は元から空通過のため変更不要。
- 註: `correct_answer_ids` は server で `is_correct` から再生成 (`apply-card-mutation.ts:131-133, :287`)
  のため、option 構造変更時はこのデノーマ整合も確認対象。

---

## 調査軸3: 空選択肢を永続化した場合の影響範囲 (最重要)

唯一の出題 component は `app/(app)/app/study/smart/_components/session-runner.tsx` (SessionRunner)。
スマート復習 / custom 復習の両方がこれを共有。別系統 quiz/review component は存在しない。

### C. 演習/出題画面の表示
- `:431-468` `options.map((opt) => …)` で**全 option を無条件描画** (空除外 filter なし)。
- 表示は `opt.id` ラベル (`:457` `<span>{opt.id}</span>`) + `stripPrefix(opt.text, opt.id)` (`:445`)。
  → **`opt.text=''` なら ID ラベルだけのクリック可能な空ボタンが出題画面に表示される**。
- `disabled` 条件は `isJudged` のみ (`:451`)。selecting 中は空ボタンも選択可能。
- 固定 4択 / A-D ラベル付与ロジックは**なし** (可変長 `<li>`、ラベルは `opt.id` 直描画)。空が混ざっても
  レイアウト崩壊はせず「空ボタンが 1 つ増える」のみ。

### D. 採点/正解判定
- 判定は**完全に client 側 + option.id ベース** (`:201-209` `handleAnswer`):
  ```
  const correctIds = options.filter((o) => o.is_correct).map((o) => o.id)
  const correct = equalSet(selectedIds, correctIds)
  ```
  `equalSet` (`study/smart/_lib/equal-set.ts:4-12`) = id 集合の順序非依存・完全一致。server 戻り値は
  採点に不使用 (`:208` 直後コメント)。
- **空 option が is_correct=true になり得るか**: 構造上可能 (`text` と `is_correct` は独立、`schema.ts:41-46`)。
  inline 編集の checkbox toggle (`inline-option-row.tsx:224-230`) は text を見ない。
  - 現状は `inline-option-row.tsx:155` sanitize で空 row が is_correct=true でも DB に届かない (= 砦)。
  - 「空も保存」を入れると、**空 option を正解にしたカードは `correctIds` に空 id が含まれ、ユーザーが
    その空ボタンを押さない限り equalSet 不一致 → 永久不正解 / 押せば正解**という経路が生じる。
- **id / index / text**: **id ベースのみ**。空が混ざっても id がユニークなら判定はずれない (集合演算で
  位置非依存)。壊れるのは上記「空 id が correctIds に入る」UX ケースのみ。id ユニーク性は編集経路
  (`apply-card-mutation.ts:73`、`bulk route.ts:103`) で担保、**OCR 経路は id 重複検証なし**。
- server (`app/api/review-events/bulk/route.ts:95-97, 208-211`) は採点非関与 (client 結果を記録 +
  FSRS rating 導出のみ)。**空 option が server 採点を壊す経路はない**。

### E. 集計
- option 数カウントは 2 箇所、いずれも**空除外なしの `options.length`**:
  `lib/exams/list.ts:187` (`optionCount`)、`process.ts:651` (OCR preview)。
  → **空込みでカウント** (例: 4択 + 空1 = 「5」表示)。`card_count` (card 件数) は無関係・影響なし。

### F. OCR 整合
- OCR の zod (`ocr.ts:32-37`) / JSON Schema (`lib/ai/schemas/ocr-response.ts:57-70`) とも `text` 空許容。
  process.ts insert に空除外なし。**現状 OCR が空 option を出せば既にそのまま永続化される**。
  プロンプト (`lib/ai/prompts/ocr-extract.ts:230`) は本文前提だが「空にするな」とは明示せず。
  → 表示・採点側 (C/D) は**既に OCR 由来の空 option に無防備**。「空も保存」案はこの無防備状態を
  編集経路にも広げることを意味する。

### 新たに必要になる対処 (トレードオフ)
「空も保存」にすると、保存時の空除外を**演習表示時の空除外**に移すだけで、空肢を出さない要件自体は
消えない (`session-runner.tsx:432` 付近に `.filter(o => o.text.trim())` を足す等)。さらに「空を正解に
した放置カード」「optionCount 膨張」への対処も新規発生。

---

## 調査軸4: 代替案との比較 (事実のみ)

| 観点 | 「空も全部保存」案 (本調査) | 1-a (merge で編集中 ghost のみ保持・放置空 drop) |
|---|---|---|
| 変更箇所 | 4 箇所: `validation/card.ts:19` / `apply-card-mutation.ts:71` / `bulk route.ts:101` / `inline-option-row.tsx:155` + 演習表示に空除外を新設 | 1 箇所: `inline-option-row.tsx:114-122` (merge の `localGhosts` を auto-edit/focus 中のみ保持に絞る) |
| schema 変更 | 不要 (jsonb・制約なし) | 不要 |
| server への影響 | あり (zod 緩和) | なし (client working-set のみ) |
| 演習/採点への影響 | あり (空ボタン出題・空正解肢の罠・optionCount 膨張、対処新設要) | なし (永続化値は従来通り空除外済) |
| 複雑度 | 「保存の空除外」を「表示の空除外」に移動。除外要件は残存 | merge の localGhosts 絞り込みロジックを追加 (ghost ライフサイクルに踏み込む) |
| 副作用 | 空を正解にした放置カードが演習で破綻し得る (D) / OCR の無防備を編集にも拡大 (F) | 70d0714 の typing 保護を壊さず放置空を消す要件の実装精度に依存 |

### 「空も保存」でユーザーが空肢を放置したまま保存した試験の懸念
- **あり**。`session-runner.tsx:431-468` は空除外しないため、放置された空 option はそのまま空肢として
  出題される。演習表示側に空除外を入れない限り「空のボタンを含む問題」になる (軸3-C/D)。

---

## 修正の選択肢 (推奨なし・列挙のみ)
- **(I) 空も全部保存** (本調査案): 軸2 の 4 箇所変更 + `session-runner` 表示に空除外を新設。
  schema 非変更。「保存の空除外」を「表示の空除外」へ移動する形。空正解肢・optionCount への
  追加対処要。
- **(II) 1-a (merge で放置空 drop)**: `inline-option-row.tsx:114-122` のみ。永続化・演習・採点に
  非干渉。前提レポートの推奨候補。
- **(III) 1-b (blur で空 ghost 除去)**: `inline-option-row.tsx:211-221` (`handleCellSave`)。client のみ。
- **(I) と (II)/(III) は排他ではない** (保存方針 vs working-set ライフサイクルの別レイヤ)。

---

## 根拠ファイル一覧
- schema: `lib/db/schema.ts:41-46`(型) / `:266-267`(列)
- 編集 zod: `lib/validation/card.ts:14-27`(空 refine :19) / `lib/cards/apply-card-mutation.ts:69-75` / `app/api/card-mutations/bulk/route.ts:99-105`
- client sanitize (砦): `app/(app)/app/exams/[id]/_components/inline-option-row.tsx:153-162`
- merge (70d0714 回帰): `inline-option-row.tsx:114-122`
- 出題/採点: `app/(app)/app/study/smart/_components/session-runner.tsx`(描画 431-468 / 判定 201-209) / `study/smart/_lib/equal-set.ts:4-12`
- server 採点非関与: `app/api/review-events/bulk/route.ts:95-97, 208-211`
- 集計: `lib/exams/list.ts:187` / `app/(app)/app/upload/_actions/process.ts:651`
- OCR: `lib/ai/ocr.ts:32-37` / `lib/ai/schemas/ocr-response.ts:57-70` / `process.ts:510-523`
