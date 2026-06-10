// @vitest-environment jsdom
//
// Tag-4c-2c hotfix H4: useTagSortableSensors の戻り値構造を pin する unit test。
//
// jsdom で実 sensor の pointerdown→drag 挙動を末端まで pin するのは信頼性低 (dnd-kit が
// 内部で扱う pointer/touch capture を jsdom が忠実には再現しない) ため、 本 test は hook
// が返す sensor descriptor 配列 (`useSensors` の戻り値) の構造のみ pin する:
// - 3 件あること (Mouse / Touch / Keyboard)
// - sensor identity が想定どおり (MouseSensor / TouchSensor / KeyboardSensor)
// - PC = MouseSensor は activationConstraint なし (即起動)
// - Touch = TouchSensor は { delay: 250, tolerance: 5 }
// - Keyboard = KeyboardSensor は coordinateGetter 設定あり
// これだけ pin しておけば「sensor 配線を間違えて PointerSensor に戻した」 「Touch から
// delay を落とした」 等の regression は確実に検出できる。

import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'

import { useTagSortableSensors } from './use-tag-sortable-sensors'

describe('useTagSortableSensors', () => {
  it('3 件の sensor descriptor を Mouse / Touch / Keyboard の順で返す', () => {
    const { result } = renderHook(() => useTagSortableSensors())
    expect(result.current).toHaveLength(3)
    expect(result.current[0].sensor).toBe(MouseSensor)
    expect(result.current[1].sensor).toBe(TouchSensor)
    expect(result.current[2].sensor).toBe(KeyboardSensor)
  })

  it('MouseSensor は activationConstraint なし (PC 即起動)', () => {
    const { result } = renderHook(() => useTagSortableSensors())
    const mouse = result.current[0]
    // options は MouseSensorOptions ({} 既定 + 任意 activationConstraint)。
    // 未指定なので activationConstraint は undefined であること。
    expect(
      (mouse.options as { activationConstraint?: unknown }).activationConstraint,
    ).toBeUndefined()
  })

  it('TouchSensor は { delay: 250, tolerance: 5 } で long-press 起動 + 誤発火抑制', () => {
    const { result } = renderHook(() => useTagSortableSensors())
    const touch = result.current[1]
    expect(
      (touch.options as { activationConstraint?: { delay?: number; tolerance?: number } })
        .activationConstraint,
    ).toEqual({ delay: 250, tolerance: 5 })
  })

  it('KeyboardSensor は sortableKeyboardCoordinates を coordinateGetter として配線', () => {
    const { result } = renderHook(() => useTagSortableSensors())
    const keyboard = result.current[2]
    expect(
      (keyboard.options as { coordinateGetter?: unknown }).coordinateGetter,
    ).toBe(sortableKeyboardCoordinates)
  })
})
