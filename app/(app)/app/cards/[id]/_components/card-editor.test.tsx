// @vitest-environment jsdom
// CardEditor client component の test。 server action updateCard は mock。
// option 操作 (追加 / 削除 / 上下) / 正答 checkbox / 正答 0 warning /
// 保存成功・失敗 / dirty 時の離脱 confirm を検証する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { CardOption } from '@/lib/db/schema'

vi.mock('../_actions/update-card', () => ({
  updateCard: vi.fn(),
}))

import { CardEditor, nextOptionId } from './card-editor'
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

  it('各選択肢に option ID label が表示される', () => {
    render(<CardEditor {...baseProps} />)
    expect(screen.getByText('選択肢 a')).toBeInTheDocument()
    expect(screen.getByText('選択肢 b')).toBeInTheDocument()
  })

  it('現在の正解 summary が checkbox 状態にリアルタイム追従する', () => {
    render(<CardEditor {...baseProps} />)
    const summary = screen.getByText(/現在の正解:/)
    // 初期: a のみ正答
    expect(summary).toHaveTextContent(/^現在の正解: a$/)
    // 選択肢 b も正答に → "a, b"
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    expect(summary).toHaveTextContent(/^現在の正解: a, b$/)
    // 両方外す → "未設定"
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    expect(summary).toHaveTextContent(/^現在の正解: 未設定$/)
  })

  it('正答 checkbox を全て外すと正答 0 warning が出る', () => {
    render(<CardEditor {...baseProps} />)
    expect(
      screen.queryByText(/正答が選択されていません/),
    ).not.toBeInTheDocument()
    // 唯一 checked の選択肢 A を外す → 正答 0
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getByText(/正答が選択されていません/)).toBeInTheDocument()
  })

  it('保存成功: updateCard を呼び、 成功メッセージを表示する', async () => {
    render(<CardEditor {...baseProps} />)
    fireEvent.change(screen.getByLabelText('タイトル'), {
      target: { value: '問1 改' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('保存しました')).toBeInTheDocument()
    expect(updateCard).toHaveBeenCalledWith(
      'card-1',
      expect.objectContaining({ title: '問1 改' }),
    )
  })

  it('保存成功後は dirty が解消し保存ボタンが再び disabled', async () => {
    render(<CardEditor {...baseProps} />)
    fireEvent.change(screen.getByLabelText('タイトル'), {
      target: { value: '問1 改' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('保存しました')
    // isPending が false に戻り label が「保存」へ復帰するのを待ってから検証
    expect(await screen.findByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('保存失敗: updateCard の error メッセージを表示する', async () => {
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
  })

  it('正答 checkbox を反映して updateCard に渡す (isCorrect 再構成)', async () => {
    render(<CardEditor {...baseProps} />)
    // 選択肢 B も正答にする → a, b 両方 true
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('保存しました')
    const call = vi.mocked(updateCard).mock.calls[0][1]
    expect(call.options.map((o) => o.isCorrect)).toEqual([true, true])
  })

  it('dirty 時に breadcrumb link を押すと離脱 confirm が走る', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<CardEditor {...baseProps} />)
    fireEvent.change(screen.getByLabelText('タイトル'), {
      target: { value: '変更' },
    })
    fireEvent.click(screen.getByRole('link', { name: '試験一覧' }))
    expect(confirmSpy).toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('dirty でない時は breadcrumb link で confirm が走らない', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CardEditor {...baseProps} />)
    fireEvent.click(screen.getByRole('link', { name: '試験一覧' }))
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('dirty になると beforeunload listener が登録される', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    render(<CardEditor {...baseProps} />)
    const beforeDirty = addSpy.mock.calls.filter(
      (c) => c[0] === 'beforeunload',
    ).length
    fireEvent.change(screen.getByLabelText('タイトル'), {
      target: { value: '変更後' },
    })
    const afterDirty = addSpy.mock.calls.filter(
      (c) => c[0] === 'beforeunload',
    ).length
    expect(beforeDirty).toBe(0)
    expect(afterDirty).toBeGreaterThan(0)
    addSpy.mockRestore()
  })
})

describe('nextOptionId', () => {
  it('英字のみ → 次の英字', () => {
    expect(nextOptionId(['a', 'b', 'c'])).toBe('d')
  })

  it('数字のみ → 最大値 + 1', () => {
    expect(nextOptionId(['1', '2', '3'])).toBe('4')
  })

  it('英字が z まで埋まったら opt-N に fallback', () => {
    const az = Array.from({ length: 26 }, (_, i) =>
      String.fromCharCode(97 + i),
    )
    expect(nextOptionId(az)).toBe('opt-1')
  })

  it('空 / 混在は opt-N、 既存 opt-N とは衝突しない', () => {
    expect(nextOptionId([])).toBe('opt-1')
    expect(nextOptionId(['a', '1'])).toBe('opt-1')
    expect(nextOptionId(['opt-1', 'x'])).toBe('opt-2')
  })
})
