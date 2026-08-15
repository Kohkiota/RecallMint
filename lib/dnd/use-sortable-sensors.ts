// Tag-4c-2c hotfix H4: sensor 分割 (PC 即/Touch 長押し/Keyboard a11y) の共有 hook。
//
// 旧構成 (PointerSensor 単独 + activationConstraint { delay: 250, tolerance: 5 }) は
// PC でも「長押し 250ms 後にようやく掴める」 違和感が出ていた (Pointer は mouse/touch を
// 同一活性化条件で扱うため)。 mouse / touch を別 sensor に分割することで:
// - PC (MouseSensor): activationConstraint なし = 即ドラッグ起動 (Notion 式 UX)
// - Touch (TouchSensor): activationConstraint { delay: 250, tolerance: 5 }
//   = long-press 起動 + scroll/tap 誤発火抑制 を維持 (spec §4.4 不変条件)
// - Keyboard (KeyboardSensor): sortableKeyboardCoordinates で a11y 経路を維持
//   (Space で grab、 矢印で移動、 Space で confirm、 Esc で cancel)
//
// popover (card-tag-add-popover) / manager (category-list / option-list) / 行 DnD
// (exam table) の 4 site で同一構成を共有するため、 useSensors 構成を本 hook に切り出し
// drift を回避する。
// dep 追加なし: `@dnd-kit/core` v6.3.1 が MouseSensor / TouchSensor を export している
// (`node_modules/@dnd-kit/core/dist/sensors/index.d.ts` 確認済)。
//
// Row-UX task-1: 行 DnD だけ MouseSensor に距離しきい値 (activationConstraint) を要る
// (グリップの「ドラッグ = 並べ替え / クリック = メニュー」二役化)ため、 options 引数を
// 追加した。 tag 3 site は options 未指定のままで既定挙動 (constraint なし) が不変。
//
// 安定参照規律: dnd-kit の useSensor は `useMemo(..., [sensor, options])`、 useSensors は
// `useMemo(..., [...sensors])` で実装されている (`node_modules/@dnd-kit/core/dist/core.esm.js`
// 190-205 行)。 options に毎 render 新しい object literal を渡すとこれらの memo が毎回
// 無効化される。 このため Touch / Keyboard 既定値は module スコープ定数にし、 custom 経路
// (mouseActivationConstraint / keyboardCodes 指定時) も useMemo で options object の identity
// を安定化する。 呼出側も options に不安定参照 (毎 render 新 literal) を渡すと同じ理由で
// memo が死ぬため、 安定参照 (module 定数 or useMemo 済 object) を渡すこと。

import { useMemo } from 'react'
import {
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type PointerActivationConstraint,
  type KeyboardCodes,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'

export type SortableSensorOptions = {
  mouseActivationConstraint?: PointerActivationConstraint
  keyboardCodes?: KeyboardCodes
}

const TOUCH_SENSOR_OPTIONS = { activationConstraint: { delay: 250, tolerance: 5 } }
const DEFAULT_KEYBOARD_SENSOR_OPTIONS = { coordinateGetter: sortableKeyboardCoordinates }

export function useSortableSensors(options?: SortableSensorOptions) {
  const mouseSensorOptions = useMemo(
    () =>
      options?.mouseActivationConstraint
        ? { activationConstraint: options.mouseActivationConstraint }
        : undefined,
    [options?.mouseActivationConstraint],
  )
  const keyboardSensorOptions = useMemo(
    () =>
      options?.keyboardCodes
        ? { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: options.keyboardCodes }
        : DEFAULT_KEYBOARD_SENSOR_OPTIONS,
    [options?.keyboardCodes],
  )

  return useSensors(
    useSensor(MouseSensor, mouseSensorOptions),
    useSensor(TouchSensor, TOUCH_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, keyboardSensorOptions),
  )
}
