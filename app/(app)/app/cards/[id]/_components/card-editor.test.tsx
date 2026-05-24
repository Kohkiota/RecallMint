// @vitest-environment jsdom
// CardEditor client component の test。 server action updateCard と
// next/navigation の useRouter は mock。 option 操作 (追加 / 削除 / 上下) /
// 正解 checkbox / 正解 0 warning / 保存成功時のリダイレクト / 保存失敗時の
// error 表示を検証する。 dirty guard は T10 で撤廃済。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { CardOption } from '@/lib/db/schema'

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }))

vi.mock('../_actions/update-card', () => ({
  updateCard: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

import { CardEditor } from './card-editor'
import { updateCard } from '../_actions/update-card'

const baseProps = {
  cardId: 'card-1',
  examId: 'exam-1',
  examName: '基本情報技術者',
  initialTitle: '問1',
  initialQuestionText: '問題文です',
  initialOptions: [
    { id: 'a', text: '選択肢A', is_correct: true },
    { id: 'b', text: '選択肢B', is_correct: false },
  ] as CardOption[],
  initialExplanationText: '解説テキスト',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(updateCard).mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
})

describe('CardEditor', () => {
  it('初期描画: title / 問題文 / 選択肢 2 件が表示される', () => {
    render(<CardEditor {...baseProps} />)
    expect(screen.getByLabelText('タイトル')).toHaveValue('問1')
    expect(screen.getByLabelText('問題文')).toHaveValue('問題文です')
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getByLabelText('選択肢 1 の本文')).toHaveValue('選択肢A')
  })

  it('初期状態 (dirty なし) は保存ボタンが disabled', () => {
    render(<CardEditor {...baseProps} />)
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('選択肢を追加すると行が 1 つ増える', () => {
    render(<CardEditor {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: '選択肢を追加' }))
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
  })

  it('選択肢を削除すると行が減り、 残り 1 件で削除ボタンが disabled', () => {
    render(<CardEditor {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 2 を削除' }))
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '選択肢 1 を削除' })).toBeDisabled()
  })

  it('上下ボタンで選択肢の順序が入れ替わる', () => {
    render(<CardEditor {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 1 を下へ' }))
    expect(screen.getByLabelText('選択肢 1 の本文')).toHaveValue('選択肢B')
    expect(screen.getByLabelText('選択肢 2 の本文')).toHaveValue('選択肢A')
  })

  it('各選択肢に option ID label (ID のみ) が表示される', () => {
    render(<CardEditor {...baseProps} />)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('b')).toBeInTheDocument()
  })

  it('正解 summary が checkbox 状態にリアルタイム追従する', () => {
    render(<CardEditor {...baseProps} />)
    const summary = screen.getByText(/正解:/)
    // 初期: a のみ正解
    expect(summary).toHaveTextContent(/^正解: a$/)
    // 選択肢 b も正解に → "a, b"
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    expect(summary).toHaveTextContent(/^正解: a, b$/)
    // 両方外す → "未設定"
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    expect(summary).toHaveTextContent(/^正解: 未設定$/)
  })

  it('正解 checkbox を全て外すと正解 0 warning が出る', () => {
    render(<CardEditor {...baseProps} />)
    expect(
      screen.queryByText(/正解が選択されていません/),
    ).not.toBeInTheDocument()
    // 唯一 checked の選択肢 A を外す → 正解 0
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getByText(/正解が選択されていません/)).toBeInTheDocument()
  })

  it('保存成功: updateCard を呼び、 試験詳細 page にリダイレクトする', async () => {
    render(<CardEditor {...baseProps} />)
    fireEvent.change(screen.getByLabelText('タイトル'), {
      target: { value: '問1 改' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await vi.waitFor(() => {
      expect(updateCard).toHaveBeenCalledWith(
        'card-1',
        expect.objectContaining({ title: '問1 改' }),
      )
      expect(mockPush).toHaveBeenCalledWith('/app/exams/exam-1')
    })
  })

  it('保存失敗: updateCard の error メッセージを表示し、 遷移しない', async () => {
    vi.mocked(updateCard).mockResolvedValue({
      ok: false,
      error: 'タイトルは必須です',
    })
    render(<CardEditor {...baseProps} />)
    fireEvent.change(screen.getByLabelText('タイトル'), {
      target: { value: 'x' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('タイトルは必須です')).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('正解 checkbox を反映して updateCard に渡す (isCorrect 再構成)', async () => {
    render(<CardEditor {...baseProps} />)
    // 選択肢 B も正解にする → a, b 両方 true
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalled())
    const call = vi.mocked(updateCard).mock.calls[0][1]
    expect(call.options.map((o) => o.isCorrect)).toEqual([true, true])
  })
})

// `nextOptionId` の単体 test は S2.0b-3 で `lib/cards/next-option-id.test.ts` に
// 移動済 (純粋関数 + 共通 util への切り出しに伴う)。 同 file には旧 4 ケースの
// 移植 + 同等の coverage を保持。
