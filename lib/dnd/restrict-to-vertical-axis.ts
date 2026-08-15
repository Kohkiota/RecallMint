// row DnD (dnd-kit) の drag transform を縦軸のみへ拘束する modifier。
// @dnd-kit/modifiers は導入しない (簡潔性規律: x を 0 に固定するだけの 1 行のために
// dependency を追加する理由がない)。core が public export する `Modifier` 型に
// 沿って自前定義する (row-dnd sprint task-3 spec §3.6)。

import type { Modifier } from '@dnd-kit/core'

export const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
})
