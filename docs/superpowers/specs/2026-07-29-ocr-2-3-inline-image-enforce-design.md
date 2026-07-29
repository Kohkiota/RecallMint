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

全 caller が `MdTableSegments` を通るため、ここに strip を置けば**どの caller もバイパスできない**(caller 各所に散らさない)。各セグメントの値に `stripInlineImages(seg.value)` を適用してから描画:

- **text セグメント**: 現状 `<React.Fragment>{seg.value}</React.Fragment>`(raw)→ strip 後の値を描画。
- **table セグメント**: strip 後の値を react-markdown へ。加えて防御として `components.img` を **`() => null`**(現状 `({alt}) => alt` から変更)にし、万一 strip をすり抜けた画像も非表示化(belt-and-suspenders)。

`segmentMdTables` は**触らない**(不変条件 `value 連結 === 入力` を保つ)。strip は segment 後の各セグメント値に適用するため segment 関数に影響しない。tag 判定(hasTable)は画像除去で不変(画像 ≠ 表)。

### 4.3 `stripInlineImages` helper — **AST ノードの offset で削除(再文字列化しない)**

新 pure 関数(`lib/markdown/strip-inline-images.ts`・unit test 厚く)。**正規表現による字面除去はしない**(`![alt](foo(and(bar)))` / `![alt](<foo bar>)` / `![alt](url "title")` / reference 記法 `![alt][id]` を誤り、code span・code block 内・escape `\![...]` を巻き込んで**正解選択肢を消す**危険がある)。

実装方針:
1. **mdast で parse**(`remark-parse` + `remark-gfm` = 既存依存・`segment-md-tables.ts` と同 processor。**新規依存なし**)。
2. tree を再帰 walk(unist-util-visit の新規依存を避け手書き walk)し、**`type==='image'` と `type==='imageReference'` のノードの `position.start.offset` / `position.end.offset` を収集**。code span(`inlineCode`)/ code block(`code`)内はそもそも image ノードにならず、escape された `\![...]` も image ノードにならない → **自然に対象外**。nested paren / angle URL / title / reference もパーサが正しく解釈する。
3. **AST を再文字列化しない**(空白・改行・箇条書き・表整形が正規化され「改行 \n 保持」prompt 最優先ルール + segmentMdTables 不変条件に衝突する)。代わりに **収集した [start, end) を offset 降順にソートし、元文字列から後ろ向きに該当範囲だけ削除**(後ろ向きゆえ削除で offset がズレない)。他の全文字はバイト等価で保存。
4. **imageReference の definition 行**(`[id]: url`)は MVP 範囲外(OCR は reference 記法を出さない・出た場合の残 definition 行は稀な軽微 artifact として記録に留める)。alt 内 `]` 等の稀ケースもパーサ任せ。

**空白・空行の扱い**(全体 trim / 空白圧縮は**禁止** = 表・code を壊す。処理は画像ノードの左右に限定):
- **画像が行の唯一の内容**(前後改行の間が空白 + 画像のみ)→ **その行を削除**(削除範囲を行頭空白 + 片側改行まで拡張し orphaned 空行を残さない)。
- **画像が段落の途中** → **画像構文のみ削除**(周囲 text 保持)。
- **表セル内が画像のみ** → **セルは空にするが区切り `|` は残す**(offset 削除は画像ノード範囲のみ = セル区切りはノード外ゆえ自然に温存・行/列は変えない)。
- **日本語文中に隣接する場合の空白**の扱いは実装時に決定し **test で固定**。

## 5. 完了 gate(全 exit 0)

依存不変ゆえ install 系は不要。

- whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit`
- 既存 flaky(`inline-text-field` / `card-image-gallery`)は当該 file 単体 PASS で切り分け報告(retry 糊塗禁止)。

## 6. test(契約固定・red 検証)

**保証増ゆえ red 検証必須**(契約 pin が壊す変異で fail する実証)。

- `lib/markdown/strip-inline-images.test.ts`(新規):
  - **除去 pin**: 表外 `![下図](q1-img-1)` 除去 / 複数 / alt 空 / nested paren `![a](foo(bar))` / angle URL `![a](<foo bar>)` / title `![a](url "t")` / reference `![a][id]`。
  - **非対象 pin(正解選択肢を消さない証明)**: **code span 内**（`` `![a](x)` `` は残す)/ **code block 内**(残す)/ **escape** `\![a](x)`(残す)/ 非画像 link `[link](url)`(残す)/ 画像なし no-op。
  - **空白ルール pin**: 行唯一の画像 → 行削除(orphaned 空行なし)/ 段落途中 → 構文のみ / 表セル内画像 → セル空・`|` 温存(行/列不変)。
  - **冪等性 pin**: `stripInlineImages(stripInlineImages(x)) === stripInlineImages(x)`。
  - **性質ベース pin**: 除去後の文字列を再 parse(mdast)して **image / imageReference ノード 0 件**。
- `components/markdown/md-table-text.test.tsx`(更新): **text セグメントに `![…]` → DOM に literal も img も現れない** を追加 pin。**既存 `画像記法 → <img> 不在・alt テキスト表示`(:28-32)を「table image → alt も出さない(非表示)」へ更新**(論点 1 の契約変更)。
- **red 検証**: strip を無効化(helper が入力素通し)or img override を alt 復帰させる変異で当該 pin が fail することを示し、commit message に「**red 検証**」記録。

## 7. 持ち越し(②-4)

**②-3 では扱わない。** ②-4(図版切り出し)着手時に対処する。

### prompt 画像記述 3 件(②-4 で一括整理)
1. `IMAGE_REFERENCE_RULES` 冒頭コメント「画像本体切り出せない」= 同ページ図は誤(box_2d 実証)→ 書き換え。
2. `COMMON_EXTRACTION_RULES`「画像は抽出しない」= ②-4 方針変更そのもの。
3. 「プレースホルダ埋め込みについて」行削除。

### 設計制約 2 件(OT 提起・②-4 spec で反映)
4. **bbox を捨てない**: 切り出した画像を通常 asset として保存するだけでなく、**元ページ上の座標・検出領域 ID を別途保持**する。座標が無いとパディングを調整して切り直せない(box2d 可視化目視で「矩形がぎりぎりで出所表記が切れる」等の調整が後から不能になる)。
5. **`ambiguous` を許す**: 図が question と option_1 の境界にある場合、モデルに必ずどちらかを選ばせると silent error になる。**target の値域に「判定不能」を含めるか、候補を複数返せる形**にする。

### test 素材(②-4 用・②-3 では未使用)
- OT が擬似問題 `mock-exam-page2.{png,pdf,html}` を追加(全て架空: 問1=問題文+解説に別図 2 つ / 問2=選択肢 1〜4 に別図 / 問3=「別冊No.1」参照のみ・ページ内図なし=切り出し対象不在)。OT 提供後 **`tests/fixtures/ocr/` へ tracked** で取り込む(page1 と同様)。既存実教材 3 枚が全て「問題文の図」で **選択肢ごとの図の target 判定が未検証**という穴を埋める素材。
- 実教材(看護師国家試験)は OT 用意・**commit しない**(`scripts/ai/ocr-samples/` に置き比較 run でのみ使用)。

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
