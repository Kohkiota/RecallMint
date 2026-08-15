// @vitest-environment jsdom
//
// exam-card-row-dnd (row-dnd sprint task-3 / row-ux task-4) の unit test。
//
// 掴み手 button 自体はこの file の管轄外 (row-ux §2.2 で二役グリップに統合され、実体は
// exam-card-row-menu.tsx の trigger — その test は exam-card-row-menu.test.tsx)。 ここでは
// **provider (SortableRow) が consumer (useRowDnd) へ何を配るか** を **real DndContext /
// real SortableContext** の下で検証する。 listeners の有無は dnd-kit が
// `useSortable({disabled})` に応じて undefined を返す実挙動 (core.esm.js:3446) に依存する
// ため、mock ではなく実物の出力でなければ意味を持たない。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import { SortableRow, useRowDnd } from './exam-card-row-dnd'

afterEach(() => {
  cleanup()
})

const CARD_ID = 'card-1'
const LOCKED_REASON_ID = 'locked-reason-test-id'

/**
 * useRowDnd の戻り値を DOM 属性に写す consumer。 grip (row-menu) の代役で、
 * 「provider が何を配ったか」だけを観測する。
 */
function RowDndProbe() {
  const ctx = useRowDnd()
  if (!ctx) return <span data-testid="probe" data-has-context="false" />
  return (
    <span
      data-testid="probe"
      data-has-context="true"
      data-drag-available={String(ctx.dragAvailable)}
      data-locked={String(ctx.locked)}
      data-pending={String(ctx.pending)}
      data-locked-reason-id={ctx.lockedReasonId}
      // dnd-kit は disabled のとき listeners を undefined で返す (core.esm.js:3446)。
      // = 「ドラッグ役が生きているか」の観測点。
      data-has-listeners={String(ctx.listeners !== undefined)}
    />
  )
}

// SortableRow は provider・grip は select 列 cell 内に置かれる想定なので、td でラップして
// 本番の DOM 構造 (tr > td > grip) を再現する。
function Harness({
  dragAvailable = true,
  locked = false,
  pending = false,
  lockedReasonId = LOCKED_REASON_ID,
  measureElement = vi.fn(),
}: {
  dragAvailable?: boolean
  locked?: boolean
  pending?: boolean
  lockedReasonId?: string
  measureElement?: (node: Element | null) => void
}) {
  // sensors: DndContext 既定 (PointerSensor) で足りる — 本 test は実 pointer drag を
  // 行わず、context 値の静的な出力だけを検証する。
  const sensors = useSensors(useSensor(PointerSensor))
  return (
    <DndContext sensors={sensors}>
      <SortableContext items={[CARD_ID]} strategy={verticalListSortingStrategy}>
        <table>
          <tbody>
            <SortableRow
              cardId={CARD_ID}
              index={0}
              dragAvailable={dragAvailable}
              locked={locked}
              pending={pending}
              lockedReasonId={lockedReasonId}
              measureElement={measureElement}
            >
              <td>
                <RowDndProbe />
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

function probe(): HTMLElement {
  return screen.getByTestId('probe')
}

describe('useRowDnd — provider の有無', () => {
  it('provider 不在 (SortableRow 未経由) では null を返す', () => {
    render(<RowDndProbe />)
    expect(probe()).toHaveAttribute('data-has-context', 'false')
  })

  it('SortableRow 配下では gating 3 値と理由 id がそのまま配られる', () => {
    render(<Harness dragAvailable locked pending lockedReasonId="reason-xyz" />)
    expect(probe()).toHaveAttribute('data-has-context', 'true')
    expect(probe()).toHaveAttribute('data-drag-available', 'true')
    expect(probe()).toHaveAttribute('data-locked', 'true')
    expect(probe()).toHaveAttribute('data-pending', 'true')
    expect(probe()).toHaveAttribute('data-locked-reason-id', 'reason-xyz')
  })
})

describe('SortableRow — useSortable disabled の 3 条件 (listeners の有無で観測)', () => {
  it('dragAvailable かつ locked/pending でなければ listeners が配られる', () => {
    render(<Harness />)
    expect(probe()).toHaveAttribute('data-has-listeners', 'true')
  })

  it('dragAvailable:false (1 枚の試験) では listeners が配られない', () => {
    render(<Harness dragAvailable={false} />)
    expect(probe()).toHaveAttribute('data-has-listeners', 'false')
  })

  it('locked:true (ソート/フィルタ適用中) では listeners が配られない', () => {
    render(<Harness locked />)
    expect(probe()).toHaveAttribute('data-has-listeners', 'false')
  })

  it('pending:true (移動実行中) では listeners が配られない', () => {
    render(<Harness pending />)
    expect(probe()).toHaveAttribute('data-has-listeners', 'false')
  })
})

describe('SortableRow — event 分離契約 (<tr> は drag 起点にならない)', () => {
  it('<tr> に dnd の aria-roledescription / touch-none が付かない (grip のみが持つ)', () => {
    const { container } = render(<Harness />)
    const tr = container.querySelector('tr') as HTMLElement
    expect(tr).not.toHaveAttribute('aria-roledescription')
    expect(tr.className).not.toContain('touch-none')
    // 行内の他の要素にも touch-none は無い (grip は本 file の外なのでゼロが正)。
    expect(container.querySelectorAll('[class~="touch-none"]')).toHaveLength(0)
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
