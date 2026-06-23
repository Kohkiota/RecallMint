// @vitest-environment jsdom
// SessionLimitForm client component の test。
// onSaveAction を mock prop として渡す (module mock 不要)。
// preset button / input / 上限なし toggle / 保存 button / message を検証。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { ActionResult } from '@/lib/actions/result'

import { SessionLimitForm } from './session-limit-form'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeOnSave(result: ActionResult<void> = { ok: true }) {
  return vi.fn().mockResolvedValue(result)
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('SessionLimitForm', () => {
  describe('初期描画 (数値)', () => {
    it('initial=20 で input value=20、 20 button が active (variant=default)', () => {
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
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
      render(<SessionLimitForm initial={10} onSaveAction={makeOnSave()} />)
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
      render(<SessionLimitForm initial={30} onSaveAction={makeOnSave()} />)
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

    it('label が指定された場合は表示される', () => {
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} label="スマート復習" />)
      expect(screen.getByText('スマート復習')).toBeInTheDocument()
    })
  })

  describe('初期描画 (null = 上限なし)', () => {
    it('initial=null で 上限なし checkbox が checked、 input と preset が disabled', () => {
      render(<SessionLimitForm initial={null} onSaveAction={makeOnSave()} />)
      const checkbox = screen.getByRole('checkbox', { name: '上限なし' })
      expect(checkbox).toBeChecked()
      expect(screen.getByRole('spinbutton')).toBeDisabled()
      expect(screen.getByRole('button', { name: '10' })).toBeDisabled()
      expect(screen.getByRole('button', { name: '20' })).toBeDisabled()
      expect(screen.getByRole('button', { name: '50' })).toBeDisabled()
    })
  })

  describe('上限なし toggle', () => {
    it('上限なし checkbox ON → input と preset が disabled になる', () => {
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
      const checkbox = screen.getByRole('checkbox', { name: '上限なし' })
      expect(checkbox).not.toBeChecked()
      fireEvent.click(checkbox)
      expect(checkbox).toBeChecked()
      expect(screen.getByRole('spinbutton')).toBeDisabled()
      expect(screen.getByRole('button', { name: '10' })).toBeDisabled()
    })

    it('上限なし ON → 保存 click → onSaveAction(null) が呼ばれる', async () => {
      const onSaveAction = makeOnSave()
      render(<SessionLimitForm initial={20} onSaveAction={onSaveAction} />)
      fireEvent.click(screen.getByRole('checkbox', { name: '上限なし' }))
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => {
        expect(onSaveAction).toHaveBeenCalledWith(null)
      })
    })

    it('initial=null → 保存 click → onSaveAction(null) が呼ばれる', async () => {
      const onSaveAction = makeOnSave()
      render(<SessionLimitForm initial={null} onSaveAction={onSaveAction} />)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => {
        expect(onSaveAction).toHaveBeenCalledWith(null)
      })
    })

    it('上限なし ON → 成功後に「保存しました」が表示される', async () => {
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
      fireEvent.click(screen.getByRole('checkbox', { name: '上限なし' }))
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      const msg = await screen.findByRole('status')
      expect(msg).toHaveTextContent('保存しました')
    })

    it('上限なし ON → 保存 → toggle OFF → message が消える', async () => {
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
      const checkbox = screen.getByRole('checkbox', { name: '上限なし' })
      fireEvent.click(checkbox)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await screen.findByRole('status')
      // toggle を OFF に戻す → value が変化して message guard が消す
      fireEvent.click(checkbox)
      await waitFor(() => {
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
      })
    })
  })

  describe('preset button click', () => {
    it('10 button click → input value=10、 10 active / 20 outline', () => {
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
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
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
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
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
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
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '10' } })
      expect(screen.getByRole('button', { name: '10' })).toHaveAttribute(
        'data-variant',
        'default',
      )
    })
  })

  describe('保存 button click → onSaveAction 呼び出し (数値)', () => {
    it('保存 click → onSaveAction が現在の value で呼ばれる', async () => {
      const onSaveAction = makeOnSave()
      render(<SessionLimitForm initial={20} onSaveAction={onSaveAction} />)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => {
        expect(onSaveAction).toHaveBeenCalledWith(20)
      })
    })

    it('preset 10 click → 保存 click → onSaveAction(10) 呼び出し', async () => {
      const onSaveAction = makeOnSave()
      render(<SessionLimitForm initial={20} onSaveAction={onSaveAction} />)
      fireEvent.click(screen.getByRole('button', { name: '10' }))
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => {
        expect(onSaveAction).toHaveBeenCalledWith(10)
      })
    })

    it('input に 75 入力 → 保存 click → onSaveAction(75) 呼び出し', async () => {
      const onSaveAction = makeOnSave()
      render(<SessionLimitForm initial={20} onSaveAction={onSaveAction} />)
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '75' } })
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => {
        expect(onSaveAction).toHaveBeenCalledWith(75)
      })
    })
  })

  describe('成功 message', () => {
    it('onSaveAction ok:true → 「保存しました」 (role=status, 緑クラス) 表示', async () => {
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      const msg = await screen.findByRole('status')
      expect(msg).toHaveTextContent('保存しました')
      expect(msg.className).toMatch(/emerald|green/)
    })
  })

  describe('失敗 message', () => {
    it('onSaveAction ok:false → error text が role=alert で表示', async () => {
      const onSaveAction = makeOnSave({ ok: false, error: '1〜200 で指定してください' })
      render(<SessionLimitForm initial={20} onSaveAction={onSaveAction} />)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      const msg = await screen.findByRole('alert')
      expect(msg).toHaveTextContent('1〜200 で指定してください')
      expect(msg.className).toMatch(/red/)
    })
  })

  describe('B1 fix: 先頭ゼロ strip', () => {
    it('value="030" を change で渡すと先頭ゼロが strip され "30" になる', () => {
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
      const input = screen.getByRole('spinbutton')
      fireEvent.change(input, { target: { value: '030' } })
      expect(input).toHaveValue(30)
      // (input value が "30" として表示される: HTML spinbutton は number 解釈で 30 を表示)
    })

    it('空文字 "" は維持される (ユーザーが全消ししたとき edit を許容)', () => {
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
      const input = screen.getByRole('spinbutton')
      fireEvent.change(input, { target: { value: '' } })
      // 空のときは value=null/"" (HTML spinbutton)
      expect((input as HTMLInputElement).value).toBe('')
    })

    it('単一 "0" は維持される (1 桁の 0 は temporal に許可、 保存時に action が弾く)', () => {
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
      const input = screen.getByRole('spinbutton')
      fireEvent.change(input, { target: { value: '0' } })
      expect((input as HTMLInputElement).value).toBe('0')
    })

    it('"007" → "7" にストリップ (複数桁前ゼロ)', () => {
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
      const input = screen.getByRole('spinbutton')
      fireEvent.change(input, { target: { value: '007' } })
      expect(input).toHaveValue(7)
    })
  })

  describe('次操作で message リセット', () => {
    it('成功 message 表示後に preset button click → message 消える', async () => {
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await screen.findByRole('status')
      // transition が完全に idle (pending=false → input re-enable) になるまで待ってから
      // preset click。 status 表示直後はまだ pending true な commit が残る微 race を回避。
      await waitFor(() => {
        expect(screen.getByRole('spinbutton')).not.toBeDisabled()
      })
      fireEvent.click(screen.getByRole('button', { name: '10' }))
      await waitFor(() => {
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
      })
    })

    it('成功 message 表示後に input 変更 → message 消える', async () => {
      render(<SessionLimitForm initial={20} onSaveAction={makeOnSave()} />)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await screen.findByRole('status')
      // transition idle 待ち (上同様、 React 19 transition pending settle 保証)
      await waitFor(() => {
        expect(screen.getByRole('spinbutton')).not.toBeDisabled()
      })
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } })
      await waitFor(() => {
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
      })
    })
  })
})
