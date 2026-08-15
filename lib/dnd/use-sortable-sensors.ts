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

import {
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'

export function useSortableSensors() {
  return useSensors(
    useSensor(MouseSensor),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
}
