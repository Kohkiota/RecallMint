// @vitest-environment jsdom
//
// Tag-4c-2c hotfix H4: useSortableSensors の戻り値構造を pin する unit test。
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
//
// Row-UX task-1 追加分: SortableSensorOptions (mouseActivationConstraint / keyboardCodes) の
// 透過と、 options 未指定 / 同一参照時の sensors 配列 identity 安定性 (呼出側の memo が
// 無効化されない不変条件) を pin する。

import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'

import { useSortableSensors, type SortableSensorOptions } from './use-sortable-sensors'

describe('useSortableSensors', () => {
  it('3 件の sensor descriptor を Mouse / Touch / Keyboard の順で返す', () => {
    const { result } = renderHook(() => useSortableSensors())
    expect(result.current).toHaveLength(3)
    expect(result.current[0].sensor).toBe(MouseSensor)
    expect(result.current[1].sensor).toBe(TouchSensor)
    expect(result.current[2].sensor).toBe(KeyboardSensor)
  })

  it('MouseSensor は activationConstraint なし (PC 即起動)', () => {
    const { result } = renderHook(() => useSortableSensors())
    const mouse = result.current[0]
    // options は MouseSensorOptions ({} 既定 + 任意 activationConstraint)。
    // 未指定なので activationConstraint は undefined であること。
    expect(
      (mouse.options as { activationConstraint?: unknown }).activationConstraint,
    ).toBeUndefined()
  })

  it('TouchSensor は { delay: 250, tolerance: 5 } で long-press 起動 + 誤発火抑制', () => {
    const { result } = renderHook(() => useSortableSensors())
    const touch = result.current[1]
    expect(
      (touch.options as { activationConstraint?: { delay?: number; tolerance?: number } })
        .activationConstraint,
    ).toEqual({ delay: 250, tolerance: 5 })
  })

  it('KeyboardSensor は sortableKeyboardCoordinates を coordinateGetter として配線', () => {
    const { result } = renderHook(() => useSortableSensors())
    const keyboard = result.current[2]
    expect(
      (keyboard.options as { coordinateGetter?: unknown }).coordinateGetter,
    ).toBe(sortableKeyboardCoordinates)
  })

  it('mouseActivationConstraint を渡すと MouseSensor の options に透過する', () => {
    const { result } = renderHook(() =>
      useSortableSensors({ mouseActivationConstraint: { distance: 4 } }),
    )
    const mouse = result.current[0]
    expect(
      (mouse.options as { activationConstraint?: unknown }).activationConstraint,
    ).toEqual({ distance: 4 })
  })

  it('keyboardCodes を渡すと KeyboardSensor の options に coordinateGetter と共存で透過する', () => {
    const customCodes = { start: ['Space'], cancel: ['Escape'], end: ['Space'] }
    const { result } = renderHook(() => useSortableSensors({ keyboardCodes: customCodes }))
    const keyboard = result.current[2]
    expect(
      (keyboard.options as { keyboardCodes?: unknown }).keyboardCodes,
    ).toBe(customCodes)
    expect(
      (keyboard.options as { coordinateGetter?: unknown }).coordinateGetter,
    ).toBe(sortableKeyboardCoordinates)
  })

  it('options 未指定時は mouseActivationConstraint も keyboardCodes も透過しない (undefined)', () => {
    const { result } = renderHook(() => useSortableSensors())
    const mouse = result.current[0]
    const keyboard = result.current[2]
    expect(
      (mouse.options as { activationConstraint?: unknown }).activationConstraint,
    ).toBeUndefined()
    expect((keyboard.options as { keyboardCodes?: unknown }).keyboardCodes).toBeUndefined()
  })

  it('options 未指定なら rerender 後も sensors 配列の identity が安定する', () => {
    const { result, rerender } = renderHook(() => useSortableSensors())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('同一 options 参照を渡し続ける限り rerender 後も sensors 配列の identity が安定する', () => {
    const stableOptions: SortableSensorOptions = {
      mouseActivationConstraint: { distance: 4 },
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }
    const { result, rerender } = renderHook(
      (options: SortableSensorOptions) => useSortableSensors(options),
      { initialProps: stableOptions },
    )
    const first = result.current
    rerender(stableOptions)
    expect(result.current).toBe(first)
  })
})
