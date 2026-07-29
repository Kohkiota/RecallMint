# ②-3: 本文 markdown 画像記法の描画側 enforce 設計 (spec)

- 日付: 2026-07-29
- Sprint: ②-3(OCR track / ②-2 モデル移行の直後・②-4 の前提)
- 種別: 描画側単一点の契約強制(sync/tx なし)
- モデル: Opus
- 前提: fact-finding = `docs/audit/2026-07-29-ocr-2-3-inline-image-enforce-factfinding.md`

## 1. 目的

card body の本文フィールドに混入する markdown 画像記法 `![…](…)` を **描画側単一点で除去**し、「**本文に markdown 画像記法が現れない**」ことを **test で契約固定**する。これは見栄えの調整ではなく **target 単位契約(images[].target で図を紐づける確定設計・②-2 FF §1')の描画側強制**である。prompt での抑制は効かないことが ②-2 arm 比較(lite が「埋め込み不要」を無視)で実証済ゆえ、描画側の決定的処理が要る。

## 2. 背景 — なぜ ②-3 が ②-4 の前提か(OT 提起への回答・記録)

「先に prompt の `![…](…)` 記述(「埋め込む必要はない」行)を消すべきでは」への回答: **順序は現状(②-3 → ②-4)が正しい**。当該行は埋め込みを**弱く抑止**している行であり、削除すると抑止が消え混入は**増える**方向。lite は既にこの行を無視して `![…]` を出しており(②-2 実証)、prompt は描画側処理の代替にならない。→ ②-3 で描画側に決定的処理を入れ、その後 ②-4 で prompt を安心して整理する。先に prompt を消すと、描画側処理が入るまで本文が汚れる期間ができる。

## 3. 非目標(凍結)

- 本番 prompt(`lib/ai/prompts/ocr-extract.ts`)。画像記述 3 件の整理は **②-4** で一括(§7)。
- 本番 schema(`buildDiscoverResponseJsonSchema`)。
- OCR pipeline。
- **storage 形式**: `question_text` 等は inline `![…]` を含んだまま保存する(②-3 は parse/保存を変えない)。
- **`segmentMdTables` の不変条件**(`value 連結 === 入力`)。blank-line detector 等が依存。strip は segment 関数に入れず**描画側**で行う。

## 4. 設計

### 4.1 除去の 2 論点(fact-finding 材料 + 推奨)

- **論点 1 = 表内も揃える(採用)**: 現状は表外(text セグメント)= literal 表示 / 表内(table セル)= img override で alt 表示、の非対称。同一契約違反への扱いが 2 通りは望ましくないため**揃える**。text = 除去、table = alt もやめて**除去(非表示)**に統一。regression risk 低(strip helper 1 + img override 1 行 + 既存 test 1 更新)。
- **論点 2 = 全て除去(採用)**: OCR key pattern(`qNNN-img-N`)に絞らず**任意の `![alt](url)`** を除去。inline 画像記法はどこでも画像描画されない設計(表外 literal / 表内 alt・実 asset は非 UUID key ゆえ `CardImageGallery` 非描画)ゆえ、「本文に inline 画像記法は存在しない」で契約統一。pattern 依存は変化時に漏れる。

### 4.2 単一点の所在 = `MdTableSegments`

全描画経路(`MdTableText` / `MdTableBlock` / 直接 caller = session-runner の tag 判定共有)は低レベル render **`MdTableSegments`**(`components/markdown/md-table-text.tsx`)に収束する(pre-segmented `segments` を描画)。ここで:

- **text セグメント**: 現状 `<React.Fragment>{seg.value}</React.Fragment>`(raw)→ `stripInlineImages(seg.value)` を適用して描画。
- **table セグメント**: react-markdown の `components.img` を **`() => null`**(現状 `({alt}) => alt` から変更)にし、table セル内 inline 画像を非表示化。

`segmentMdTables` は不変(strip は segment 後の各 text セグメント値に適用ゆえ、segment 関数の `value 連結 === 入力` 不変条件に影響しない)。

### 4.3 `stripInlineImages` helper

新 pure 関数(`lib/markdown/strip-inline-images.ts`・unit test 厚く):

- 任意の markdown 画像記法 `![alt](url)` を除去。
- **orphaned 空行を残さない**: `![…]` の直前が blank 行(`\n\n![…]`)の場合、除去で末尾に空行が残ると whitespace-pre-wrap で空行描画される。除去は隣接する余剰空白/改行も畳む(例: 画像記法とその前後の空行を 1 単位で除去、または除去後に連続空行を 1 つに正規化)。具体 regex は plan で確定。
- alt 内に `]` を含む稀ケースは非対応で可(MVP・OCR 出力は単純 alt)。

## 5. 完了 gate(全 exit 0)

依存不変ゆえ install 系は不要。

- whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit`
- 既存 flaky(`inline-text-field` / `card-image-gallery`)は当該 file 単体 PASS で切り分け報告(retry 糊塗禁止)。

## 6. test(契約固定・red 検証)

**保証増ゆえ red 検証必須**(契約 pin が壊す変異で fail する実証)。

- `lib/markdown/strip-inline-images.test.ts`(新規): 各種入力(表外 `![下図](q1-img-1)` 除去 / 複数 / alt 空 / 前後空行の畳み / 画像なし no-op / 非画像 markdown `[link](url)` は残す)を pin。
- `components/markdown/md-table-text.test.tsx`(更新): **text セグメントに `![…]` → DOM に literal も img も現れない** を追加 pin。**既存 `画像記法 → <img> 不在・alt テキスト表示`(:28-32)を「table image → alt も出さない(非表示)」へ更新**(論点 1 の契約変更)。
- **red 検証**: strip を無効化(helper が入力素通し)or img override を alt 復帰させる変異で当該 pin が fail することを示し、commit message に「**red 検証**」記録。

## 7. 持ち越し(②-4)= prompt 画像記述 3 件

②-4(図版切り出し)が prompt を触る際に一括(②-3 では触らない):
1. `IMAGE_REFERENCE_RULES` 冒頭コメント「画像本体切り出せない」= 同ページ図は誤(box_2d 実証)→ 書き換え。
2. `COMMON_EXTRACTION_RULES`「画像は抽出しない」= ②-4 方針変更そのもの。
3. 「プレースホルダ埋め込みについて」行削除。

## 8. commit 構成と tag

- 実装ロジック変更(描画)ゆえ **`feat(markdown)` or `fix(markdown)` + `[reviewed]`**(canonical + Codex)。helper + md-table-text + test を 1 commit(小 diff・変更源単一)。
- docs = `docs(...)` + `[no-review]`。
- 重要 Fix(決済/認証/削除/外部副作用)非該当。

## 9. リスクと停止条件

- **停止(即 OT)**: golden/typecheck/build fail(想定外の波及)。既存の table image alt-display に依存する UI が他にあれば(現状は md-table-text の1 test のみが pin)報告。
- **想定リスク低**: 描画側 1 helper + 1 config。sync/tx/storage 不関与。既存データは render 時処理で自動救済(migration 不要)。
- **Codex plan cross-check**: 省略(描画側単一点・fact-finding 完了・diff 小)。要否 OT 裁量。

## 10. spec 凍結

実装フェーズで書き換えない。§3 の凍結対象に触れる必要が出たら停止して OT 相談。
