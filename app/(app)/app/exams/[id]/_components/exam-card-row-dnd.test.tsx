// @vitest-environment jsdom
//
// exam-card-row-dnd (row-dnd sprint task-3) の unit test。
//
// この file は task-4 未配線 (SortableRow は TableBody からまだ呼ばれていない) を前提に、
// 部品単体を **real DndContext / real SortableContext** の下で render する
// (category-list.test.tsx:590- の event 分離契約 pin と同型)。 handle の
// attributes/listeners は mock ではなく実物の dnd-kit 出力である必要があるため
// (aria-describedby 合成 pin・aria-roledescription pin が実物でないと意味を持たない)。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import {
  SortableRow,
  RowDragHandle,
  ROW_DND_LOCKED_REASON,
} from './exam-card-row-dnd'

afterEach(() => {
  cleanup()
})

const CARD_ID = 'card-1'
const LOCKED_REASON_ID = 'locked-reason-test-id'

// SortableRow は provider・RowDragHandle は select 列 cell 内に置かれる想定なので、
// td でラップして本番の DOM 構造 (tr > td > handle) を再現する。outerOnClick は
// select td の onClick (行選択トグル・exam-card-table.tsx:218-220) の代役。
function Harness({
  showHandle = true,
  locked = false,
  pending = false,
  lockedReasonId = LOCKED_REASON_ID,
  measureElement = vi.fn(),
  outerOnClick,
}: {
  showHandle?: boolean
  locked?: boolean
  pending?: boolean
  lockedReasonId?: string
  measureElement?: (node: Element | null) => void
  outerOnClick?: () => void
}) {
  // sensors: DndContext 既定 (PointerSensor) で足りる — 本 test は実 pointer drag を
  // 行わず、attributes/listeners の静的な出力だけを検証する。
  const sensors = useSensors(useSensor(PointerSensor))
  return (
    <DndContext sensors={sensors}>
      <SortableContext items={[CARD_ID]} strategy={verticalListSortingStrategy}>
        <table>
          <tbody>
            <SortableRow
              cardId={CARD_ID}
              index={0}
              showHandle={showHandle}
              locked={locked}
              pending={pending}
              lockedReasonId={lockedReasonId}
              measureElement={measureElement}
            >
              <td onClick={outerOnClick}>
                <RowDragHandle cardTitle="カードA" />
              </td>
              <td>
                <button type="button">他の行内 button</button>
              </td>
            </SortableRow>
          </tbody>
        </table>
      </SortableContext>
    </DndContext>
  )
}

describe('SortableRow / RowDragHandle — event 分離契約', () => {
  it('handle button のみが aria-roledescription (dnd-kit 標準 sortable) を持つ (tr / 他 button は持たない)', () => {
    const { container } = render(<Harness />)
    const handle = screen.getByRole('button', { name: '行を並べ替え: カードA' })
    expect(handle).toHaveAttribute('aria-roledescription', 'sortable')

    const tr = container.querySelector('tr')
    expect(tr).not.toHaveAttribute('aria-roledescription')

    const otherButton = screen.getByRole('button', { name: '他の行内 button' })
    expect(otherButton).not.toHaveAttribute('aria-roledescription')
  })

  it('`touch-none` class は handle button のみに付与される (tr / 他 button には付かない)', () => {
    const { container } = render(<Harness />)
    const touchNoneEls = container.querySelectorAll('[class~="touch-none"]')
    expect(touchNoneEls.length).toBe(1)
    expect(touchNoneEls[0].tagName).toBe('BUTTON')
    expect(touchNoneEls[0]).toHaveAttribute('aria-label', '行を並べ替え: カードA')
  })

  it('handle click で外側 (select td) の onClick が発火しない (stopPropagation)', () => {
    const outerOnClick = vi.fn()
    render(<Harness outerOnClick={outerOnClick} />)
    const handle = screen.getByRole('button', { name: '行を並べ替え: カードA' })
    fireEvent.click(handle)
    expect(outerOnClick).not.toHaveBeenCalled()
  })
})

describe('RowDragHandle — provider 不在 / showHandle:false は非描画', () => {
  it('RowDndContext provider 不在 (SortableRow 未経由) では handle は描画されない', () => {
    render(<RowDragHandle cardTitle="単体カード" />)
    expect(
      screen.queryByRole('button', { name: /行を並べ替え:/ }),
    ).not.toBeInTheDocument()
  })

  it('showHandle:false では provider 有りでも handle は描画されない', () => {
    render(<Harness showHandle={false} />)
    expect(
      screen.queryByRole('button', { name: /行を並べ替え:/ }),
    ).not.toBeInTheDocument()
  })
})

describe('RowDragHandle — locked / pending の disabled + aria-describedby 合成', () => {
  it('locked:true — disabled + title=ROW_DND_LOCKED_REASON + aria-describedby は lockedReasonId を含みつつ単独値ではない (dnd-kit 自前 id の温存 pin)', () => {
    render(<Harness locked pending={false} />)
    const handle = screen.getByRole('button', { name: '行を並べ替え: カードA' })
    expect(handle).toBeDisabled()
    expect(handle).toHaveAttribute('title', ROW_DND_LOCKED_REASON)

    const describedBy = handle.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    // 合成 pin: lockedReasonId を含む (locked 理由が消えていない)。
    expect(describedBy).toContain(LOCKED_REASON_ID)
    // 合成 pin: lockedReasonId 単独値ではない (dnd-kit 自前の aria-describedby が
    // 生き残っている — 素朴な上書きだとここが lockedReasonId 単独値に潰れる)。
    expect(describedBy).not.toBe(LOCKED_REASON_ID)
  })

  it('pending:true (locked:false) — disabled のみ。title 無し・aria-describedby は lockedReasonId を含まない', () => {
    render(<Harness locked={false} pending />)
    const handle = screen.getByRole('button', { name: '行を並べ替え: カードA' })
    expect(handle).toBeDisabled()
    expect(handle).not.toHaveAttribute('title')

    const describedBy = handle.getAttribute('aria-describedby')
    expect(describedBy).not.toContain(LOCKED_REASON_ID)
  })

  it('locked:false かつ pending:false — disabled ではなく、aria-describedby は dnd-kit 自前の id のみ (lockedReasonId を含まない)', () => {
    render(<Harness locked={false} pending={false} />)
    const handle = screen.getByRole('button', { name: '行を並べ替え: カードA' })
    expect(handle).not.toBeDisabled()
    const describedBy = handle.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    expect(describedBy).not.toContain(LOCKED_REASON_ID)
  })
})

describe('SortableRow — merge ref (setNodeRef + measureElement) の identity 安定性', () => {
  it('同一 props での再 render で measureElement が再呼出しされない (ref callback の identity 安定 pin)', () => {
    const measureElement = vi.fn()
    const { rerender } = render(<Harness measureElement={measureElement} />)

    // mount 時に最低 1 回 (実 node で) 呼ばれていることを sanity 確認する。
    const callsAfterMount = measureElement.mock.calls.length
    expect(callsAfterMount).toBeGreaterThan(0)

    // 同一 props (measureElement も同一 fn 参照) での再 render。
    // merge ref の identity が inline arrow のように毎 render 変わるなら、 React は
    // 旧 ref を null で呼び (detach) → 新 ref を node で呼ぶ (attach) ため
    // measureElement の呼出回数が増える。 useCallback で identity を固定していれば
    // ref 自体の参照が変わらないため React は再呼出ししない。
    rerender(<Harness measureElement={measureElement} />)
    expect(measureElement.mock.calls.length).toBe(callsAfterMount)
  })
})
