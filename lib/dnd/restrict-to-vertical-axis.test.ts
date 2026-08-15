// restrictToVerticalAxis の mini unit test (row-dnd sprint task-3 spec §3.6)。
// x を 0 に固定し、 y / scaleX / scaleY はそのまま素通りすることを pin する。
// 純関数 (DOM 非依存) のため vitest.config の既定 environment ('node') のままで足りる。

import { describe, it, expect } from 'vitest'
import type { ClientRect } from '@dnd-kit/core'
import { restrictToVerticalAxis } from './restrict-to-vertical-axis'

// Modifier は transform 以外の引数も受け取るが、この関数は transform しか参照しない。
// 型を満たすためだけの未使用値で埋める。
const baseArgs = {
  activatorEvent: null,
  active: null,
  activeNodeRect: null,
  draggingNodeRect: null,
  containerNodeRect: null,
  over: null,
  overlayNodeRect: null,
  scrollableAncestors: [] as Element[],
  scrollableAncestorRects: [] as ClientRect[],
  windowRect: null,
}

describe('restrictToVerticalAxis', () => {
  it('x を 0 に固定する', () => {
    const result = restrictToVerticalAxis({
      ...baseArgs,
      transform: { x: 42, y: 10, scaleX: 1, scaleY: 1 },
    })
    expect(result.x).toBe(0)
  })

  it('y / scaleX / scaleY はそのまま素通りする', () => {
    const result = restrictToVerticalAxis({
      ...baseArgs,
      transform: { x: 42, y: 10, scaleX: 1.2, scaleY: 0.8 },
    })
    expect(result.y).toBe(10)
    expect(result.scaleX).toBe(1.2)
    expect(result.scaleY).toBe(0.8)
  })
})
