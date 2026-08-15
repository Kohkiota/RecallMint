// @vitest-environment jsdom
// ExamCardTableAddFooter unit test (row-ux sprint Task 5 / spec §8.1 / kickoff 決定 8)。
//
// useAddCard は spy mock に差し替える (hook 自体の非自明な実行順の契約は
// use-add-card.test.tsx が既に pin 済 — ここでは footer が受け取った prop をそのまま
// addCard へ forward しているか / gating 3 条件 / error UI のみを検証する)。
//
// brief の deferred 指定 (task-5-brief.md):
//   - ② dataReady:false → disabled は、実 liveData 未解決状態でしか意味を持たないため
//     table 統合 (exam-card-table.test.tsx「(a) liveData 解決前」) に委譲し、ここでは
//     単体 test を持たない (props 直渡しの enabled/disabled 分岐は⑤で確認できる範囲)。
//   - ④ movePending → disabled は plan の OT 修正2 によりこの task では test化しない
//     (`disabled` 式の実装自体は不触ではなく実施済 — 3 項目目の OR 項として存在する)。
//
// ① の scope 注記 (実装時の発見・task-5-report.md 詳述): kickoff 決定 8 の契約は「呼出側
// (exam-card-table.tsx) が data (基準順全件) から baseOrders/count を算出し、
// table.getRowModel().rows (sort/filter 適用後) を渡さない」ことだが、これを実 click で
// red 化する full render 統合 test は成立しない — sort/filter を適用すると同じ
// positionLocked gate で button 自体が disabled になり (native disabled は click を発火
// させない)、divergence が起こる状態は構造的に常に unclickable (実験で確認済)。
// そのため ① は footer 自身の契約 (受け取った baseOrders/count を内部で再フィルタ/再算出
// せず addCard へそのまま forward する) を pin する — 呼出側の「data から算出する」実装は
// exam-card-table.tsx 側の footerBaseOrders 定義 (コード上の contract コメント) で保つ。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'

const { mockAddCard } = vi.hoisted(() => ({
  mockAddCard: vi.fn<(baseOrders: number[], count: number) => Promise<string>>(),
}))

vi.mock('../_hooks/use-add-card', () => ({
  useAddCard: () => ({ addCard: mockAddCard }),
}))

import { ExamCardTableAddFooter, ADD_CARD_LOCKED_REASON } from './exam-card-table-add-footer'

const USER_ID = 'user-add-footer'
const EXAM_ID = 'exam-add-footer'

// footer は <tfoot><tr><td> を返すため、<table> でラップしないと jsdom の
// validateDOMNesting 警告 (tfoot が div の子) が出る。
function renderFooter(props: Partial<Parameters<typeof ExamCardTableAddFooter>[0]> = {}) {
  return render(
    <table>
      <ExamCardTableAddFooter
        userId={USER_ID}
        examId={EXAM_ID}
        baseOrders={[]}
        count={0}
        colSpan={1}
        dataReady={true}
        positionLocked={false}
        movePending={false}
        {...props}
      />
    </table>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAddCard.mockResolvedValue('mock-new-card-id')
})

afterEach(() => {
  cleanup()
})

// ===========================================================================
// ① kickoff 決定 8: footer は受け取った baseOrders/count をそのまま addCard へ forward する
// (内部で再フィルタ・再算出・reorder しない — 呼出側の基準順全件契約を footer が保つ)
// ===========================================================================

describe('① kickoff 決定 8: baseOrders/count を addCard へそのまま forward する', () => {
  it('基準順全件を模した baseOrders/count prop が addCard へ改変なしで渡る', () => {
    const basisBaseOrders = [1024, 2048, 3072]
    renderFooter({ baseOrders: basisBaseOrders, count: 3 })

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '＋ カードを追加' }))
    })

    // red 検証対象: footer 内で baseOrders を slice/filter/reorder する実装ミスがあると
    // (例: 表示中の一部だけを渡す・順序を変える) この exact-array 比較が fail する。
    expect(mockAddCard).toHaveBeenCalledWith(basisBaseOrders, 3)
  })
})

// ===========================================================================
// ③ positionLocked: disabled + 理由表示 (title + 隣接 text-xs)
// ===========================================================================

describe('③ positionLocked: disabled + 理由表示', () => {
  it('positionLocked=true で button disabled、 title 属性と隣接 text-xs に理由が出る', () => {
    renderFooter({ positionLocked: true })

    const button = screen.getByRole('button', { name: '＋ カードを追加' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', ADD_CARD_LOCKED_REASON)
    expect(screen.getByText(ADD_CARD_LOCKED_REASON)).toBeInTheDocument()
  })

  it('positionLocked=false では title 属性も理由 text も出ない', () => {
    renderFooter({ positionLocked: false })

    const button = screen.getByRole('button', { name: '＋ カードを追加' })
    expect(button).not.toHaveAttribute('title')
    expect(screen.queryByText(ADD_CARD_LOCKED_REASON)).not.toBeInTheDocument()
  })
})

// ===========================================================================
// ⑤ 全 gate false + count 0 で enabled (0 件解決済)
// ===========================================================================

describe('⑤ 全 gate false + count 0 で enabled', () => {
  it('dataReady=true / positionLocked=false / movePending=false / count=0 で button が enabled', () => {
    renderFooter({
      dataReady: true,
      positionLocked: false,
      movePending: false,
      baseOrders: [],
      count: 0,
    })

    expect(screen.getByRole('button', { name: '＋ カードを追加' })).toBeEnabled()
  })
})

// ===========================================================================
// ⑥ colSpan 反映
// ===========================================================================

describe('⑥ colSpan 反映', () => {
  it('colSpan prop が td の colSpan 属性に反映される', () => {
    const { container } = renderFooter({ colSpan: 9 })

    const td = container.querySelector('td') as HTMLTableCellElement
    expect(td.colSpan).toBe(9)
  })
})

// ===========================================================================
// ⑦ addCard reject で inline error 表示 → 再 click で error が一旦消える
// (Codex 抜け 12 採用 — click 冒頭の setError(null) が同期発火することの pin)
// ===========================================================================

describe('⑦ addCard reject → inline error → 再 click で一旦消える', () => {
  it('1 回目 reject で error 表示、 2 回目 click 直後 (未解決の間) は error が消える', async () => {
    let releaseSecond: (() => void) | undefined
    mockAddCard
      .mockRejectedValueOnce(new Error('boom1'))
      .mockImplementationOnce(
        () =>
          new Promise<string>((_resolve, reject) => {
            releaseSecond = () => reject(new Error('boom2'))
          }),
      )

    renderFooter()
    const button = screen.getByRole('button', { name: '＋ カードを追加' })

    act(() => {
      fireEvent.click(button)
    })
    await waitFor(() => {
      expect(screen.getByText('カードの追加に失敗しました。')).toBeInTheDocument()
    })

    // 2 回目 click: handleClick 冒頭の setError(null) が addCard の await より前に
    // 同期発火するため、 2 回目の addCard が未解決の間は error 表示が一旦消えている。
    act(() => {
      fireEvent.click(button)
    })
    expect(screen.queryByText('カードの追加に失敗しました。')).not.toBeInTheDocument()

    // 後始末: 2 回目の promise を解決させ、 pending を残さない。
    await act(async () => {
      releaseSecond?.()
    })
    await waitFor(() => {
      expect(screen.getByText('カードの追加に失敗しました。')).toBeInTheDocument()
    })
  })
})
