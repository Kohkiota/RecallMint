// @vitest-environment jsdom
// LocalSessionEntry (S-local-5) test。 dashboard 上の「保存済みカードで復習」
// button と overlay の挙動を verify。 StudySessionHost は mock し、 受け取る
// props (cards=[], userId, sessionLimit, fsrsMode, onNavigateAction, hideRetry,
// mode) を assertion する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const { mockStudySessionHost } = vi.hoisted(() => ({
  mockStudySessionHost: vi.fn(),
}))

vi.mock('../study/smart/_components/study-session-host', () => ({
  StudySessionHost: (props: Record<string, unknown>) => {
    mockStudySessionHost(props)
    return <div data-testid="study-session-host">host</div>
  },
}))

import { LocalSessionEntry } from './local-session-entry'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('LocalSessionEntry (S-local-5)', () => {
  it('初期: 「保存済みカードで復習」 button 表示、 overlay は不在', () => {
    render(
      <LocalSessionEntry userId="user-1" sessionLimit={20} fsrsMode={false} />,
    )
    expect(
      screen.getByRole('button', { name: '保存済みカードで復習' }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('study-session-host')).not.toBeInTheDocument()
  })

  it('「オフライン」 文言は button label にも DOM のどこにも出ない', () => {
    render(
      <LocalSessionEntry userId="user-1" sessionLimit={20} fsrsMode={false} />,
    )
    // 完全 offline 起動を保証しているように見える文言を避ける (OT 明示)
    expect(screen.queryByText(/オフライン/)).not.toBeInTheDocument()
  })

  it('button click → overlay 表示 + StudySessionHost に cards=[] / 各 prop 受け渡し', () => {
    render(
      <LocalSessionEntry userId="user-xyz" sessionLimit={42} fsrsMode={true} />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: '保存済みカードで復習' }),
    )
    // host が overlay 内に mount される
    expect(screen.getByTestId('study-session-host')).toBeInTheDocument()
    // 受け取る props を verify
    expect(mockStudySessionHost).toHaveBeenCalledTimes(1)
    const props = mockStudySessionHost.mock.calls[0][0] as {
      cards: unknown[]
      userId: string
      sessionLimit: number
      fsrsMode: boolean
      mode: string
      onNavigateAction: () => void
      hideRetry: boolean
    }
    expect(props.cards).toEqual([])
    expect(props.userId).toBe('user-xyz')
    expect(props.sessionLimit).toBe(42)
    expect(props.fsrsMode).toBe(true)
    expect(props.mode).toBe('smart')
    expect(typeof props.onNavigateAction).toBe('function')
    expect(props.hideRetry).toBe(true)
  })

  it('overlay 内 close button click → overlay 消える + button 再表示', () => {
    render(
      <LocalSessionEntry userId="user-1" sessionLimit={20} fsrsMode={false} />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: '保存済みカードで復習' }),
    )
    expect(screen.getByTestId('study-session-host')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(screen.queryByTestId('study-session-host')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '保存済みカードで復習' }),
    ).toBeInTheDocument()
  })

  it('StudySessionHost が onNavigateAction を呼ぶ (= 完了 click 想定) → overlay 自動 close', () => {
    render(
      <LocalSessionEntry userId="user-1" sessionLimit={20} fsrsMode={false} />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: '保存済みカードで復習' }),
    )
    expect(screen.getByTestId('study-session-host')).toBeInTheDocument()
    // mock host から渡された callback を発火 (実 host での完了 click 相当)。
    // 外部からの state update なので React batch 化のため act でラップ。
    const props = mockStudySessionHost.mock.calls[0][0] as {
      onNavigateAction: () => void
    }
    act(() => {
      props.onNavigateAction()
    })
    // overlay close、 button 再表示
    expect(screen.queryByTestId('study-session-host')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '保存済みカードで復習' }),
    ).toBeInTheDocument()
  })
})
