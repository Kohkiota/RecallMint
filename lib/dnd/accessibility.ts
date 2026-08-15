// DnD (dnd-kit) の screen reader 向け a11y 部品。
//
// dnd-kit の既定 announcements / screenReaderInstructions は英語 + 生の card/option
// id をそのまま読み上げる (`Picked up draggable item card-3.` 等、
// `node_modules/@dnd-kit/core/dist/core.esm.js` の `defaultAnnouncements` 参照)。
// 日本語 UI に対して品質 gap があるため、 tag 系 3 site (category-list / option-list /
// card-tag-add-popover stage1・stage2) + 行 DnD (Task 4, exam-card-table) が共有する
// announcements factory と instructions 定数をここに集約する (row-dnd sprint task-2)。
//
// 位置情報の出典: `active.data.current?.sortable` / `over.data.current?.sortable` は
// dnd-kit sortable の `useSortable` が各 draggable/droppable の data に埋め込む
// `{ containerId, index, items }` (`node_modules/@dnd-kit/sortable/dist/sortable.esm.js`
// 463-469 行で確認済)。 index の意味論は「その item の items 内位置」 で
// dnd-kit default announcements と同一解釈 (0-origin を +1 して人間向け 1-origin にする)。
// sortable data が無い (measuring 未完了 / non-sortable droppable 上) ときは、
// 無い情報を捏造せず位置句を省略する。
//
// 生 id を文言に出さない (getLabel が空文字を返したら総称「項目」に fallback)。

import type {
  Active,
  Announcements,
  Data,
  Over,
  ScreenReaderInstructions,
  UniqueIdentifier,
} from '@dnd-kit/core'

const GENERIC_ITEM_LABEL = '項目'

// onDragEnd で over===null / active.id===over.id (= drop 不発 or 元位置へのドロップ) の
// ときに使う文言。 「移動しました」 系と誤読させないよう、 完了を意味する語を含めない
// (spec §7 の分岐要件)。
const RETURNED_TO_ORIGINAL_POSITION = '元の位置に戻しました。'

type SortablePositionData = {
  sortable?: {
    index: number
    items: UniqueIdentifier[]
  }
}

function resolveLabel(
  getLabel: (id: UniqueIdentifier) => string,
  id: UniqueIdentifier,
): string {
  const label = getLabel(id)
  return label === '' ? GENERIC_ITEM_LABEL : label
}

// sortable data が持つ 1-origin の位置句 (例: "5 / 10 番目")。 データ不在時は空文字を
// 返し、 呼出側で位置句を省略する分岐に使う。
function describePosition(data: Data | undefined): string {
  const sortable = (data as SortablePositionData | undefined)?.sortable
  if (!sortable) return ''
  return `${sortable.index + 1} / ${sortable.items.length} 番目`
}

/**
 * dnd-kit `DndContext` の `accessibility.announcements` に渡す日本語版 factory。
 * getLabel は各 site の item 配列から名前を引く lookup を呼出側が用意する
 * (不安定参照を DndContext に渡さないよう useCallback で安定化すること)。
 */
export function buildJaAnnouncements(
  getLabel: (id: UniqueIdentifier) => string,
): Announcements {
  return {
    onDragStart({ active }: { active: Active }) {
      const label = resolveLabel(getLabel, active.id)
      const position = describePosition(active.data.current)
      return position
        ? `${label} をつかみました。現在の位置は ${position} です。`
        : `${label} をつかみました。`
    },
    onDragOver({ active, over }: { active: Active; over: Over | null }) {
      const label = resolveLabel(getLabel, active.id)
      if (!over) {
        return `${label} は現在ドロップ可能な範囲の外にあります。`
      }
      const position = describePosition(over.data.current)
      return position
        ? `${label} を ${position} に移動中です。`
        : `${label} を移動中です。`
    },
    onDragEnd({ active, over }: { active: Active; over: Over | null }) {
      const label = resolveLabel(getLabel, active.id)
      if (!over || active.id === over.id) {
        return `${label} を${RETURNED_TO_ORIGINAL_POSITION}`
      }
      const position = describePosition(over.data.current)
      return position
        ? `${label} の並べ替えが完了しました。新しい位置は ${position} です。`
        : `${label} の並べ替えが完了しました。`
    },
    onDragCancel({ active }: { active: Active }) {
      const label = resolveLabel(getLabel, active.id)
      return `${label} の並べ替えを取り消しました。${RETURNED_TO_ORIGINAL_POSITION}`
    },
  }
}

// tag 3 site (category-list / option-list / card-tag-add-popover stage1・stage2) 用。
// `useSortableSensors()` 既定 keyboardCodes (Space / Enter どちらでも掴める) と一致
// させる文言。
export const SORTABLE_SR_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    '項目をつかむには、スペースキーまたは Enter キーを押してください。' +
    'ドラッグ中は矢印キーで移動できます。' +
    'もう一度スペースキーまたは Enter キーを押すと新しい位置に確定し、' +
    'Escape キーを押すと取り消します。',
}

// 行 DnD (exam-card-table) 用。 Task 1 で入った
// `keyboardCodes = { start: ['Space'], cancel: ['Escape'], end: ['Space','Enter','Tab'] }`
// では Enter が「掴む」 でなく「行のメニューを開く」 に予約されるため、 tag 3 site とは
// 別文言にする (2 定数を分ける理由そのもの)。
// 消費は Task 4 (テーブル行 DnD の DndContext 配線) — 本 task 時点では未配線の export。
export const ROW_DND_SR_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    '行をつかむには、スペースキーを押してください。' +
    'ドラッグ中は矢印キーで移動できます。' +
    'もう一度スペースキーを押すと新しい位置に確定し、' +
    'Escape キーを押すと取り消します。' +
    'Enter キーを押すと行のメニューを開きます。',
}
