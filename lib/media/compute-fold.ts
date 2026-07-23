// computeFold: 縦長 in-flow 画像の畳み判定 pure 関数(spec §3.1/§3.3・二項閾値)。
//
// renderedHeightPx はアスペクト比(naturalHeight/naturalWidth)から算出。二項 OR(spec §修正1):
// px 下駄枝(絶対マージン)= 大きな cap で数 px 超過を畳まないため、比率枝 = 小 viewport で
// 先に効かせるため。どちらかで成立すれば畳む。定数(absMarginPx/ratio)は呼出側が渡す。
// naturalWidth > 0 は呼出側保証(dims 未確定は渡さない・spec §3.6)ゆえ guard しない。

export interface ComputeFoldArgs {
  naturalWidth: number
  naturalHeight: number
  renderedWidthPx: number
  capPx: number
  absMarginPx: number
  ratio: number
}

export interface ComputeFoldResult {
  fold: boolean
  cappedHeightPx: number
}

export function computeFold({
  naturalWidth,
  naturalHeight,
  renderedWidthPx,
  capPx,
  absMarginPx,
  ratio,
}: ComputeFoldArgs): ComputeFoldResult {
  const renderedHeightPx = (renderedWidthPx * naturalHeight) / naturalWidth
  const fold =
    renderedHeightPx > capPx + absMarginPx || renderedHeightPx > capPx * ratio
  const cappedHeightPx = Math.min(renderedHeightPx, capPx)
  return { fold, cappedHeightPx }
}
