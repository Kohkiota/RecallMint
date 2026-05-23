// @vitest-environment jsdom
// SessionLimitForm client component の test。
// saveSessionLimit action を mock して preset button / input / 保存 button / message を検証。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockSaveSessionLimit } = vi.hoisted(() => ({
  mockSaveSessionLimit: vi.fn(),
}))

vi.mock('../_actions/save-session-limit', () => ({
  saveSessionLimit: mockSaveSessionLimit,
}))

import { SessionLimitForm } from './session-limit-form'

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks()
  // Default: save succeeds
  mockSaveSessionLimit.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('SessionLimitForm', () => {
  describe('初期描画', () => {
    it('initial=20 で input value=20、 20 button が active (variant=default)', () => {
      render(<SessionLimitForm initial={20} />)
      const input = screen.getByRole('spinbutton')
      expect(input).toHaveValue(20)
      // 20 preset button が active state (data-variant="default")
      const btn20 = screen.getByRole('button', { name: '20' })
      expect(btn20).toHaveAttribute('data-variant', 'default')
      // 10 / 50 は outline
      expect(screen.getByRole('button', { name: '10' })).toHaveAttribute(
        'data-variant',
        'outline',
      )
      expect(screen.getByRole('button', { name: '50' })).toHaveAttribute(
        'data-variant',
        'outline',
      )
    })

    it('initial=10 で 10 button が active', () => {
      render(<SessionLimitForm initial={10} />)
      expect(screen.getByRole('button', { name: '10' })).toHaveAttribute(
        'data-variant',
        'default',
      )
      expect(screen.getByRole('button', { name: '20' })).toHaveAttribute(
        'data-variant',
        'outline',
      )
    })

    it('initial=30 (非 preset) で全 button が outline', () => {
      render(<SessionLimitForm initial={30} />)
      expect(screen.getByRole('button', { name: '10' })).toHaveAttribute(
        'data-variant',
        'outline',
      )
      expect(screen.getByRole('button', { name: '20' })).toHaveAttribute(
        'data-variant',
        'outline',
      )
      expect(screen.getByRole('button', { name: '50' })).toHaveAttribute(
        'data-variant',
        'outline',
      )
    })
  })

  describe('preset button click', () => {
    it('10 button click → input value=10、 10 active / 20 outline', () => {
      render(<SessionLimitForm initial={20} />)
      fireEvent.click(screen.getByRole('button', { name: '10' }))
      expect(screen.getByRole('spinbutton')).toHaveValue(10)
      expect(screen.getByRole('button', { name: '10' })).toHaveAttribute(
        'data-variant',
        'default',
      )
      expect(screen.getByRole('button', { name: '20' })).toHaveAttribute(
        'data-variant',
        'outline',
      )
    })

    it('50 button click → input value=50、 50 active', () => {
      render(<SessionLimitForm initial={20} />)
      fireEvent.click(screen.getByRole('button', { name: '50' }))
      expect(screen.getByRole('spinbutton')).toHaveValue(50)
      expect(screen.getByRole('button', { name: '50' })).toHaveAttribute(
        'data-variant',
        'default',
      )
    })
  })

  describe('input 変更で preset selection 解除', () => {
    it('input に 15 を入力 → 全 preset button が outline', () => {
      render(<SessionLimitForm initial={20} />)
      // 20 が active な状態から
      expect(screen.getByRole('button', { name: '20' })).toHaveAttribute(
        'data-variant',
        'default',
      )
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '15' } })
      expect(screen.getByRole('button', { name: '10' })).toHaveAttribute(
        'data-variant',
        'outline',
      )
      expect(screen.getByRole('button', { name: '20' })).toHaveAttribute(
        'data-variant',
        'outline',
      )
      expect(screen.getByRole('button', { name: '50' })).toHaveAttribute(
        'data-variant',
        'outline',
      )
    })

    it('input に 10 を入力 → 10 button が active になる', () => {
      render(<SessionLimitForm initial={20} />)
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '10' } })
      expect(screen.getByRole('button', { name: '10' })).toHaveAttribute(
        'data-variant',
        'default',
      )
    })
  })

  describe('保存 button click → saveSessionLimit 呼び出し', () => {
    it('保存 click → saveSessionLimit が現在の value で呼ばれる', async () => {
      render(<SessionLimitForm initial={20} />)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => {
        expect(mockSaveSessionLimit).toHaveBeenCalledWith(20)
      })
    })

    it('preset 10 click → 保存 click → saveSessionLimit(10) 呼び出し', async () => {
      render(<SessionLimitForm initial={20} />)
      fireEvent.click(screen.getByRole('button', { name: '10' }))
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => {
        expect(mockSaveSessionLimit).toHaveBeenCalledWith(10)
      })
    })

    it('input に 75 入力 → 保存 click → saveSessionLimit(75) 呼び出し', async () => {
      render(<SessionLimitForm initial={20} />)
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '75' } })
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => {
        expect(mockSaveSessionLimit).toHaveBeenCalledWith(75)
      })
    })
  })

  describe('成功 message', () => {
    it('saveSessionLimit ok:true → 「保存しました」 (role=status, 緑クラス) 表示', async () => {
      render(<SessionLimitForm initial={20} />)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      const msg = await screen.findByRole('status')
      expect(msg).toHaveTextContent('保存しました')
      expect(msg.className).toMatch(/emerald|green/)
    })
  })

  describe('失敗 message', () => {
    it('saveSessionLimit ok:false → error text が role=alert で表示', async () => {
      mockSaveSessionLimit.mockResolvedValue({ ok: false, error: '1〜200 で指定してください' })
      render(<SessionLimitForm initial={20} />)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      const msg = await screen.findByRole('alert')
      expect(msg).toHaveTextContent('1〜200 で指定してください')
      expect(msg.className).toMatch(/red/)
    })
  })

  describe('次操作で message リセット', () => {
    it('成功 message 表示後に preset button click → message 消える', async () => {
      render(<SessionLimitForm initial={20} />)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await screen.findByRole('status')
      // preset button click で message を消す
      fireEvent.click(screen.getByRole('button', { name: '10' }))
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })

    it('成功 message 表示後に input 変更 → message 消える', async () => {
      render(<SessionLimitForm initial={20} />)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await screen.findByRole('status')
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } })
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
  })
})
