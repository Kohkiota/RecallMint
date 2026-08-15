// buildJaAnnouncements / SORTABLE_SR_INSTRUCTIONS / ROW_DND_SR_INSTRUCTIONS の unit test
// (row-dnd sprint task-2)。 純関数 + 定数のみのため vitest.config 既定 environment
// ('node') のままで足りる (jsdom 不要)。
//
// 検証軸 (brief §7 test 節):
// ① getLabel の label が文言に含まれる
// ② card/option の生 id 文字列が含まれない
// ③ sortable data あり = 位置句を含む / なし = 含まない
// ④ getLabel 空文字 → 総称 fallback
// ⑤ onDragEnd の over null / active===over → 「元の位置に戻しました」(完了文言でない)
// + instructions 2 定数の内容 pin (実キー割当と一致)

import { describe, it, expect } from 'vitest'
import type { Active, Over, UniqueIdentifier } from '@dnd-kit/core'

import {
  buildJaAnnouncements,
  SORTABLE_SR_INSTRUCTIONS,
  ROW_DND_SR_INSTRUCTIONS,
} from './accessibility'

// active/over は id と data.current しか参照されないため、 型を満たすためだけの
// 未使用 field は空値で埋め、 テスト用途に絞った minimal factory にする。
function makeActive(
  id: string,
  sortable?: { index: number; items: string[] },
): Active {
  return {
    id,
    data: { current: sortable ? { sortable } : undefined },
    rect: { current: { initial: null, translated: null } },
  } as unknown as Active
}

function makeOver(
  id: string,
  sortable?: { index: number; items: string[] },
): Over {
  return {
    id,
    disabled: false,
    rect: {} as Over['rect'],
    data: { current: sortable ? { sortable } : undefined },
  } as unknown as Over
}

// 生 id は意図的にラベルと似ても似つかない文字列にする (id が誤って混入したら
// 即座に検出できるようにするための fixture 設計)。
const RAW_ID = 'card-3f9a2c-raw-id'
const LABEL = '数学 II 第 3 回'

function getLabel(id: UniqueIdentifier): string {
  return id === RAW_ID ? LABEL : ''
}

describe('buildJaAnnouncements', () => {
  const announcements = buildJaAnnouncements(getLabel)

  describe('onDragStart', () => {
    it('① label を含む / ② 生 id は含まない', () => {
      const msg = announcements.onDragStart({ active: makeActive(RAW_ID) })
      expect(msg).toContain(LABEL)
      expect(msg).not.toContain(RAW_ID)
    })

    it('③ sortable data あり → 位置句 (index+1 / items.length 番目) を含む', () => {
      const msg = announcements.onDragStart({
        active: makeActive(RAW_ID, { index: 4, items: ['a', 'b', 'c', 'd', RAW_ID, 'f'] }),
      })
      expect(msg).toContain('5 / 6 番目')
    })

    it('③ sortable data なし → 位置句を含まない', () => {
      const msg = announcements.onDragStart({ active: makeActive(RAW_ID) })
      expect(msg).not.toMatch(/\d+ \/ \d+ 番目/)
    })

    it('④ getLabel 空文字 → 総称「項目」に fallback', () => {
      const msg = announcements.onDragStart({ active: makeActive('unknown-id') })
      expect(msg).toContain('項目')
    })
  })

  describe('onDragOver', () => {
    it('① label を含む / ② 生 id は含まない (over あり)', () => {
      const msg = announcements.onDragOver({
        active: makeActive(RAW_ID),
        over: makeOver('over-raw-id'),
      })
      expect(msg).toContain(LABEL)
      expect(msg).not.toContain(RAW_ID)
      expect(msg).not.toContain('over-raw-id')
    })

    it('③ over の sortable data あり → 位置句を含む', () => {
      const msg = announcements.onDragOver({
        active: makeActive(RAW_ID),
        over: makeOver('over-id', { index: 1, items: ['x', 'over-id', 'z'] }),
      })
      expect(msg).toContain('2 / 3 番目')
    })

    it('③ over の sortable data なし → 位置句を含まない', () => {
      const msg = announcements.onDragOver({
        active: makeActive(RAW_ID),
        over: makeOver('over-id'),
      })
      expect(msg).not.toMatch(/\d+ \/ \d+ 番目/)
    })

    it('over === null → ドロップ圏外の文言を返す (例外を投げない)', () => {
      const msg = announcements.onDragOver({ active: makeActive(RAW_ID), over: null })
      expect(msg).toContain(LABEL)
      expect(msg).toContain('外')
    })

    it('④ getLabel 空文字 → 総称「項目」に fallback', () => {
      const msg = announcements.onDragOver({
        active: makeActive('unknown-id'),
        over: makeOver('over-id'),
      })
      expect(msg).toContain('項目')
    })
  })

  describe('onDragEnd', () => {
    it('① label を含む / ② 生 id は含まない (移動確定)', () => {
      const msg = announcements.onDragEnd({
        active: makeActive(RAW_ID),
        over: makeOver('over-raw-id'),
      })
      expect(msg).toContain(LABEL)
      expect(msg).not.toContain(RAW_ID)
      expect(msg).not.toContain('over-raw-id')
    })

    it('③ over の sortable data あり → 位置句を含む', () => {
      const msg = announcements.onDragEnd({
        active: makeActive(RAW_ID),
        over: makeOver('over-id', { index: 2, items: ['a', 'b', 'over-id'] }),
      })
      expect(msg).toContain('3 / 3 番目')
    })

    it('③ over の sortable data なし → 位置句を含まない', () => {
      const msg = announcements.onDragEnd({
        active: makeActive(RAW_ID),
        over: makeOver('over-id'),
      })
      expect(msg).not.toMatch(/\d+ \/ \d+ 番目/)
    })

    it('⑤ over === null → 「元の位置に戻しました」(完了文言でない)', () => {
      const msg = announcements.onDragEnd({ active: makeActive(RAW_ID), over: null })
      expect(msg).toContain('元の位置に戻しました')
      expect(msg).not.toContain('完了')
    })

    it('⑤ active.id === over.id → 「元の位置に戻しました」(完了文言でない)', () => {
      const msg = announcements.onDragEnd({
        active: makeActive(RAW_ID),
        over: makeOver(RAW_ID),
      })
      expect(msg).toContain('元の位置に戻しました')
      expect(msg).not.toContain('完了')
    })

    it('over あり + 異なる id → 完了文言 (「元の位置に戻しました」ではない)', () => {
      const msg = announcements.onDragEnd({
        active: makeActive(RAW_ID),
        over: makeOver('over-id'),
      })
      expect(msg).toContain('完了')
      expect(msg).not.toContain('元の位置に戻しました')
    })

    it('④ getLabel 空文字 → 総称「項目」に fallback', () => {
      const msg = announcements.onDragEnd({
        active: makeActive('unknown-id'),
        over: null,
      })
      expect(msg).toContain('項目')
    })
  })

  describe('onDragCancel', () => {
    it('① label を含む / ② 生 id は含まない', () => {
      const msg = announcements.onDragCancel({
        active: makeActive(RAW_ID),
        over: null,
      })
      expect(msg).toContain(LABEL)
      expect(msg).not.toContain(RAW_ID)
    })

    it('④ getLabel 空文字 → 総称「項目」に fallback', () => {
      const msg = announcements.onDragCancel({
        active: makeActive('unknown-id'),
        over: null,
      })
      expect(msg).toContain('項目')
    })
  })
})

describe('SORTABLE_SR_INSTRUCTIONS / ROW_DND_SR_INSTRUCTIONS — 実キー割当と一致する文言 pin', () => {
  it('SORTABLE_SR_INSTRUCTIONS: Space / Enter どちらでも掴める旨を含む (tag 3 site の既定 keyboardCodes と一致)', () => {
    expect(SORTABLE_SR_INSTRUCTIONS.draggable).toContain('スペースキー')
    expect(SORTABLE_SR_INSTRUCTIONS.draggable).toContain('Enter キー')
    expect(SORTABLE_SR_INSTRUCTIONS.draggable).toContain('矢印キー')
    expect(SORTABLE_SR_INSTRUCTIONS.draggable).toContain('Escape キー')
  })

  it('ROW_DND_SR_INSTRUCTIONS: Space で掴む・Enter はメニューを開く旨を含む (Task 4 keyboardCodes と一致)', () => {
    expect(ROW_DND_SR_INSTRUCTIONS.draggable).toContain('スペースキー')
    expect(ROW_DND_SR_INSTRUCTIONS.draggable).toContain('矢印キー')
    expect(ROW_DND_SR_INSTRUCTIONS.draggable).toContain('Escape キー')
    expect(ROW_DND_SR_INSTRUCTIONS.draggable).toContain('メニューを開き')
  })

  it('2 定数は内容が異なる (tag site = Space/Enter で掴む、 行 DnD = Space のみで掴む・Enter はメニュー)', () => {
    expect(ROW_DND_SR_INSTRUCTIONS.draggable).not.toBe(SORTABLE_SR_INSTRUCTIONS.draggable)
    // 行 DnD 側は「Enter キーまたはスペースキーを押して」 のような "Enter でも掴める" 表現を
    // 持たない (Enter はメニュー起動に予約されているため)。
    expect(ROW_DND_SR_INSTRUCTIONS.draggable).not.toContain('Enter キーまたはスペースキー')
    expect(ROW_DND_SR_INSTRUCTIONS.draggable).not.toContain('スペースキーまたは Enter キー')
  })
})
