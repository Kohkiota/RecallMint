# S2.0 事前調査 — 問題編集画面 (Notion DB ライク card 編集 + tag schema 移行)

- 日付: 2026-05-22
- 種別: 事前調査 (codebase trace + 設計選択肢列挙のみ、 実装変更 0、 doc 1 file)
- branch: `develop` (`3876df9` から開始)
- **本 doc は修正方針を提示しない**。 各設計選択肢は trade-off 込みで列挙、 採用案 selection は claude.ai + OT が後段で決定する。

## 背景

S1.9.x シリーズ完了で launch 阻害要因は解消。 S2 sprint 順序を再整理 ([[s2-sprint-reorder]]):

- **S2.0** (本 sprint): 問題編集画面 — cards / tags 編集 (Notion DB ライク UI)
- **S2.1**: スマート復習モード (FSRS due-based、 旧 S2.0)
- **S2.2**: dashboard 強化 (tag 別正答率 + FSRS state 円グラフ)
- **S2.3**: カスタム演習モード (tag フィルタ)

問題編集を先頭に置く理由: OCR 結果は不完全で編集できないと使い物にならない / スマート復習の前に問題を正しい状態にする必要 / dashboard 集計対象の tag も編集機能なしでは追加できない。 → **問題編集が後続全機能の前提**。

旧 S2.0 (スマート復習) 事前調査 (`2026-05-22-s2-0-smart-review-investigation.md`、 commit `3876df9`) は S2.1 で再利用するため温存。 本 doc が新 S2.0 の事前調査。

S2.0 の対象 (kickoff 提示の確定機能リスト):

1. schema 設計 + migration (`cards.custom_props` → `exams.tag_keys` + `card_tags`)
2. OCR 経路改修 (discover 返り値を tag_keys / card_tags に分解保存)
3. 一覧表 (sort / pagination / checkbox)
4. セル popover 編集 (single / multi select)
5. option 編集 (rename / 色 / 削除、 全 card 連動)
6. 一括編集 (削除 / tag 付与 / tag 削除 / tag 値書き換え)
7. 個別 card 編集 page (問題文 / 選択肢 / 正答 / 解説)
8. tag manager (key CRUD / single→multi 変更 / option 並び替え)

## 確定済の設計判断 (OT 合意済、 本 doc の前提)

**tag schema・ストレージ方式は確定済** (kickoff で DDL レベルまで提示)。 本 doc はこれを所与とし、 schema 形そのものは論点化しない:

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

- tag 定義は **exam に属する** (1 exam = 1 set of tag_keys)、 card には ID 参照で付く
- `option_id` は **key 内の integer sequence** (key を跨いで一意ではない — 上記 `id:1` が 2 key に出現)
- card_tags が option_id を参照 → tag 側 (exams.tag_keys) で option の value / color を変えると全 card 自動連動
- single / multi 切替対応。 **multi→single は不可** (1 card 複数値の data loss 回避)
- OCR 時は全 key を single_select として **auto 追加**。 後から user が single→multi 変更可
- 既存 exam への追加 upload 時、 未登録 key は **auto 追加**
- Gemini 責務は現状維持 (discover mode で freeform `custom_props` を返す)。 system (`processUpload`) が jsonb を tag_keys + card_tags に分解保存
- tag value rename は tag manager 経由 (一覧側の一括編集とは別 UI)

---

## 0. エグゼクティブサマリ (kickoff「期待発見ポイント」への回答)

| # | 確認事項 | 結論 |
|---|---|---|
| 1 | 既存 card 編集 logic はどこまで実装済か | **皆無**。 `createCard` / `updateCard` / `deleteCard` / `bulkUpdateCards` 全未着手。 `/app/cards/[id]` route 不在。 exam 詳細 page は read-only の flat list (tab 構成なし)。 |
| 2 | OCR 経路の transaction 境界、 card_tags 追加で肥大化しないか | cards bulk INSERT は現状 source_documents 更新 transaction の **外** で先行実行 (`process.ts:483`)。 tag_keys / card_tags 書込を足すと transaction 境界の再設計が要る (§8)。 |
| 3 | shadcn-ui / 既存 component 再利用性 | UI primitive は `button` / `card` / `input` / `label` / `textarea` のみ。 `table` / `popover` / `checkbox` / `select` / `dialog` は不在。 ただし `radix-ui` v1.4.3 (統合 package) + `shadcn` CLI は導入済 → これらの wrapper 追加は **新規 npm 依存ゼロ**。 例外は drag-and-drop。 |
| 4 | 既存 custom_props データ量と migration 工数 | 接続 DB (`.env.local` の DATABASE_URL) は user 13 / exam 10 / card 339 / review 0。 **custom_props は全 339 card が `{}` (空)**、 `cards.tags` text[] も全件空。 移行すべき実データがゼロ。 |
| 5 | sprint 分割の妥当な切れ目 | 「個別 card 編集 (schema 変更不要)」 と 「tag schema 移行 + Notion 風一覧 + tag manager」 の間に明確な切れ目がある (§9)。 |

主要発見ポイント:

- **D1**: card CRUD は spec §3 に定義があるが実装は全未着手。 exam 詳細 page (`/app/exams/[id]`) は S1.7 で作った read-only viewer で、 spec §3 が想定する tab 構成 (カード / アップロード / インポート / 設定) を持たない flat list。
- **D2**: **custom_props は DB 上 全 339 card が空 `{}`** (pg_column_size avg / max = 5 byte = `'{}'`)。 `cards.tags` text[] も全件空、 `reviews` も 0 行。 → migration 項目 (custom_props → card_tags) は **移行すべきデータが実質存在しない**。 ただし接続先は `.env.local` の DB であり、 production が別 Neon branch の場合は OT 側で同 query の再確認が要る。
- **D3**: kickoff の新 schema (`exams.tag_keys` + `card_tags`、 `custom_props` DROP) は、 **tech-spec / `docs/research/ocr-schema-vs-discover.md` の「discover mode 一本化・exam 単位の事前定義は不要」 という明文化済の設計判断を反転させる**。 spec §2.5.1 / §2.5.2 / §2.9 / §3 / §8 と research doc の改訂が伴う。 役割境界ルール上、 spec 改訂は OT 合意を前提とする。
- **D4**: UI primitive 在庫は 5 種のみ。 `table` / `popover` / `checkbox` / `select` / `dialog` は未導入だが、 `radix-ui` 統合 package と `shadcn` CLI が既に依存に入っているため wrapper 追加で新規依存は増えない。 **唯一 drag-and-drop ライブラリ (tag option 並び替え用) が未導入** → CLAUDE.md「ライブラリ導入時は事前相談」 に該当 (§7.5 / §9)。
- **D5**: OCR は discover mode で freeform `custom_props` を返し続ける一方、 保存層は exam 単位の schema (tag_keys) に正規化する **「OCR は discover・保存は schema」 の二層構造** になる。 多 upload で discover の key 揺れ / 値揺れが起きると、 同 exam に重複 tag_key / 重複 option が生える。 auto 追加方針 (OT 確定) と相まって、 tag manager での後 merge が前提運用になる (§8)。
- **D6**: kickoff の `card_tags` DDL は `(card_id, key, option_id)` のみで **`user_id` 列を持たない**。 CLAUDE.md 絶対ルール「DB の全テーブルに `user_id` カラム必須、 クエリは `WHERE user_id = ?` で絞る」 と `schema.ts` の「ルール B」 (idempotency 3 表を除く全 table が user_id を持つ) に抵触する。 また `card_tags.key` は text 非正規化のため、 key 名 rename は card_tags 行の cascade UPDATE が要る (option の value/color 変更のような構造的自動連動ではない)。 確定 schema 上に残るこれらの実装論点は §6.2。

判断必要: yes (設計選択肢 §5〜§9、 採用は claude.ai + OT)

---

## 1. tech-spec 関連記述の整理

### §2.5.1 exams / §2.5.2 cards (spec 247-405 行)

- 現 schema (`lib/db/schema.ts`) と spec §2.5.1/§2.5.2 は一致。 `exams` は `tag_keys` 相当の列を持たない。 `cards.custom_props` は `jsonb notnull default '{}'`、 GIN index `cards_props_gin_idx` 付き。
- spec §2.5.1 設計メモ: 「カスタムプロパティのキー名・値は `cards.custom_props` (freeform jsonb) に分散して持つ。 **試験単位の事前定義は不要 (discover mode 一本化)**」 — 新設計はこの一文を反転させる (D3)。
- `cards` には新設計と無関係に `tags` text[] 列が既存 (「S3 で一括編集 UI を実装、 S1a で先打ち」 のコメント付き)。 全件空 (§4)。 新 `card_tags` テーブルと機能が重複するため、 この列の存廃も論点 (§6)。
- spec §2.5.2 バリデーション: `correct_answer_ids` は `options[].is_correct` のデノーマ、 書込時に `options.filter(o => o.is_correct).map(o => o.id)` で同期。 複数正答 UI 切替は `options.filter(o => o.is_correct).length` で自動判定 (§5)。

### §2.9 よくあるクエリ例 (spec 560-635 行)

- 「カテゴリ別正答率」「重要度フィルタ」「multi_select フィルタ」 の 3 例はいずれも `custom_props->>'...'` / `@>` 演算子に依存。 custom_props を DROP するとこれらは **card_tags JOIN ベースに全面書き換え**になる。 GIN index も dead 化。
- これらの query は現状コードに実装されておらず (S2.1 演習フィルタで初使用)、 spec 上の例示に留まる。 → S2.0 で書き換えても既存コードの破壊はない。

### §3 Authenticated Routes / Server Actions (spec 670-737 行)

- spec §3 は `/exams/[id]` を **タブ構成 (カード / アップロード / インポート / 設定)** と明記。 実 route prefix は `/app/`、 現状の `/app/exams/[id]` は tab なし read-only。
- spec §3 は `/cards/[id]` を「カード詳細編集」 と明記 → kickoff の「個別 card 編集は `/app/cards/[id]` 専用 page 推奨」 と整合。
- card 系 server action は spec §3 に定義済 (シグネチャは §2)。 ただし **全未着手** (§2)。 `bulkUpdateCards(ids, action)` の `action` は spec で `setCustomProp | delete | export | resetStatus` — 新設計では `setCustomProp` を tag 操作 (付与 / 削除 / 値書換) に置換する必要があり、 spec §3 の追補対象。

### §8 Logic 4 / Logic 5 (spec 1032-1048 行)

- Logic 4 (演習フィルタ、 S2.1) の `customPropFilters` は custom_props 前提。 S2.0 で schema を変えると S2.1 のフィルタ仕様も card_tags ベースへ要追従。
- Logic 5 (CSV インポート) も「任意ヘッダ列 → custom_props」。 S2.0 schema 変更の影響を受ける (CSV インポートは現状未実装のため破壊なし、 spec 追補のみ)。

### spec 改訂対象のまとめ

新 schema 採用時に追補が要る spec 箇所: §2.2 / §2.5.1 / §2.5.2 / §2.8 (index 一覧) / §2.9 / §3 (routes + server actions) / §8 Logic 4・5、 および `docs/research/ocr-schema-vs-discover.md` の「一本化判断」。 役割境界ルール (実装中に spec を書き換えない) に従い、 spec 改訂は S2.0 の設計フェーズ or closure で別タスク化する。

---

## 2. 既存 Server Action / API の状況

| 対象 | 状態 | trace 結果 |
|---|---|---|
| `createCard` / `updateCard` / `deleteCard` | **未着手** | grep ヒット 0。 cards への UPDATE / 単体 DELETE 経路はコード全体に皆無。 |
| `bulkUpdateCards` | **未着手** | grep ヒット 0。 |
| `deleteExam` | 実装済 | `exams/_actions/delete-exam.ts`。 owner-scoped 単一文 DELETE → FK CASCADE で cards / reviews 連動削除。 |
| `createExam` / `updateExam` / `archiveExam` | **未着手** | exam を新規作成するのは現状 OCR (`processUpload` の mode='new') のみ。 手動 exam CRUD は無い。 |
| `processUpload` (OCR) | 実装済 | cards bulk INSERT を内包 (§8)。 |

**既存 Server Action のパターン** (`deleteExam` で確認):

- `'use server'` ヘッダ、 `getCurrentUser()` で auth gate → `{ ok: false, error: '認証が必要です' }`
- owner-scoped クエリ (`WHERE user_id = ?` 必須、 CLAUDE.md テナント分離ルール)
- 副作用後に `revalidatePath()` を `finally` で実行
- 戻り値型 `ActionResult<T>` (`lib/actions/result.ts`): `{ ok: true; data?: T } | { ok: false; error: string }`
- client 側は `useTransition` + phase state machine で呼ぶ (`delete-exam-button.tsx`: idle / confirm / deleting / error の 2 段 confirm UI)

card CRUD 群はこのパターンを踏襲して新設する。 配置は spec §4 / 既存 convention に倣い `app/(app)/app/cards/_actions/` または `exams/[id]/_actions/`。

---

## 3. UI 既存状況

### route

| route | spec 想定 | 実態 |
|---|---|---|
| `/app/exams/[id]` | カードタブ含む tab 構成 | **read-only flat list** (`<ul>` + Card)。 編集 / 削除 / フィルタ / tab なし。 page 冒頭コメントに「S2 で正式 CRUD」。 |
| `/app/cards/[id]` | カード詳細編集 | **不在**。 `app/(app)/app/cards/` ディレクトリ自体なし。 |

`AppPath` 型 (`_actions/revalidate.ts`) の literal は `/app` `/app/settings` `/app/quiz` `/app/upload` `/app/exams` のみ。 `/app/cards/[id]` を `<Link onClick>` で revalidate する場合、 型追加が要る (コメントに「`/cards/[id]` は後続 Sprint で追加」 と既記)。

### card 表示 component の在庫

- read-only 表示は 2 箇所に重複: `exams/[id]/page.tsx` と `upload/result/[sourceDocumentId]/page.tsx`。 いずれも `lib/exams/list.ts` の `CardListEntry` (`id` / `title` / `sortKey` / `questionTextSnippet` / `optionCount` / `customPropKeys`) を表示。 表示専用 subset で、 編集 UI の土台にはならない。
- 編集可能な card display / form component は **存在しない**。

### UI primitive / shadcn 在庫 (D4)

- `components/ui/`: `button` / `card` / `input` / `label` / `textarea` のみ。
- **不在**: `table` / `popover` / `checkbox` / `select` / `dropdown-menu` / `dialog` / `toast`。
- ただし依存には `radix-ui` v1.4.3 (= 統合 package、 全 primitive を再 export。 `button.tsx` が既に `import { Slot } from "radix-ui"`) と `shadcn` CLI v4.6.0 が入っている。 `components.json` も設定済 (style `radix-nova` / baseColor `neutral`)。 → `popover` / `checkbox` / `select` / `dialog` / `dropdown-menu` の wrapper 追加は **新規 npm 依存を増やさない**。 `table` は素の markup で primitive すら不要。
- 例外: tag option の drag-and-drop 並び替えに使える primitive は radix-ui に無い。 `@dnd-kit/*` 等の新規依存、 または上下ボタン方式で代替 (§7.5 / §9)。
- client 操作の既存パターン: `useState` + `useTransition` + server action (`delete-exam-button` / `upgrade-plans` / `upload-form` / `contact-form`)。 toast 系は未導入で、 feedback は inline 表示 (`delete-exam-button` の error phase) で行っている。

---

## 4. custom_props の現状データ (DB 実測)

接続先: `.env.local` の `DATABASE_URL` (Neon、 ap-southeast-1)。 **read-only SELECT のみ実行**。

| 指標 | 値 |
|---|---|
| users / exams / cards / reviews | 13 / 10 / 339 / 0 |
| custom_props 非空 (`<> '{}'`) の card | **0 / 339** |
| custom_props の distinct top-level key | 0 件 |
| pg_column_size(custom_props) avg / max | 5 byte / 5 byte (= `'{}'::jsonb`) |
| `cards.tags` text[] 非空の card | **0 / 339** |
| card 最多の exam | 120 件 (2 exam が 120、 残りは 13〜31) |

発見:

- **discover mode の OCR は custom_props を 1 件も生成していない**。 OCR prompt (`lib/ai/prompts/ocr-extract.ts`) の discover ルールは「文書に明示記載のメタデータのみ抽出、 無ければ custom_props 自体を省略」。 投入された試験 PDF に問題ごとの明示メタデータが無かったため、 全 card が `{}` のまま保存されている。
- → **migration の「既存データ移行」 step は実質 no-op**。 移行失敗 / rollback のリスクは、 少なくとも本 DB では存在しない。 重いのは migration script ではなく、 確定 schema 上に残る実装論点 (§6.2) と spec 改訂 (§1)。
- 注意: 本 DB が production 兼用か別 branch かは OT が把握。 production が別 Neon branch なら同 query (`SELECT count(*) FILTER (WHERE custom_props <> '{}') FROM cards`) の再確認を推奨。 実 exam の PDF に明示メタデータ (試験回 / 分野 等) が載っていれば production 側には実データがあり得る。
- `reviews` 0 行 = スマート復習 (S2.1) 未実装のため学習履歴ゼロ。 card 一括削除時に CASCADE で消える review も現状ゼロ。

---

## 5. options / correct_answer_ids 編集の論点

個別 card 編集 (問題文 / 選択肢 / 正答 / 解説) で必ず扱う整合性ルール (spec §2.5.2):

- `options: CardOption[]` = `{ id, text, is_correct, explanation? }`。 `id` は OCR が `"a","b",...` または `"1","2",...` を昇順採番 (UUID ではない)。
- `correct_answer_ids: string[]` は `options[].is_correct` の **デノーマ**。 書込時に `options.filter(o => o.is_correct).map(o => o.id)` で再生成する。
- 単一 / 複数正答の判定は `options.filter(o => o.is_correct).length` で自動 (追加カラム不要)。

論点:

- **5.1 正答の真実 source**: UI で正答を編集するとき `options[].is_correct` を編集して `correct_answer_ids` を派生させるか、 逆か。 spec は `is_correct` を source とする。 → 編集 UI は「各選択肢に正答チェック」 を持ち、 保存時に `correct_answer_ids` を再計算する形が spec 整合。
- **5.2 option id の採番**: 選択肢を追加 / 削除 / 並び替えしたとき id をどうするか。 (a) 既存 id を維持し新規のみ採番 (`correct_answer_ids` / 本文中 `![](key)` 参照と整合維持しやすい) / (b) 保存ごとに `a,b,c...` を振り直し (見た目順と一致、 ただし参照崩れ)。 option には本文画像参照は無いので (b) でも実害は限定的だが、 論点として残す。
- **5.3 単一 / 複数正答の UI**: 正答 0 個 (OCR が正答未記載で全 false にしたケース) を許すか。 spec §2.5.2 バリデーションは「`correct_answer_ids` 最低 1 個」 を要求するが、 OCR prompt は「正答記載が無ければ空配列」 を許す。 編集画面で正答 0 を保存ブロックするか警告に留めるかは論点。
- **5.4 整合性チェック**: 本文 / option / explanation 中の `![](key)` と `images[]` の対応は「警告表示・ブロックしない」 (spec §2.5.2、 Anki Check Media 相当)。 編集画面に出すか S2.0 スコープ外とするかは論点。
- バリデーション規模: `title` 非空 / `options` 1〜50 個 / `options[].id` card 内ユニーク / `correct_answer_ids ⊆ options[].id` 等。 server action 側の zod schema として新設 (現 `lib/validation/` には contact のみ)。

---

## 6. migration 設計の論点

### 6.1 確定 schema (再掲・確認のみ)

ストレージ形は確定済 (冒頭「確定済の設計判断」): `exams.tag_keys` jsonb 列 + `card_tags` テーブル + `cards.custom_props` DROP。 → 「jsonb 列 vs 正規化テーブル」 の選択は論点ではない。 以下は **確定 schema の上に残る実装論点**。

### 6.2 確定 schema 上に残る実装論点

- **(i) card_tags の `user_id` 列 (D6)**: kickoff DDL は `(card_id, key, option_id)` のみ。 CLAUDE.md「全テーブルに user_id 必須・`WHERE user_id` で絞る」 / `schema.ts` ルール B に抵触。 (a) `user_id uuid FK` 列を追加 (既存 mcq 全テーブルと convention 整合、 owner-scoped query を直接書ける) / (b) 列を持たず `card_id → cards` JOIN で owner 絞り (テーブルは薄いが全 query に JOIN 必須)。 → 既存 convention 上は (a) が素直。
- **(ii) single_select の一意性**: PK `(card_id, key, option_id)` は「1 card × 1 key に複数 option 行」 を許す = single_select の「1 値のみ」 を DB が担保しない。 multi は複数行が正のため一律 unique は不可。 → single の「1 key 1 値」 をアプリ層で enforce (set 前に同 `(card_id, key)` 行を DELETE) するか、 single 専用の部分 unique index 相当を別途設計するかが論点。
- **(iii) key rename の伝播**: `card_tags.key` は text 非正規化。 option の value / color rename は card_tags が option_id しか持たないため構造的に自動連動するが、 **key 名 rename は `card_tags.key` の cascade UPDATE が必要** (tag manager の key rename 実装に含める)。
- **(iv) option_id 採番**: `option_id` は key 内の integer sequence。 option 削除後の次 id を monotonic 採番にするか reuse するか。 reuse は過去 card_tags 行との意図せぬ再結合 risk があり monotonic 推奨域だが、 論点として残す。

### 6.3 移行の段階分け (kickoff 調査項目 6 の a/b/c)

- **(a) 1 migration ファイルで完結**: テーブル / 列追加 + data 移行 + `custom_props` DROP を 1 ファイル。 data が空 (§4) なので移行 step は no-op。 rollback = migration revert。
- **(b) 2 段階**: 「テーブル追加 + コード切替」 を先行 migration、 `custom_props` DROP を後続 migration。 新旧コードが両対応できる窓ができる (deploy の安全余裕)。
- **(c) `custom_props` 列を温存 (DROP しない)**: dead column + dead GIN index が残るが、 data 0 の今は重複データすら発生しない。 将来の discover 生データ退避先として残す選択も。
- 補足: §4 のとおり実データが空なので「移行失敗時 rollback」 はほぼ非論点。 段階分けの主目的は data 安全性ではなく **deploy 時のコード新旧整合**。 user 0-1 段階なら (a) でも実害は小さい。

### 6.4 既存 dead 列の扱い

- `cards.tags` text[] (全空、§4) は新 `card_tags` と機能重複。 同 migration で DROP するか、 別 migration に分けるか、 温存するかを論点に含める。 DROP しても参照コードは無い (`processUpload` が `tags: []` で INSERT しているのみ → その 1 行も要修正)。
- `cards_props_gin_idx` (custom_props GIN index) は custom_props DROP と同時に消える。

---

## 7. UI / UX 詳細の設計選択肢

### 7.1 一覧表ライブラリ

- **(a) 自前 React table**: 依存ゼロ。 sort / pagination / checkbox / セル編集を全部自前。 機能が増えると肥大。
- **(b) TanStack Table**: sort / pagination / 列モデルが揃う。 **新規 npm 依存** → 事前相談対象。 headless なので描画は自前。
- **(c) shadcn `table` (素の markup) + sort / pagination 自前**: `table` component は primitive 不要の素 markup で新規依存ゼロ。 sort / pagination ロジックのみ自前。 既存 UI 在庫と一貫。
- 規模感: 現状 1 exam 最多 120 card、 spec 想定は数百〜数千。 数千規模なら仮想スクロール検討余地あり (それ自体さらに dep)。

### 7.2 セルクリック popover

- **(a) shadcn `popover` (radix-ui Popover の wrapper)**: `shadcn add popover` で生成、 新規依存ゼロ (radix-ui 導入済)。 a11y / focus trap / positioning が揃う。
- **(b) radix-ui Popover を直接 import**: wrapper を挟まず使用。 styling を都度書く。
- **(c) 自前 absolute positioning**: 依存ゼロだが clip / scroll / a11y を自前。 非推奨寄り。

### 7.3 個別 card 編集の配置

- **(a) `/app/cards/[id]` 専用 page** (OT 推奨 / spec §3 想定): 画面領域を広く取れる。 `AppPath` 型追加が付随。
- **(b) `/app/exams/[id]/cards/[id]` nested route**: exam 文脈を URL に保持。 戻り先が自然。 route 階層が深い。
- **(c) 一覧画面のモーダル**: 遷移ゼロだが問題文 / 選択肢 / 解説の編集には窮屈 (kickoff 指摘)。

### 7.4 ページネーション戦略

- **(a) offset / limit (page 番号)**: 実装単純、 ジャンプ可。 大 offset で重くなる (数千規模で顕在)。
- **(b) cursor-based (`sort_key` + `id`)**: `cards_sort_idx (user_id, exam_id, sort_key)` がそのまま効く。 page ジャンプ不可。
- **(c) infinite scroll**: 一覧編集 UX とは相性が中程度 (現在地把握が弱い)。
- 補足: 既存 `getCardsForExam` は全件取得 (`ORDER BY sort_key, created_at`)。 pagination 化で本関数の改修 or 別関数化が要る。

### 7.5 tag manager の配置

- **(a) 一覧画面内の drawer / sidebar**: 文脈を保ったまま key 編集。 一覧と同居で画面が混む。
- **(b) `/app/exams/[id]/tags` 専用 page**: 編集領域を確保。 一覧との往復が増える。
- **(c) 一覧 header の button → modal**: 軽量。 option 並び替え (drag) を載せると modal が手狭。
- option 並び替え: drag-and-drop は新規依存 (`@dnd-kit/*` 等) → 事前相談。 上下ボタン / `order` 数値入力なら依存ゼロ。 MVP は後者で drag を v1.x、 という分割も選択肢。

### 7.6 tag value の色

- **(a) 固定 default 色 set (Notion 流の十数色)**: OCR auto 投入時は palette から決定的に割当 (key/値 hash 等)。 user は palette から選び直し。
- **(b) 自由カラーピッカー**: 自由度高、 配色が散らかる。 picker UI のコスト。
- kickoff 確定: 初期 OCR 投入時は default 色固定。 → (a) を基線に、 user 変更を palette 選択に限るか free picker まで許すかが残論点。

### feedback (補足論点)

bulk 操作 / セル保存の成否表示。 現状 toast 基盤なし。 (a) 既存 inline phase 表示パターン踏襲 / (b) radix-ui `Toast` を新規 wrapper 化 (依存ゼロ) / (c) `sonner` 導入 (新規依存)。

---

## 8. OCR 経路改修の論点

現状の `processUpload` (`app/(app)/app/upload/_actions/process.ts`):

1. OCR pipeline → `pipelineResult.cards` (discover、 `custom_props?: Record<string,string|string[]>`)
2. `cardRows` を組み、 **transaction の外** で `db.insert(cards).values(cardRows).returning(...)` (`process.ts:466-486`)。 現状 `customProps: c.custom_props ?? {}`、 `tags: []` をそのまま格納。
3. その後 **別 transaction** で `source_documents` 更新 + `upload_records` append (`process.ts:522-541`)。

新設計での改修点:

- **8.1 分解保存ロジック**: discover の `custom_props` (card 単位の `{ key: value | value[] }`) を、 ① 当 upload 内の全 card を集約して全 key / 全値を抽出 → ② `exams.tag_keys` を構築 (mode='new') / 既存 tag_keys に未登録 key を merge (mode='existing') → ③ 各 card の custom_props を `card_tags` 行に分解、 という多段処理。 OCR pipeline 自体 (Gemini prompt / schema) は変更しない (kickoff 確定)。
- **8.2 transaction 境界**: `processUpload` には DB phase が 3 つある — ① guard transaction (advisory xact lock + in-flight check + quota + exam/source_documents INSERT、 `process.ts:218`)、 ② cards bulk INSERT (**単独・transaction 外**、 `process.ts:483`)、 ③ 完了 transaction (source_documents UPDATE + upload_records append、 `process.ts:522`)。 S1.9.4 の advisory xact lock は ① の guard tx 内だけで保持され OCR pipeline 実行前に解放される — **②③ および新規の tag 書込は lock 保護外**。 tag_keys 構築 (exams UPDATE) + card_tags bulk INSERT をどの phase に置くか (② と同 tx にまとめる / 新 phase を足す) が論点。 OCR は ≤150 page で card 数百規模になり得るため、 card_tags 行数 = card 数 × key 数 で bulk INSERT 規模が膨らむ点に注意。
- **8.3 mode='existing' の key 揺れ**: discover mode は upload ごとに key 名 / 値表記が揺れ得る (research doc は 5 試験でキー揺れ 0 と報告するが保証ではない)。 同 exam への複数 upload で「カテゴリ」 と「分類」、 「高」 と「高い」 が別 tag_key / 別 option として auto 追加され得る。 auto 追加方針 (OT 確定) の下では、 重複は tag manager の rename / merge で後始末する運用になる。 → tag manager に **merge (2 つの key / option を 1 つに統合)** 機能を入れるかが論点 (kickoff の機能リストに merge は明記なし)。
- **8.4 single 固定 auto 追加**: OCR auto 追加は全 key を single_select 扱い (kickoff 確定)。 ただし discover が `value[]` (配列) を返した key は本来 multi。 配列値を single に押し込むと値が失われる / 連結される。 → auto 追加時に「配列値の key は multi で追加」 する例外を設けるか、 一律 single にして user 変更に委ねるかが論点 (`ocr-response.ts` schema は `string | string[]` を許容済)。

---

## 9. sprint scope の評価と分割案

### 機能別の工数感 (Claude Code 視点、 相対)

| # | 機能 | 規模 | 主因 |
|---|---|---|---|
| 1 | schema 設計 + migration | 中 | data 移行は no-op (§4)。 確定 schema 上の実装論点 (§6.2: user_id 列・single 一意性 等) と spec 改訂が重い。 |
| 2 | OCR 経路改修 | 中〜大 | 分解ロジック多段 + transaction 再設計 + key 揺れ (§8)。 |
| 3 | 一覧表 (sort / pagination / checkbox) | 中 | 在庫 component なし、 一から。 |
| 4 | セル popover 編集 (single / multi) | **大** | Notion 風 inline 編集は client state / 楽観更新 / 保存粒度が複雑。 |
| 5 | option 編集 (rename / 色 / 削除、 全 card 連動) | 中〜大 | exams.tag_keys jsonb の部分更新。 option 削除時の card_tags cleanup。 |
| 6 | 一括編集 (削除 / tag 付与 / 削除 / 値書換) | 中 | 選択 state + bulk server action。 |
| 7 | 個別 card 編集 page (問題文 / 選択肢 / 正答 / 解説) | 中 | validation + options/correct_answer_ids 同期 (§5)。 **schema 変更に依存しない**。 |
| 8 | tag manager (key CRUD / single→multi / 並び替え) | **大** | single→multi migration ロジック + 並び替え (drag dep or 代替) + merge 検討 (§8.3)。 |

### 分割案 (kickoff の X / Y / Z)

- **(X) S2.0 一発で 1〜8 全部**: review / smoke が現実的に困難。 1〜2 ヶ月規模。 CLAUDE.md の Sprint 境界停止ルール・plan 行数上限とも噛み合わない。 → 非推奨。
- **(Y) 3 分割 (schema 先行型)**:
  - S2.0a: schema + migration (#1) + OCR 改修 (#2) + 個別 card 編集 page (#7) + 一覧の read 強化
  - S2.0b: Notion 風一覧 inline 編集 (#3 #4) + option 編集 (#5) + 一括編集 (#6)
  - S2.0c: tag manager (#8)
  - 利点: schema を最初に固める。 欠点: S2.0a が schema + OCR + 編集 page で既に重い。 #7 が #1 の schema 変更を待つ構造になる (実際には #7 は schema 非依存、 §6 参照)。
- **(Z) 2 系統に分離 (問題編集先行型)**:
  - S2.0: 個別 card 編集 page (#7) のみ。 **schema 変更なし** — 既存 `cards` 列 (title / question_text / options / correct_answer_ids / explanation_text) を編集するだけ。 migration ゼロ・OCR 改修ゼロ・新規依存ゼロで完結。 deleteCard も同梱可。
  - S2.1' (or S2.x): tag schema 移行 (#1) + OCR 改修 (#2) + Notion 風一覧 (#3〜#6) + tag manager (#8)。
  - 利点: §4 のとおり custom_props は空 = tag 機能に移行データ起因の緊急性がない。 #7 は schema・OCR・UI 在庫の前提を持たず単独で出荷できる最小単位。 spec §3 も `/cards/[id]` を独立 route として定義済。 欠点: 「Notion DB ライク一覧編集」 という kickoff の主目的が S2.0 では出荷されない (sprint 名 "問題編集画面" の解釈次第)。

### 切れ目の所見 (採用は OT)

- 最も自然な技術的切れ目は **「schema を触らない作業 (#7) / schema を触る作業 (#1〜#6, #8)」**。 #7 は他全機能の前提に乗らず、 単独で TDD・review・smoke が回る最小 sprint になる。
- tag manager の drag 並び替え (#8) は新規依存判断 (事前相談) を含むため、 どの案でも **独立 sub-task / 末尾**に置くのが安全。
- 確定 schema 上に残る実装論点 (§6.2: card_tags の user_id 列・single 一意性・key rename 伝播・option_id 採番) は #1〜#6, #8 すべての前提。 どの分割でも **§6.2 の確定を最初の閘門**にする。

---

## 10. plan 着手時の申し送り

- schema 形・ストレージ方式は確定済。 残る実装論点 (§6.2: card_tags の `user_id` 列、 single_select 一意性、 key rename 伝播、 option_id 採番) を plan 化前に確定する。
- 新 schema 採用は spec §2.2 / §2.5.1 / §2.5.2 / §2.8 / §2.9 / §3 / §8 と `docs/research/ocr-schema-vs-discover.md` の改訂を伴う (D3)。 役割境界ルールに従い spec 改訂は設計フェーズ / closure の別タスク。
- `radix-ui` + `shadcn` CLI が導入済のため popover / checkbox / select / dialog / table の追加は新規依存なし。 **drag-and-drop のみ事前相談が必要** — 採否を plan 着手前に決める。
- §4 のとおり接続 DB の custom_props は空。 production が別 branch なら OT 側で実データ有無を再確認 (migration の段階分け §6.3 の選択に影響)。
- `cards.tags` text[] 列 (dead) と `cards_props_gin_idx` の存廃 (§6.4) を migration 設計に含める。
- card CRUD は spec §3 にシグネチャ定義あり。 ただし `bulkUpdateCards` の `action` は custom_props 前提 → tag 操作へ再定義が要る (spec §3 追補)。
- OCR 経路 (§8) は Gemini prompt / schema を変えず、 `processUpload` の保存層のみ改修 (kickoff 確定)。 transaction 境界の再設計が伴う。

---

## 11. アウトプット / 次の一手

- 本 doc = 事前調査の単一成果物。 実装変更 0。
- 設計選択肢 (§5〜§9) の採用は claude.ai + OT が後段で決定。
- 決定後、 writing-plans skill で S2.0 plan を drafting (Sprint 境界停止ルールに従い、 plan は別タスク)。
- 本 doc を `develop` に commit (push しない)。
