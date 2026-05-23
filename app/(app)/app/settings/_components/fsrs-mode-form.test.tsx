// @vitest-environment jsdom
// FsrsModeForm client component の test。
// saveFsrsMode action / useRouter を mock。 toggle 操作 / 成功時 router.refresh /
// 失敗時 error UI を検証。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockSaveFsrsMode, mockRefresh } = vi.hoisted(() => ({
  mockSaveFsrsMode: vi.fn(),
  mockRefresh: vi.fn(),
}))

vi.mock('../_actions/save-fsrs-mode', () => ({
  saveFsrsMode: mockSaveFsrsMode,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}))

import { FsrsModeForm } from './fsrs-mode-form'

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks()
  // Default: success path
  mockSaveFsrsMode.mockResolvedValue({ ok: true, data: { fsrsMode: true } })
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('FsrsModeForm', () => {
  describe('初期描画', () => {
    it('initial=false で checkbox が unchecked、 label に "FSRSモード (上級)" が含まれる', () => {
      render(<FsrsModeForm initial={false} />)
      const checkbox = screen.getByRole('checkbox', { name: /FSRSモード/ })
      expect(checkbox).not.toBeChecked()
      expect(screen.getByText(/FSRSモード\s*\(上級\)/)).toBeInTheDocument()
    })

    it('initial=true で checkbox が checked', () => {
      render(<FsrsModeForm initial={true} />)
      const checkbox = screen.getByRole('checkbox', { name: /FSRSモード/ })
      expect(checkbox).toBeChecked()
    })
  })

  describe('toggle 操作', () => {
    it('OFF → click で saveFsrsMode(true) 呼び出し', async () => {
      render(<FsrsModeForm initial={false} />)
      fireEvent.click(screen.getByRole('checkbox', { name: /FSRSモード/ }))
      await waitFor(() => {
        expect(mockSaveFsrsMode).toHaveBeenCalledWith(true)
      })
    })

    it('ON → click で saveFsrsMode(false) 呼び出し', async () => {
      mockSaveFsrsMode.mockResolvedValue({ ok: true, data: { fsrsMode: false } })
      render(<FsrsModeForm initial={true} />)
      fireEvent.click(screen.getByRole('checkbox', { name: /FSRSモード/ }))
      await waitFor(() => {
        expect(mockSaveFsrsMode).toHaveBeenCalledWith(false)
      })
    })
  })

  describe('成功時: router.refresh', () => {
    it('saveFsrsMode 成功 → router.refresh が呼ばれる', async () => {
      render(<FsrsModeForm initial={false} />)
      fireEvent.click(screen.getByRole('checkbox', { name: /FSRSモード/ }))
      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalled()
      })
    })
  })

  describe('失敗時: error UI', () => {
    it('saveFsrsMode 失敗 → error text が role=alert で表示、 router.refresh 呼ばれない', async () => {
      mockSaveFsrsMode.mockResolvedValue({ ok: false, error: '保存に失敗しました' })
      render(<FsrsModeForm initial={false} />)
      fireEvent.click(screen.getByRole('checkbox', { name: /FSRSモード/ }))
      const msg = await screen.findByRole('alert')
      expect(msg).toHaveTextContent('保存に失敗しました')
      expect(mockRefresh).not.toHaveBeenCalled()
    })
  })
})
