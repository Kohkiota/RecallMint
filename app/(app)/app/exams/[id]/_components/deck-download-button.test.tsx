// @vitest-environment jsdom
// DeckDownloadButton unit (画像フェーズ A Task 12 / spec §6・§7)。
//
// モック方針:
// - `@/lib/media/deck-download` (downloadDeckImages) を spy mock (実 DL は本 test の
//   対象外、 button の配線・progress・警告表示のみ検証)。
// - `../_actions/asset-actions` は 'use server' + R2 env fail-fast を経由するため必ず
//   mock する (未 mock だと module load 時に throw)。 real resolveAssetUrls が DI 引数
//   として渡ることは mock 関数の同一性で確認する。
// - `@/components/pwa/install-prompt` (InstallPrompt) は matchMedia 依存ゆえ stub 化
//   (button 自体の検証に集中する)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const { mockDownloadDeckImages, mockResolveAssetUrls } = vi.hoisted(() => ({
  mockDownloadDeckImages: vi.fn(),
  mockResolveAssetUrls: vi.fn(),
}))

vi.mock('@/lib/media/deck-download', () => ({
  downloadDeckImages: mockDownloadDeckImages,
}))

vi.mock('../_actions/asset-actions', () => ({
  resolveAssetUrls: mockResolveAssetUrls,
}))

vi.mock('@/components/pwa/install-prompt', () => ({
  InstallPrompt: () => null,
}))

import { DeckDownloadButton } from './deck-download-button'

const USER_ID = 'user-1'
const EXAM_ID = 'exam-1'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('DeckDownloadButton', () => {
  it('click で downloadDeckImages を real resolveAssetUrls dep 付きで呼ぶ', async () => {
    mockDownloadDeckImages.mockResolvedValue({ ok: true, total: 2, downloaded: 2 })
    render(<DeckDownloadButton userId={USER_ID} examId={EXAM_ID} />)

    fireEvent.click(screen.getByRole('button', { name: '画像をオフライン保存' }))

    await waitFor(() => expect(mockDownloadDeckImages).toHaveBeenCalledTimes(1))
    const call = mockDownloadDeckImages.mock.calls[0]
    expect(call[0]).toBe(USER_ID)
    expect(call[1]).toBe(EXAM_ID)
    // 実 action (mockResolveAssetUrls) が deps.resolveAssetUrls として渡る。
    expect(call[2].resolveAssetUrls).toBe(mockResolveAssetUrls)
    // onProgress callback が渡る。
    expect(typeof call[3].onProgress).toBe('function')
  })

  it('実行中は進捗 (done/total) と「完了までタブを閉じないでください」を表示する', async () => {
    // resolve を外部から制御し、 進捗更新後 running のままの状態を確定観測する。
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    mockDownloadDeckImages.mockImplementation(
      async (_u, _e, _deps, opts: { onProgress?: (d: number, t: number) => void }) => {
        opts.onProgress?.(1, 3)
        await gate
        return { ok: true, total: 3, downloaded: 3 }
      },
    )
    render(<DeckDownloadButton userId={USER_ID} examId={EXAM_ID} />)

    fireEvent.click(screen.getByRole('button', { name: '画像をオフライン保存' }))

    // running のまま: 警告文言 + 進捗 (1/3) が出る。
    await waitFor(() =>
      expect(screen.getByText('完了までタブを閉じないでください')).toBeInTheDocument(),
    )
    expect(screen.getByText('1/3')).toBeInTheDocument()

    // 完了させると警告は消える。
    release()
    await waitFor(() =>
      expect(screen.queryByText('完了までタブを閉じないでください')).toBeNull(),
    )
  })

  it('成功で保存メッセージ、 警告は消える', async () => {
    mockDownloadDeckImages.mockResolvedValue({ ok: true, total: 3, downloaded: 3 })
    render(<DeckDownloadButton userId={USER_ID} examId={EXAM_ID} />)

    fireEvent.click(screen.getByRole('button', { name: '画像をオフライン保存' }))

    await waitFor(() =>
      expect(screen.getByText(/3 枚の画像をオフライン用に保存しました/)).toBeInTheDocument(),
    )
    expect(screen.queryByText('完了までタブを閉じないでください')).toBeNull()
  })

  it('失敗で失敗メッセージを表示する', async () => {
    mockDownloadDeckImages.mockResolvedValue({ ok: false, total: 0, downloaded: 0 })
    render(<DeckDownloadButton userId={USER_ID} examId={EXAM_ID} />)

    fireEvent.click(screen.getByRole('button', { name: '画像をオフライン保存' }))

    await waitFor(() =>
      expect(screen.getByText(/画像の保存に失敗しました/)).toBeInTheDocument(),
    )
  })

  it('lock busy (別タブで同デッキを DL 中) は失敗でなく案内メッセージを表示する', async () => {
    mockDownloadDeckImages.mockResolvedValue({
      ok: false,
      total: 0,
      downloaded: 0,
      reason: 'busy',
    })
    render(<DeckDownloadButton userId={USER_ID} examId={EXAM_ID} />)

    fireEvent.click(screen.getByRole('button', { name: '画像をオフライン保存' }))

    await waitFor(() =>
      expect(
        screen.getByText(/別のタブでこのデッキの画像を保存中です/),
      ).toBeInTheDocument(),
    )
    // 「失敗・再試行」メッセージは出さない (busy は失敗ではない)。
    expect(screen.queryByText(/画像の保存に失敗しました/)).toBeNull()
  })
})
