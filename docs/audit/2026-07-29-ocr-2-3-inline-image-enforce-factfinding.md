# ②-3 本文 markdown 画像記法の描画側 enforce fact-finding

- 日付: 2026-07-29
- Sprint: ②-3(OCR track)
- 目的: 本文 `![…](…)` を**描画側単一点で除去/正規化し、「本文に markdown 画像記法が現れない」ことを test で固定**する(target 単位契約の描画側強制)。方針決定はしない(材料のみ)。
- 前提: ②-2 fact-finding §1'(`docs/audit/2026-07-28-ocr-2-2-model-migration-factfinding.md`)で prompt/schema/設計記録が target 単位で一貫し、`![…](…)` 本文混入は**契約逸脱**と確定。②-2 arm 比較で頻度 = 3 画像中 2。
- 調査方法: read-only(実 API 不使用)。Bash stdout の識別子破損が断続再発したため file 内容は Read tool 直読・paths/行番号のみ Bash 併用。

## 性質の再確認(最重要)

本 sprint は「見栄えの調整」ではなく **target 単位契約の描画側強制**。成果物には **「本文に markdown 画像記法が現れない」ことの test 固定**を含む(除去して終わりにすると次に別モデルが同出力をした時に静かに戻る)。prompt での抑制が効かないことは ②-2 arm 比較(lite が `![…]` を出す)で実証済ゆえ、描画側 enforce が必要。

## §1 描画経路の単一点(現状の収束確認)

- **card body 全 text field の描画は `MdTableText` 系(`components/markdown/md-table-text.tsx`)に収束**:
  - 学習面(演習): `app/(app)/app/study/smart/_components/session-runner.tsx`(question=displayText / options[].text / options[].explanation / explanation 等・MdTableText/MdTableBlock)。
  - 編集面: `inline-text-field.tsx`(question_text / title / explanation_text / memo・:319 `<MdTableText value={displayText}/>`)/ `inline-option-row.tsx`(option value)。
- **card content を描く別 markdown 経路なし**: react-markdown 直使用は `md-table-text.tsx` のみ(rg 確認)。`dangerouslySetInnerHTML` の card content 経路なし。
- **②-1/②-2 で経路は不変**(両 sprint は cost/gemini/ocr のみ改変・描画未 touch)。→ **②-0 の「MdTableText 単一収束」は現在も有効**。

## §2 除去 vs alt 抽出の材料

- **key 対応**: 本文 inline `![alt](q{sort_key}-img-N)` の key は images[] の key 命名規則(`q{sort_key}-img-{連番}`・prompt IMAGE_REFERENCE_RULES)と**同形式**。= inline key は images[] entry に対応しうる。
- **OCR 図参照は現状どこにも画像描画されない**(決定的材料): `CardImageGallery`(`app/(app)/app/exams/[id]/_components/card-image-gallery.tsx:7`)は **UUID key entry のみ描画・非 UUID key(legacy OCR = `q013-img-1`)は非描画**。実 asset は ②-4(図版切り出し)まで存在しない。→ inline `![下図](q1-img-1)` は **literal markdown noise を出すだけで図自体は表示されない**。
- **単純除去で失われるもの**: 本文からは inline markdown 構文が消えるのみ。図参照の**メタデータは images[] に保持**(target/key/alt/source_ref・②-4 で実 asset 添付時に活用)、textual reference(「下図は…」等)は通常 question_text 本体に既存。図は元々表示されない。→ **機能的損失なし**。
- **alt 抽出した場合**: `![下図](q1-img-1)` → `下図` の plain text 描画。多くは question 本文の「下図は…」と**冗長**。ただし alt にのみある情報を保つ利点。
- → **除去は clean(何も表示されない図の literal noise を消すだけ)/ alt 抽出は冗長になりがちだが情報保存**。spec で判断。

## §3 表内と表外で挙動が違う理由(単一点の所在)

- `segmentMdTables`(`lib/markdown/segment-md-tables.ts`)は text を [text][table][text]… に分割し、**table セグメントのみ react-markdown に渡す・text セグメントは各 call site の raw text node**(`md-table-text.tsx:57-59` `<React.Fragment>{seg.value}</React.Fragment>`)。
- **表外(text セグメント)**: markdown 非処理 → `![下図](q1-img-1)` が **literal 文字列**表示。
- **表内(table セル)**: react-markdown 経由 → `components.img = ({alt}) => <>{alt ?? ''}</>`(`md-table-text.tsx:33`)で **alt のみ**(`<img>` 不出力)。
- → **差の原因 = text セグメントは markdown を通さない設計**。両方を enforce するには **text セグメントの処理**が要(表内は既に alt 化で無害化済)。**修正点 = `MdTableText` の text セグメント描画**(seg.value を除去/正規化)。
- **注意(不変条件)**: `segmentMdTables` の不変条件は「value 連結 === 入力(完全一致)」。strip を **segment 関数に入れると不変条件を壊す**(他用途=blank-line detector 等に波及)。→ strip は **描画側(MdTableText の text セグメント render)**で行い、segment 関数は不変に保つ。

## §4 既存データへの影響

- card body は `question_text` string に inline `![…]` を**保持したまま**保存(②-3 は storage/parse を変えない=描画側単一点)。
- 描画側処理は **render 時に適用**ゆえ、②-2 移行後に作成され既に混入を持つカードも **自動的に救われる**(data migration 不要)。→ 描画時処理で既存・新規とも一律カバー。

## §5 test の置き所

- 契約 = 「**本文(text セグメント)に markdown 画像記法が現れない**」を **render 層で固定**。
- **適所 = `components/markdown/md-table-text.test.tsx`**(既に img override の alt-only を test 済)。text セグメントに `![…](…)` を入れた入力で「`<img>` 不在 + literal `![…]` 文字列が DOM に現れない(除去 or alt 化の別は spec 決定)」を pin。strip を pure helper 化するなら helper 単体 test も。
- **parse 層 test は不適**(storage/parse を変えないため。parse で strip すると保存データを変える=②-3 scope 外)。
- 契約強制ゆえ「壊す変異で fail」の red 検証を伴う(保証増)。

## §6 判断材料まとめ(OT へ・spec で決める)

| 論点 | 材料 | 決定 |
|---|---|---|
| 除去 vs alt 抽出 | 図は現状非描画(gallery が非 UUID key skip)ゆえ除去で機能損失なし。alt は冗長になりがち | spec |
| 修正点 | `MdTableText` の text セグメント render(segment 関数は不変条件維持ゆえ触らない) | §3 で確定 |
| test 層 | render 層(md-table-text.test.tsx)+ 契約 pin の red 検証 | §5 |
| 既存データ | 描画時処理で自動救済(migration 不要) | §4 で確定 |
| 表内/表外 | 表内は既に alt 化済・enforce は text セグメント側 | §3 で確定 |

**scope 不変(prompt/schema/storage は触らない)**。prompt の画像記述整理は ②-4(別 sprint)。
