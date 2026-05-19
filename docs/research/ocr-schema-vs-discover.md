# Research: OCR custom_props 設計 — schema mode と discover mode の比較、 一本化判断

> **目的**: PoC 期に併存していた schema mode と discover mode を比較し、 MVP では discover mode に一本化する判断の経緯と根拠を残す。 将来 v1.x で schema mode を復活させる場合の参照資料とする。
>
> **位置付け**: 設計判断記録 (decision record)。 Tech Spec / DB Schema には現時点で反映しない (OCR sprint で別途反映予定)。
>
> **作成日**: 2026-05-17
>
> **関連 PoC**: `scripts/ocr-poc/` (本ドキュメント作成時点ではまだ存在、 後に削除予定)

---

## 1. 背景

RecallMint は MCQ ベースの試験対策 SaaS で、 PDF / 画像から AI (Gemini 2.5 Flash) が問題を抽出し学習カード化する。 抽出時に問題ごとのメタデータ (試験回 / 章 / 分野等) を `cards.custom_props` (jsonb) に格納する。

PoC 期 (Sprint A-2 以前) は、 メタデータの抽出方式として 2 つのモードを設計していた:

- **schema mode**: 試験ごとに `exams.property_schema` で事前にキー名と enum 値を定義しておき、 AI に Gemini の responseSchema として注入する
- **discover mode**: 事前定義なし、 AI が文書から自由にキー名を発見して `custom_props` を埋める

5 試験 (登録販売者 / 看護師国試 / SAT / 宅建 / IPMA) で実測した結果、 MVP では **discover mode に一本化** する判断に至った。

---

## 2. 設計差

### 2.1 schema mode

事前定義した `PropertyDef[]` を Gemini API の `responseSchema` (OpenAPI subset) に変換する。

**型定義** (`scripts/ocr-poc/schema.ts`):

```ts
type PropertyType =
  | "single_select"
  | "multi_select"
  | "number"
  | "boolean"
  | "date"
  | "text";

type PropertyDef = {
  name: string;
  type: PropertyType;
  select_options?: string[];
  default_value?: unknown;
  is_system?: boolean;
  display_order: number;
};
```

**fixture 例** (`scripts/ocr-poc/fixtures/nursing-114/property_schema.json`):

```json
[
  {
    "name": "試験回",
    "type": "single_select",
    "select_options": ["第114回"],
    "display_order": 1
  },
  {
    "name": "区分",
    "type": "single_select",
    "select_options": ["午前", "午後"],
    "display_order": 2
  }
]
```

**API 経路**:

```ts
config: {
  responseMimeType: 'application/json',
  responseSchema: buildResponseSchema(propertySchema),  // OpenAPI subset
}
```

**特徴**:

- キー名 / 値が事前に縛られる → AI 出力が正規化される
- enum 制約により値揺れがゼロ (例: 「試験回」値は必ず `"第114回"`)
- DB 側に `exams.property_schema` 列が必要 (NOT NULL DEFAULT '[]'::jsonb)
- ユーザー / system が試験ごとに事前定義する手間が発生

### 2.2 discover mode

事前定義なし、 AI に「文書に明示的に書かれているメタデータを自由なキー名で抽出する」と指示する。

**API 経路** (`scripts/ocr-poc/schema.ts`):

```ts
config: {
  responseMimeType: 'application/json',
  responseJsonSchema: buildDiscoverResponseJsonSchema(),  // full JSON Schema
}
```

`custom_props` を `additionalProperties: { anyOf: [string, string[]] }` で受ける。 OpenAPI subset では `additionalProperties` 未対応のため、 `responseJsonSchema` (full JSON Schema) 経路を使う必要がある。

**prompt 概要** (最終推敲後、 `scripts/ocr-poc/prompt.ts` の `DISCOVER_CUSTOM_PROPS_RULES`):

```
文書に明示的に記載されている問題ごとのメタデータがあれば抽出する。

- キー名は文書中の表記に近い名前にする
- 明示記載のみ抽出。 推測や事前知識からの補完は禁止
- 値は文字列、 または複数値の場合は文字列配列
- 該当メタデータが無い問題は custom_props 自体を省略する
```

**特徴**:

- キー名 / 値の事前定義不要
- DB 側に追加列不要 (`cards.custom_props` jsonb のみで完結)
- AI 自由抽出 → キー揺れ / 値揺れの risk あり (要実測)

### 2.3 比較表

| 項目          | schema mode                       | discover mode                           |
| ------------- | --------------------------------- | --------------------------------------- |
| 事前定義      | 必要                              | 不要                                    |
| キー名揺れ    | なし (enum)                       | 実測で確認必要                          |
| 値正規化      | 完全                              | AI 判断                                 |
| DB 列         | `exams.property_schema` 必要      | 不要                                    |
| API 経路      | `responseSchema` (OpenAPI subset) | `responseJsonSchema` (full JSON Schema) |
| AI の認知負荷 | 低 (枠を埋めるだけ)               | 中 (キー名 / 値判断あり)                |
| UI 実装負荷   | 事前定義 UI 必要                  | カード単位の自由編集 UI のみ            |

---

## 3. 5 試験実測サマリ (2026-05-17 実施)

`scripts/ocr-poc/run.ts <exam> --mode discover --model flash` を 5 試験で実行。

| 試験                       | cards 数 | custom_props 埋まり | 検出キー                         | 評価                                             |
| -------------------------- | -------- | ------------------- | -------------------------------- | ------------------------------------------------ |
| ipma (PMP 認定)            | 31       | 31/31               | `KCI`                            | キー揺れ 0、 全 card 統一                        |
| nursing-114 (看護師国試)   | 36       | 0/36                | (なし)                           | 個別 card 明示記載無し → AI が省略、 prompt 通り |
| sat (Digital SAT)          | 33       | 33/33               | `Domain` / `Skill` / `Skill_Sub` | 3 階層タグ取得、 schema mode より情報量多い      |
| takken-r6-zentai (宅建)    | 7        | 0/7                 | (なし)                           | cards 数少ない (別問題、 PDF or Flash 起因)      |
| tourokuhanbai (登録販売者) | 60 (※1)  | 0/60 (※2)           | (なし)                           | 「明示記載のみ」ルール厳守の結果、 推敲後は全省略 |

**注記**:

※1: prompt 推敲過程で fixture を subset 18 問版に縮小した run もあるが、 表は全 60 問版で評価。

※2: prompt 推敲後 (commit b12f86e + 26a1c4e) は「推測補完禁止」が強化されたため、 各問題ページに試験名 / 試験回が明示されない tourokuhanbai では custom_props が省略される。 これは仕様通りの動作。 推敲前の 2026-05-17 14:51 run では AI が表紙の「令和7年度」「関西広域連合 登録販売者試験」を全 card に複製していた (推測補完寄りの挙動)。 推敲後の挙動 (省略) の方が prompt 仕様と整合している。

**所見**:

- キー揺れ: **0 件** (5 試験すべて、 同一試験内で同じキー名を維持)
- AI は「明示記載のみ抽出、 推測禁止」を厳守 (nursing-114 / tourokuhanbai で空、 sat では明示記載を完全に拾う)
- → discover mode の品質は MVP として採用可能と判断
- 「表紙メタを全 card に複製する」UX 補完は v1.x の論点として別途検討 (例: post-processing で `exams.name` から自動付与する layer 等)

---

## 4. prompt 推敲の経緯

実測過程で 2 つの副次問題が発覚し、 prompt 推敲で対処した。 schema 設計とは独立した品質改善。

### 4.1 副次問題 A: 正誤組合せ問題で a〜d 記述が question_text から欠落

**症状**: 登録販売 問61 等の正誤組合せ問題 (リード文 + a〜d 記述 + 1〜5 正誤組合せ表) で、 question_text にリード文しか入らず a〜d 記述が消える事象が discover mode で発生 (3 回中 2 回)。 schema mode では発生せず、 discover mode 切替で発生した点が観察事実。

**根本原因の仮説**: discover mode の `custom_props` ルールが「自由キー命名」「同義キー統一」「推測 vs 明示判定」と AI に同時抱えさせる判断タスクが多く、 question_text / options の境界判定に attention が回らなくなった。

**対処 1 (推敲)**: `DISCOVER_CUSTOM_PROPS_RULES` を圧縮。 「キー名統一」「具体例 (分野 / カテゴリ / tags 等)」を削除し、 判断負荷を schema mode 並みに下げた。

**結果**: 正誤組合せの a〜d 欠落は改善したが、 単独選択肢問題で「question_text に選択肢本文が重複する」新たな症状が発生した。

**対処 2 (推敲)**: `COMMON_EXTRACTION_RULES` の question_text 定義を明確化。 「通常はリード文のみ、 例外として正誤組合せの a〜d 記述は含める」と責務境界を明示。

```diff
- "- question_text: 設問本文。Markdown 可。図表参照は本文中にテキストで残す",
+ "- question_text: 設問本文。通常は、解答選択肢を除いたリード文のみを入れる。Markdown 可。",
+ "- options[].text に入れる各解答選択肢の本文は、question_text に重複させない。",
+ "- 例外: 正誤組合せ問題のように、a〜d / ア〜エ の各記述が解答選択肢ではなく、",
+ "  後続の 1〜5 等の組合せ表で参照される前提記述である場合、その a〜d / ア〜エ 記述は question_text に含める。",
+ "  この場合、options[] には 1〜5 等の組合せ表の各行を入れる。",
+ "- 図表参照は本文中にテキストで残す",
```

**結果**: 検証 2 回で問61 / 問89 / 問91 すべて 2/2 安定。 採用確定。

### 4.2 副次問題 B (未対応で許容): options[].text の表記揺れ

正誤組合せの options[].text が `"正 正 誤 誤"` / `"a 正 b 正 c 誤 d 誤"` / `"a:正, b:正, c:誤, d:誤"` 等で実行ごとに揺れる事象が残存。 PDF 原文は値のみだが、 AI が対応関係を付加することがある。

**判断**: 学習体験への実害なし (情報は保持されている)、 副作用 risk もあるため prompt では触らない方針。 アプリ側の正規化レイヤで対応するか、 そのまま保存して表示時に整形する設計とする。

### 4.3 副次効果 C (推敲後の挙動): 表紙メタが省略される

対処 1 + 2 適用後、 「表紙にしか試験メタが書かれていない教材」 (例: tourokuhanbai は表紙に「令和7年度 関西広域連合 登録販売者試験」、 個別問題ページに記載無し) では custom_props が空になる。

**評価**: これは「明示記載のみ」「推測禁止」ルールを厳守した結果で prompt 仕様通り。 nursing-114 (推敲前から 0/36) も同様の構造。 推敲前の tourokuhanbai が表紙情報を全 card に複製していたのは「推測補完寄り」の挙動で、 厳密には ANSWER_GROUNDING_RULES と同じ精神 (明示記載のみ) に反していた。 推敲後の挙動の方が仕様と整合する。

**v1.x の検討事項**: UX 補完として「表紙の試験名 / 試験回を全 card に複製する」要望は当然あるため、 以下の方針を v1.x で検討する:

- 案 A: prompt に「文書全体に共通する表紙情報は全 card に複製してよい」を追記
- 案 B: post-processing layer で `exams.name` 等から自動付与
- 案 C: ユーザー編集 UI で一括付与機能を提供

MVP では案 B / C のいずれかが現実的。 prompt 改変 (案 A) は他抽出への影響が読みきれないため最後の選択肢。

---

## 5. 一本化判断の根拠

### 5.1 discover mode 採用の根拠

1. **品質確認済**: 5 試験実測でキー揺れ 0、 階層タグ取得 OK、 推測補完なし
2. **DB シンプル化**: `exams.property_schema` 列が不要になり、 `cards.custom_props` (jsonb) のみで完結
3. **UI シンプル化**: 試験単位の事前定義 UI が不要、 ユーザーは OCR 後にカード単位で自由編集
4. **MVP との整合**: Tech Spec §2.6 「custom_property_definitions テーブル不採用」の方針と一致
5. **保守負荷低減**: PoC 期に併存していた schema mode の code 経路を削除でき、 保守対象が減る

### 5.2 schema mode 不採用の根拠

1. **事前定義 UI のコスト**: ユーザーに試験ごとに property_schema を定義させる UX 負荷
2. **OCR 前の手間**: discover mode なら PDF 投入即抽出、 schema mode は事前定義が必要
3. **柔軟性の欠如**: 試験仕様変更時に property_schema 更新が必要、 既存 cards との整合性問題
4. **MVP スコープ**: 「Notion-like 自由 schema」を目指す MVP に schema mode の硬さは不要

### 5.3 一本化に伴う削除対象

MVP 確定 (Sprint 完了時) で以下を削除:

**PoC 関連 (`scripts/ocr-poc/` ディレクトリごと撤去)**:
- `schema.ts` (型定義 + 全関数)
- `prompt.ts` (本実装 `lib/ai/` に役割移譲後)
- `run.ts` / `cost.ts` / `README.md`
- `fixtures/*/property_schema.json` 6 ファイル + `fixtures/` 配下の PDF / results
- `*_discover_keys.csv` 自動生成ファイル

**DB schema (`lib/db/schema.ts`)**:
- `PropertyType` / `PropertyDef` / `PropertySchema` 型定義 (行 37-58)
- `exams.propertySchema` 列定義 (行 237-240)
- 行 37 ヘッダコメント「Custom property schema types (exams.property_schema の TS 型)」
- 行 225 exams テーブルヘッダコメント内の「property_schema が肝」表現
- 行 287 cards テーブル内コメント「カスタムプロパティ (exams.property_schema に従って格納)」を「freeform key-value」に書換
- 行 427-428 の `Exam` / `NewExam` 型 export は column drop に自動追従 (TypeScript 推論) のため明示削除不要

**DB migration**:
- `exams.property_schema` 列 drop migration を `pnpm db:generate` で生成 (`drizzle/migrations/0002_*.sql` として作られる)
- staging → production の順で apply
- meta snapshot (`drizzle/migrations/meta/0002_snapshot.json`) は自動生成

**プロジェクト docs**:
- `CLAUDE.md` 行 8 の「exams.property_schema) でドメイン中立、 マルチテナント対応」を discover 一本化に合わせ書換

---

## 6. v1.x で schema mode を復活させたい場合

### 6.1 復活シグナル (参考)

以下のような状況が観察されたら schema mode 復活を検討:

- discover mode で AI が試験ごとに毎回違うキー命名を出すようになる (キー揺れが定常化)
- 試験別の custom_props 型不整合がユーザー体感に出る (例: 「高 / 高い / High」表記揺れ)
- CSV import で freeform 化により「型推定が外れる」苦情が累積
- 「この試験ではこのキーで統一したい」というユーザー要望

### 6.2 復活手順 (推定工数: 30 分 〜 1 時間)

1. `lib/db/schema.ts` に PropertyType / PropertyDef / PropertySchema 型を復元 (git history から copy)
2. `exams.property_schema` 列の add migration を生成 (`ALTER TABLE exams ADD COLUMN property_schema jsonb DEFAULT '[]'::jsonb NOT NULL`)
3. staging → production の順で migrate apply
4. `scripts/ocr-poc/` 系の schema mode 経路は git history から復元、 または白紙から再実装
5. OCR sprint の実装 (lib/ai/) に schema mode 分岐を追加

### 6.3 git history 参照ポイント

本ドキュメント作成時点 (commit 確定後にこの節を更新):

- schema mode 経路含む最終 commit: `26a1c4e` (prompt 推敲の最終 commit、 schema mode code がまだ残っていた最後の状態)
- PoC 完了状態の commit: `469b23a` (本 research doc 作成時点、 PoC code 削除前の最終状態)
- discover mode 一本化 commit: `0a5ec0d` (commit A: scripts/ocr-poc/ 削除) + `b4e62e2` (commit B: exams.property_schema 列 drop) の 2 commit セット

---

## 7. 参考

### 7.1 関連 spec

- Tech Spec §2.5.1 (exams テーブル)
- Tech Spec §2.5.2 (cards.custom_props)
- Tech Spec §2.2 「採否保留」テーブル一覧 行 85 (`custom_property_definitions`、 MVP 不採用)
- Tech Spec §7 (Gemini Structured Output パターン)
- Tech Spec §8 Logic 1 (OCR pipeline)

> ※ Tech Spec §2.2 行 85 の `custom_property_definitions` 行末に「§2.6 参照」とあるが、 §2.6 という独立節は tech-spec に存在しない (orphan reference)。 OCR sprint の spec 改訂時に、 この参照先を本 research doc (`docs/research/ocr-schema-vs-discover.md`) に書き換える整理が必要。

これらは OCR sprint で discover 一本化に整合する形で改訂予定 (MVP 段階)。

### 7.2 関連 PoC commit

- `236a189` (Initial commit): PoC schema mode + discover mode 両経路を含む初版投入
- `b12f86e` (chore(ocr-poc): simplify DISCOVER_CUSTOM_PROPS_RULES): 推敲対処 1、 自由キー命名 / 同義キー統一 / 具体例を削除して判断負荷を schema mode 並みに低減
- `26a1c4e` (chore(ocr-poc): clarify question_text vs options[].text boundary): 推敲対処 2、 question_text 責務境界明確化 (正誤組合せ a〜d 記述の例外を明示)

### 7.3 関連 lessons

- (将来作成する場合) `docs/superpowers/lessons/2026-XX-ocr-pipeline.md`

---

## 8. 改訂履歴

- 2026-05-17: 初版。 5 試験実測 + prompt 推敲完了時点で作成、 discover 一本化判断を確定
