// Sprint T fixtures — 実カード 2 件 + サロゲートペア fixture。
// segmentMdTables(T2)/ renderer contract(T3)の両方から import する共有 artifact。
//
// 実カード A/B は OCR 実出力(OT の SQL 抽出・2026-07-17)。length(question_text) 確認で
// 全文であることが確定済(A/B とも 500 字未満 = 切断なし)。合成でなく実形を pin する
// ことで、GFM 挙動(A = 表末尾で完結 / B = 表直後の本文吸収)を実データで固定する。

// (A) 06f4e35f-b2d3-44af-a69d-86693ea10658 — 表が末尾で終わる(後続テキストなし)。
export const REAL_CARD_A_ID = '06f4e35f-b2d3-44af-a69d-86693ea10658'
export const REAL_CARD_A = `一般用医薬品の添付文書等において、「相談すること」の項目中に「次の診断を受けた人」として記載することとされている基礎疾患等と医薬品成分・薬効群等との関係の正誤について、正しい組合せを選べ。
| 基礎疾患等 | 医薬品成分・薬効群等 |
|---|---|
| a 高血圧 | アセトアミノフェンが配合された解熱鎮痛薬 |
| b 腎臓病 | スクラルファートが配合された胃腸薬 |
| c 心臓病 | グリセリンが配合された浣腸薬 |
| d 肝臓病 | 酸化マグネシウムが配合された瀉下薬 |`

// (B) 2e97b7b7-0d3c-4f5a-933e-afcc7ce27841 — 表の直後に空行なしで本文が続く。
// GFM は後続の非空行を表の行として吸収する(spec §2 実測 3)。この壊れ方を「正」として
// pin する = ライブラリ更新で吸収挙動が変われば snapshot / property が捕まえる。
export const REAL_CARD_B_ID = '2e97b7b7-0d3c-4f5a-933e-afcc7ce27841'
export const REAL_CARD_B = `次の表は、ある一般用医薬品の眠気防止薬に含まれている成分の一覧である。
| 成分 | 分量 |
|---|---|
| 無水カフェイン | 300 mg |
| チアミン塩化物塩酸塩(ビタミンB1) | 15 mg |
この眠気防止薬の添付文書等の「してはいけないこと」の項目中において、「次の診断を受けた人」に記載されている基礎疾患について、正しいものの組合せを選べ。
a 心臓病
b 糖尿病
c 胃潰瘍
d てんかん`

// サロゲートペア(BMP 外文字)fixture — offset が UTF-16 code unit である前提の唯一の
// 危険経路(spec §3.2・OT 修正1)。code point 単位で slice すると、ペア以降の全テキストが
// 1 ずつズレて連結復元が壊れる。'𠮟'(U+20B9F)= 1 サロゲートペア(string.length===2)。
const SURROGATE = '𠮟' // U+20B9F, length 2 in UTF-16
const TABLE_BLOCK = '| a | b |\n|---|---|\n| 1 | 2 |'

// 表より前にペア
export const SURROGATE_BEFORE = `${SURROGATE}責の注意\n${TABLE_BLOCK}`
// 表内セルにペア
export const SURROGATE_IN_CELL = `| ${SURROGATE} | b |\n|---|---|\n| 1 | 2 |`
// 表より後にペア(空行で表を閉じてから)
export const SURROGATE_AFTER = `${TABLE_BLOCK}\n\n${SURROGATE}責の後書き`
// 3 箇所すべて
export const SURROGATE_ALL = `${SURROGATE}前\n| ${SURROGATE} | b |\n|---|---|\n| 1 | ${SURROGATE} |\n\n${SURROGATE}後`
