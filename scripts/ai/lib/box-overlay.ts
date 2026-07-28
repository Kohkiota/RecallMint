// Gemini の box_2d ([y_min, x_min, y_max, x_max]、画像を 0-1000 に正規化)を CSS % overlay
// (left/top/width/height)に変換する pure 関数。②-0 OCR regression 基盤(T7 box2d-viz が
// 消費する)。異常値(範囲外・NaN・ゼロ/負の面積)は clamp/reorder せず invalid として突き返す
// — 異常を可視化することが本 helper の目的(モデル出力の異常をそのまま見せる)。

export type BoxToPercentResult =
  | { valid: true; left: number; top: number; width: number; height: number }
  | { valid: false; reason: string }

export function boxToPercent(box2d: unknown): BoxToPercentResult {
  if (!Array.isArray(box2d) || box2d.length !== 4) {
    return {
      valid: false,
      reason: `box_2d must be an array of exactly 4 numbers (got: ${JSON.stringify(box2d)})`,
    }
  }

  for (const v of box2d) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return {
        valid: false,
        reason: `box_2d elements must be finite numbers (got: ${JSON.stringify(box2d)})`,
      }
    }
  }

  const [yMin, xMin, yMax, xMax] = box2d as [number, number, number, number]

  for (const v of [yMin, xMin, yMax, xMax]) {
    if (v < 0 || v > 1000) {
      return {
        valid: false,
        reason: `box_2d elements must be within [0, 1000] (got: ${JSON.stringify(box2d)})`,
      }
    }
  }

  if (xMin >= xMax || yMin >= yMax) {
    return {
      valid: false,
      reason: `box_2d has zero or negative area (x_min>=x_max or y_min>=y_max, got: ${JSON.stringify(box2d)})`,
    }
  }

  return {
    valid: true,
    left: xMin / 10,
    top: yMin / 10,
    width: (xMax - xMin) / 10,
    height: (yMax - yMin) / 10,
  }
}
