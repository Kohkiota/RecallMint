// crop-geometry — box_2d(Gemini 検出座標)→ pixel crop rect の pure 変換。
// ②-4a Task 9(docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md
// §4.1/§7.1)。PURE 制約は asset-state.ts に厳密に倣う: Dexie / React / 'use client' /
// drizzle / @/lib/db / @/lib/logger / server-only / zod / next を runtime import しない
// (media-domain eslint block が強制)。sharp は使わない(それは T10 の役目 — 本 file は
// 座標算術のみ)。
//
// 入力責務(spec §4.4・重要): これは PURE domain 関数であり、呼び出し側(T8a の
// integrated schema)が既に box_2d を「4 要素の tuple」として実行時検証済みという前提で
// 呼ばれる。ここでは box_2d の形状(配列長・要素型)を runtime re-validate しない。
// ただし NaN/Infinity(呼び出し側が除外すべき契約違反)を silently 通してしまうと、
// 本関数が「整数 px の crop rect」という出力契約を破って NaN 混じりの CropRect を返しかね
// ない。それは「例外を投げる」より悪い(呼び出し側が気づかず先に進む)。そのため下記の
// 退化判定は意図して `a <= b`(NaN では常に false = 素通りしてしまう)ではなく
// `!(a > b)`(NaN では常に true = null で止まる)の向きで書く。これは NaN 用に足した
// 防御ガードではなく、有限数に対しては数学的に同値な比較の向きを選んだだけであり、
// 既存の「退化 → null」契約(spec §7.1 step 6)をそのまま NaN にも一貫適用する。
// 逆転 box(x_max<=x_min 等)も同じ判定式で自然に null になる。

export type Box2d = readonly [number, number, number, number] // [y_min, x_min, y_max, x_max]、各軸 0-1000 正規化

export interface CropRect {
  left: number
  top: number
  cropW: number
  cropH: number
  origBbox: Box2d // 呼び出し時に渡された生の box_2d(未 padding・未 clamp)
  paddingPct: number // 0.06 固定(spec §7.1)
  clampedBbox: Box2d // padding 適用後 [0,1000] に clamp した box(0-1000 空間のまま、px 化前)
}

const PADDING_UNITS = 60 // 0-1000 空間での ±60 = 6%(spec §7.1)
const PADDING_PCT = 0.06

function clampTo1000(value: number): number {
  return Math.min(Math.max(value, 0), 1000)
}

// ---------------------------------------------------------------------------
// padAndClampBox2d — 各辺を ±60(6%)拡張してから [0,1000] に clamp する。
// なぜ 6%: 実測した検出座標の揺れは ~3.5% 程度だったが、目視で出所表記・軸ラベルが
// 実際に切れるケースを観測したため広めに取った。余白過多(padding 過剰)は見た目が
// 少し広いだけで実害が小さいのに対し、切れ(under-padding)は再取得不可能な情報欠落
// になる非対称なコストゆえ、広めから始めて後で狭める方針(spec §7.1)。
// ---------------------------------------------------------------------------
export function padAndClampBox2d(box2d: Box2d): Box2d {
  const [yMin, xMin, yMax, xMax] = box2d
  return [
    clampTo1000(yMin - PADDING_UNITS),
    clampTo1000(xMin - PADDING_UNITS),
    clampTo1000(yMax + PADDING_UNITS),
    clampTo1000(xMax + PADDING_UNITS),
  ]
}

// ---------------------------------------------------------------------------
// mapNormalizedBoxToPixels — 0-1000 正規化 box を px 座標に変換する軸別独立変換
// (spec §4.1 の裏取り済み核心式)。x 軸は decodedWidth のみ、y 軸は decodedHeight のみで
// スケールする(単一 scale の共有ではない)。padding も丸めもしない — toCropRect の
// 中間ステップとして、かつ裏取り代表例をこの式単体でテストできるよう export する。
// ---------------------------------------------------------------------------
export function mapNormalizedBoxToPixels(
  box2d: Box2d,
  decodedWidth: number,
  decodedHeight: number,
): { xMinPx: number; yMinPx: number; xMaxPx: number; yMaxPx: number } {
  const [yMin, xMin, yMax, xMax] = box2d
  return {
    xMinPx: (xMin / 1000) * decodedWidth,
    yMinPx: (yMin / 1000) * decodedHeight,
    xMaxPx: (xMax / 1000) * decodedWidth,
    yMaxPx: (yMax / 1000) * decodedHeight,
  }
}

// ---------------------------------------------------------------------------
// toCropRect — box_2d + decoded 画像寸法から整数 px の crop rect を導出する
// (spec §7.1): pad±60(6%) → clamp[0,1000] → 軸別独立 px 化 → floor(left/top) /
// ceil(right/bottom) → 整数。
//
// floor/ceil が非対称な理由: 変換で生じる小数 px を「常に外側」に丸めることで、
// crop rect が(padding 済みの)対象領域を必ず完全に包含する。left/top を ceil、
// right/bottom を floor してしまうと逆に内側へ丸まり、意図せず領域を切ってしまう。
//
// 退化 → null(spec §7.1 step 6): clamp 後の box が逆転/ゼロ面積、または結果の
// crop_w/crop_h が正でない場合。両方の判定を `!(a > b)` 向きで書くのは NaN(呼び出し側の
// 契約違反)を「素通りしてしまう `<=` の NaN 半透過性」ではなく「null で止まる」側に
// 倒すため(ファイル冒頭コメント参照)。decodedWidth/decodedHeight が 0 や負(契約上は
// 正の整数だが、万一渡された場合)も同じ判定で自然に null になる — 個別の
// isFinite/positive ガードを別途足す必要はない。
// ---------------------------------------------------------------------------
export function toCropRect(
  box2d: Box2d,
  decodedWidth: number,
  decodedHeight: number,
): CropRect | null {
  const clampedBbox = padAndClampBox2d(box2d)
  const [yMinC, xMinC, yMaxC, xMaxC] = clampedBbox

  if (!(xMaxC > xMinC) || !(yMaxC > yMinC)) return null

  const { xMinPx, yMinPx, xMaxPx, yMaxPx } = mapNormalizedBoxToPixels(
    clampedBbox,
    decodedWidth,
    decodedHeight,
  )

  const left = Math.floor(xMinPx)
  const top = Math.floor(yMinPx)
  const right = Math.ceil(xMaxPx)
  const bottom = Math.ceil(yMaxPx)

  const cropW = right - left
  const cropH = bottom - top
  if (!(cropW > 0) || !(cropH > 0)) return null

  return {
    left,
    top,
    cropW,
    cropH,
    origBbox: box2d,
    paddingPct: PADDING_PCT,
    clampedBbox,
  }
}
