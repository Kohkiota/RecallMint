// @vitest-environment jsdom
// LocalSessionOverlay (S-local-5 UX refactor) test。 props で受け取った
// onCloseAction が close button + 内部 StudySessionHost (= 完了画面) いずれにも
// 伝播することを verify。 「オフライン」 文言が DOM のどこにも出ないこと
// (= 完全 offline 新規起動を保証していると誤解させない、 OT 明示) を guard。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const { mockStudySessionHost } = vi.hoisted(() => ({
  mockStudySessionHost: vi.fn(),
}))

vi.mock('../study/smart/_components/study-session-host', () => ({
  StudySessionHost: (props: Record<string, unknown>) => {
    mockStudySessionHost(props)
    return <div data-testid="study-session-host">host</div>
  },
}))

import { LocalSessionOverlay } from './local-session-overlay'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('LocalSessionOverlay (S-local-5 UX refactor)', () => {
  it('StudySessionHost に cards=[] / 各 prop / onNavigateAction=onCloseAction / hideRetry=true', () => {
    const onCloseAction = vi.fn()
    render(
      <LocalSessionOverlay
        userId="user-xyz"
        sessionLimit={42}
        fsrsMode={true}
        onCloseAction={onCloseAction}
      />,
    )
    expect(screen.getByTestId('study-session-host')).toBeInTheDocument()
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
    expect(props.onNavigateAction).toBe(onCloseAction)
    expect(props.hideRetry).toBe(true)
  })

  it('右上 close button click → onCloseAction 呼出', () => {
    const onCloseAction = vi.fn()
    render(
      <LocalSessionOverlay
        userId="user-1"
        sessionLimit={20}
        fsrsMode={false}
        onCloseAction={onCloseAction}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(onCloseAction).toHaveBeenCalledTimes(1)
  })

  it('「オフライン」 文言が DOM のどこにも存在しない (regression guard)', () => {
    render(
      <LocalSessionOverlay
        userId="user-1"
        sessionLimit={20}
        fsrsMode={false}
        onCloseAction={vi.fn()}
      />,
    )
    expect(screen.queryByText(/オフライン/)).not.toBeInTheDocument()
  })

  it('「保存済みカードで復習」 文言が overlay 内に表示されない (= trigger button は親側、 overlay 内は重複しない guard)', () => {
    render(
      <LocalSessionOverlay
        userId="user-1"
        sessionLimit={20}
        fsrsMode={false}
        onCloseAction={vi.fn()}
      />,
    )
    expect(screen.queryByText(/保存済みカードで復習/)).not.toBeInTheDocument()
  })
})
